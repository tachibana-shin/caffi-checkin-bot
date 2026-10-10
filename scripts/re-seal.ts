/**
 * Re-seal the store so the Worker can open it.
 *
 * The record Deno Deploy wrote was sealed with 150,000 PBKDF2 rounds, which a
 * full Deno runtime pays without noticing and a Cloudflare Worker cannot:
 * workerd refuses that derivation inside a 10ms CPU budget, so `unseal` fails
 * and the store reads as empty. The envelope carries its own round count, so
 * this decrypts with the old cost and writes the same data back with the cheap
 * one — no data migration, just a re-seal.
 *
 * Usage:
 *   deno run -A --env-file=.env scripts/re-seal.ts <sealed.json> <reseed.sql>
 *
 * <sealed.json> is the KV-shaped dump (a list of {key, value}) holding the
 * `caffi/store` record. Then:
 *   bunx wrangler d1 execute caffi --remote --file <reseed.sql>
 */
import { seal, unseal } from "../src/crypto.ts";
import { config } from "../src/config.ts";
import type { StoreData } from "../src/types.ts";

const [dump, out] = Deno.args;
if (!dump || !out) {
  console.error("usage: re-seal.ts <sealed.json> <reseed.sql>");
  Deno.exit(1);
}

const rows: Array<{ key: string[]; value: unknown }> = JSON.parse(await Deno.readTextFile(dump));
const row = rows.find((r) => r.key.join("/") === "caffi/store");
if (!row) throw new Error("no caffi/store record in the dump");

// The record is the KV-shaped `{"payload": "..."}`; the payload is the sealed string.
const raw = typeof row.value === "string" ? row.value : JSON.stringify(row.value);
const wrapper = JSON.parse(raw) as { payload?: string };
const sealed = wrapper.payload ?? raw;
const opened = await unseal<StoreData>(sealed, config.secret);
if (!opened) throw new Error("could not open the record with BOT_SECRET");
const chats = Object.keys(opened.chats);
const accounts = Object.values(opened.chats).flatMap((c) => Object.keys(c.accounts));

const resealed = await seal(opened, config.secret);
// The store record is the KV-shaped string `{"payload": ...}`, not the bare payload.
const record = JSON.stringify({ payload: resealed }, null, 2);

console.log(`🔓 ${chats.length} chat(s), ${accounts.length} account(s)`);
console.log(`🔐 re-sealed with ${config.kdfIterations} rounds (was 150000)`);
if (config.kdfIterations > 100_000) {
  console.warn("⚠️  that is still too many for a Worker to derive — expect an empty store");
}

await Deno.writeTextFile(
  out,
  // D1's column holds the *JSON encoding* of the value — a string, so it is written
  // quoted and escaped, exactly like the KV-shaped record it replaces.
  `UPDATE records SET value = '${
    JSON.stringify(record).replaceAll("'", "''")
  }' WHERE key = 'caffi store';\n`,
);
console.log(`🌱 ${out}`);
