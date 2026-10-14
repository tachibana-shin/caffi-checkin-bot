/**
 * Read-only audit of a D1 store dump: what the server actually recorded.
 *
 * The check-in time a card shows comes from `history[0].createdAt` — the UTC
 * instant Caffi wrote the row — and nothing else, so this is the ground truth
 * for "was the race won": it never depends on which trigger happened to reach
 * the API first. It also reads `todayCheckInPosition`, which is the ranking
 * the whole schedule exists for.
 *
 * Nothing here writes: the store is only opened, and `getCheckInStatus` is a
 * GET.
 *
 * Usage:
 *   bunx wrangler d1 execute caffi --remote \
 *     --command "SELECT key, value FROM records WHERE key = 'caffi store';" \
 *     --json > /tmp/store.json
 *   deno run -A --env-file=.env scripts/inspect.ts /tmp/store.json
 */
import { unseal } from "../src/crypto.ts";
import { config } from "../src/config.ts";
import { apiFor } from "../src/checkin.ts";
import type { StoreData } from "../src/types.ts";

const dump = Deno.args[0];
if (!dump) {
  console.error("usage: inspect.ts <store-dump.json>");
  Deno.exit(1);
}

// wrangler wraps the payload as `[{"results": [...]}]`; accept a bare list too.
const parsed = JSON.parse(await Deno.readTextFile(dump));
const rows: Array<{ key?: string; value?: string }> = Array.isArray(parsed)
  ? parsed.flatMap((r) => (Array.isArray(r?.results) ? r.results : [r]))
  : parsed?.results ?? [];
const row = rows.find((r) => r.key === "caffi store" || r.key?.endsWith("/store"));
if (!row) throw new Error("no store record in the dump");

const raw = typeof row.value === "string" ? row.value : JSON.stringify(row.value);
// The column holds the KV-shaped `{"payload": "..."}` — but as the *JSON
// encoding* of that string, so it takes two parses to reach the sealed value.
let opened: unknown = JSON.parse(raw);
while (typeof opened === "string") opened = JSON.parse(opened);
const payload = (opened as { payload?: string }).payload ?? raw;
const store = await unseal<StoreData>(payload, config.secret);
if (!store) throw new Error("could not open the record with BOT_SECRET");

/** `2026-10-14T00:01:07.000Z` -> `00:01:07 14/10 VN` */
function vn(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "-";
  const d = new Date(t + 7 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${
    p(d.getUTCDate())
  }/${p(d.getUTCMonth() + 1)}`;
}

console.log(
  `store: lastAutoRunDate=${store.lastAutoRunDate ?? "-"} ` +
    `lastAutoRunDoneDate=${store.lastAutoRunDoneDate ?? "-"}`,
);

// `autoAccounts()` lives on the Store class, which needs a D1 binding — the
// dump only holds the plain data, so the filter is repeated here.
const targets = Object.entries(store.chats).flatMap(([chatId, chat]) =>
  Object.values(chat.accounts)
    .filter((a) => a.autoCheckIn && !a.sessionInvalid)
    .map((account) => ({ chatId, account }))
);
if (!targets.length) console.log("no auto-enabled account with a live session in the dump");

for (const { chatId, account } of targets) {
  const name = account.displayName || account.username || "?";
  const status = await apiFor(account).getCheckInStatus().catch((e) => {
    console.error(`  ${name}: status read failed:`, e);
    return null;
  });
  console.log(
    `${name} [${chatId}]: checkedIn=${status?.todayCheckedIn ?? "?"} ` +
      `position=${status?.todayCheckInPosition ?? "-"} ` +
      `streak=${status?.currentStreak ?? "-"}`,
  );
  console.log(
    `  bot state: lastCheckInDay=${account.lastCheckInDay ?? "-"} ` +
      `result=${account.lastCheckInResult ?? "-"} sessionInvalid=${account.sessionInvalid}` +
      ` nextCheckInDay=${status?.nextCheckInDay ?? "-"}`,
  );
  const seen = (status?.history ?? []).slice(0, 5).map((h) =>
    `${h.checkInDate ?? "?"} @ ${vn(h.createdAt)}`
  );
  console.log(`  newest rows: ${seen.join(" · ") || "-"}`);
}
