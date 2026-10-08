/**
 * Dump every `["caffi", ...]` key from the production Deno KV database to a
 * local JSON file — the safety net before replacing the Deploy app.
 *
 * Usage:
 *   DENO_KV_ACCESS_TOKEN=<org token> deno run -A scripts/kv-backup.ts <db-id> <out.json>
 */
const [dbId, out] = Deno.args;
if (!dbId || !out) {
  console.error("usage: kv-backup.ts <database-id> <out.json>");
  Deno.exit(1);
}

const kv = await Deno.openKv(`https://api.deno.com/v2/databases/${dbId}/connect`);

const rows: Array<{ key: string[]; value: unknown }> = [];
for await (const entry of kv.list({ prefix: ["caffi"] })) {
  rows.push({ key: entry.key as string[], value: entry.value });
}
await kv.close();

await Deno.writeTextFile(out, JSON.stringify(rows, null, 2));
console.log(`💾 ${rows.length} key(s) -> ${out}`);
for (const r of rows) console.log("  -", r.key.join("/"));
