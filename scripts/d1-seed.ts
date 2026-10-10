/**
 * One-shot: copy the live Deno KV records into D1 for the Cloudflare Worker.
 *
 * Usage:
 *   deno run -A scripts/d1-seed.ts <kv-dump.json> <seed.sql>
 *
 * Then:
 *   bunx wrangler d1 execute caffi --remote --file <seed.sql>
 *
 * The records are copied byte for byte — the ciphertext is sealed with the
 * BOT_SECRET that is already in the store, so it lands in D1 exactly as it was
 * and the Worker opens it with the round count recorded inside the envelope.
 * Nothing here decrypts anything.
 */
const [dump, out] = Deno.args;
if (!dump || !out) {
  console.error("usage: d1-seed.ts <kv-dump.json> <seed.sql>");
  Deno.exit(1);
}

interface Row {
  key: string[];
  value: unknown;
}

const rows: Row[] = JSON.parse(await Deno.readTextFile(dump));
if (!rows.length) throw new Error("nothing to seed");

const value = (r: Row) => JSON.stringify(JSON.parse(JSON.stringify(r.value)));
const lines = rows.map((r) => {
  const k = r.key.join(" ").replaceAll("'", "''");
  const v = value(r).replaceAll("'", "''");
  return `INSERT OR REPLACE INTO records (key, value) VALUES ('${k}', '${v}');`;
});

await Deno.writeTextFile(out, lines.join("\n") + "\n");
console.log(`🌱 ${rows.length} record(s) -> ${out}`);
for (const r of rows) console.log("  -", r.key.join("/"));
