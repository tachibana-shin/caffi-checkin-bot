/**
 * Encrypts the on-disk store (user passwords + JWTs) with AES-256-GCM.
 * The key is derived from BOT_SECRET via PBKDF2-SHA256 (150k iterations).
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode("caffi-checkin-bot/v1");
const ITERATIONS = 150_000;

let cached: CryptoKey | null = null;

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (cached) return cached;
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, [
    "deriveKey",
  ]);
  cached = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return cached;
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

/** Returns the string "iv:payload" (both base64). */
export async function seal(value: unknown, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return `${toBase64(iv)}:${toBase64(new Uint8Array(ct))}`;
}

/** Returns undefined when decryption fails (wrong key / corrupted data). */
export async function unseal<T>(payload: string, secret: string): Promise<T | undefined> {
  try {
    const [ivPart, ctPart] = payload.split(":");
    if (!ivPart || !ctPart) return undefined;
    const key = await deriveKey(secret);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivPart) },
      key,
      fromBase64(ctPart),
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return undefined;
  }
}
