/**
 * Encrypts the store (user passwords + JWTs) with AES-256-GCM.
 * The key is derived from BOT_SECRET via PBKDF2-SHA256.
 *
 * The round count travels in the envelope, because the right number is a
 * property of the host, not of the data: 150k iterations costs ~1s of CPU,
 * which a full Deno runtime never notices and a Cloudflare Worker's free plan
 * (10ms of CPU per invocation) cannot survive at all — it would fail every
 * request that opens the store. New records are written with `KDF_ITERATIONS`
 * (1000 by default, ~3ms), and a record that says otherwise still opens with
 * the cost it was sealed with, so an old store keeps working untouched until
 * the next flush re-seals it.
 */
import { config } from "./config.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode("caffi-checkin-bot/v1");
/** Records written before the count was tracked — the original cost. */
const LEGACY_ITERATIONS = 150_000;

interface Envelope {
  /** PBKDF2 rounds this record was sealed with. */
  k?: number;
}

const keys = new Map<number, CryptoKey>();

async function deriveKey(secret: string, iterations: number): Promise<CryptoKey> {
  const cached = keys.get(iterations);
  if (cached) return cached;
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  keys.set(iterations, key);
  return key;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The payload part of an envelope, without the leading `iv:`. */
function parse(
  sealed: string,
): { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer>; iterations: number } | undefined {
  const [ivPart, ctPart, metaPart] = sealed.split(":");
  if (!ivPart || !ctPart) return undefined;
  let iterations = LEGACY_ITERATIONS;
  if (metaPart) {
    try {
      const meta = JSON.parse(dec.decode(fromBase64(metaPart))) as Envelope;
      if (typeof meta.k === "number" && meta.k > 0) iterations = meta.k;
    } catch {
      // An unreadable tag keeps the legacy cost, which is always safe.
    }
  }
  return { iv: fromBase64(ivPart), ct: fromBase64(ctPart), iterations };
}

/** Returns the string "iv:payload[:meta]" (all base64). */
export async function seal(value: unknown, secret: string): Promise<string> {
  const iterations = config.kdfIterations;
  const key = await deriveKey(secret, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(value)),
  );
  const meta = iterations === LEGACY_ITERATIONS
    ? ""
    // Tag the cost only when it differs, so the old format stays valid.
    : `:${toBase64(enc.encode(JSON.stringify({ k: iterations })))}`;
  return `${toBase64(iv)}:${toBase64(new Uint8Array(ct))}${meta}`;
}

/** Returns undefined when decryption fails (wrong key / corrupted data). */
export async function unseal<T>(payload: string, secret: string): Promise<T | undefined> {
  try {
    const parsed = parse(payload);
    if (!parsed) return undefined;
    const key = await deriveKey(secret, parsed.iterations);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: parsed.iv },
      key,
      parsed.ct,
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return undefined;
  }
}
