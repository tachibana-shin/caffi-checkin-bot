/**
 * Offline contract test for the Shopee client — no request leaves the process.
 *
 * The two endpoints were reverse engineered out of the production bundle
 * (`dailycheckin/pcmall-dailycheckin.*.js`), so what has to be pinned down is
 * (a) that our requests keep the exact shape the site sends — host, path, the
 * two hand-set headers, the cookie — and (b) that the snake_case responses are
 * read back into the right outcomes. `globalThis.fetch` is stubbed below with
 * bodies copied from production.
 *
 *   deno task shopee
 */
Deno.env.set("TELEGRAM_BOT_TOKEN", "shopee-test-token");
Deno.env.set("BOT_SECRET", "shopee-secret");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-shopee");

const { shopeeCheckin, shopeeSettings, shopeeStatusCard, runShopeeCheckIn } = await import(
  "../src/shopee.ts"
);
const { store } = await import("../src/store.ts");
type ShopeeAccount = import("../src/types.ts").ShopeeAccount;

await store.load();
for (const key of Object.keys(store.data.chats)) delete store.data.chats[key];

// ── fetch stub ────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
const calls: Call[] = [];
let responder: (call: Call) => Response = () => json({ code: 0, msg: "success", data: {} });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const call: Call = {
    url,
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : undefined,
  };
  calls.push(call);
  // Real fetch only ever rejects, it never throws synchronously.
  try {
    return Promise.resolve(responder(call));
  } catch (e) {
    return Promise.reject(e);
  }
}) as typeof fetch;

const BASE = "https://games-dailycheckin.shopee.vn/mkt/coins/api/v2/";
const COOKIE = "SPC_F=abc; SPC_ST=token; SPC_EC=ec";

/** The body production returns, copied verbatim (07-10-2026). */
function settingsBody(over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) {
  return {
    code: 0,
    msg: "success",
    data: {
      "@timestamp": "2026-10-07T13:18:35+08:00",
      activity_id: 100510,
      checked_in_today: false,
      checked_in_today_amount: 100,
      checkin_list: [100, 100, 100, 100, 100, 100, 100, 100],
      checkin_reward_list: [100, 100, 100, 100, 100, 100, 200, 100].map((val) => ({
        type: 0,
        val,
      })),
      fraud_detected: false,
      login: true,
      today_index: 1,
      userid: "778899",
      ...dataOver,
    },
    ...over,
  };
}

function checkinBody(over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) {
  return {
    code: 0,
    msg: "success",
    data: {
      success: true,
      increase_coins: 100,
      today_index: 1,
      reward_type: 0,
      checkin_list: [100, 100, 100, 100, 100, 100, 100, 100],
      ...dataOver,
    },
    ...over,
  };
}

function account(over: Partial<ShopeeAccount> = {}): ShopeeAccount {
  return {
    name: "shopee-main",
    cookie: COOKIE,
    autoCheckIn: true,
    sessionInvalid: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};
const reset = () => (calls.length = 0);

// ── 1. The requests we send are the ones the site sends ───────────────────
{
  reset();
  responder = () => json(settingsBody());
  await shopeeSettings(COOKIE);

  const c = calls[0];
  check("GET settings hits games-dailycheckin.shopee.vn", c?.url === BASE + "settings", c?.url);
  check("…with GET", c?.method === "GET", c?.method);
  check("dci-version: 4008000", c?.headers["dci-version"] === "4008000");
  check("check-in-origin: pc", c?.headers["check-in-origin"] === "pc");
  check("cookie passed through", c?.headers["cookie"] === COOKIE);
  check(
    "referer points at the coins page",
    (c?.headers["referer"] ?? "").includes("shopee.vn"),
    c?.headers["referer"],
  );

  reset();
  responder = () => json(checkinBody());
  await shopeeCheckin(COOKIE);
  const p = calls[0];
  check("POST checkin_new hits …/checkin_new", p?.url === BASE + "checkin_new", p?.url);
  check("…with POST", p?.method === "POST", p?.method);
  check("…and application/json", (p?.headers["content-type"] ?? "").includes("application/json"));
  check(
    "body is the (fingerprint-free) object the page falls back to",
    p?.body === "{}",
    String(p?.body),
  );
}

// ── 2. Reading the response ───────────────────────────────────────────────
{
  reset();
  responder = () => json(settingsBody());
  const s = await shopeeSettings(COOKIE);
  check("settings code 0", s.code === 0);
  check("settings stays snake_case", s.data?.checked_in_today === false);
  check("userid is read", s.data?.userid === "778899");
}

// ── 3. The runner ─────────────────────────────────────────────────────────
{
  // Fresh day: settings says not yet, POST credits us.
  reset();
  responder = (call) =>
    call.url.endsWith("checkin_new") ? json(checkinBody()) : json(settingsBody());
  const a = account();
  const r1 = await runShopeeCheckIn(a);
  check("not checked in -> checked_in", r1.outcome === "checked_in", r1.outcome);
  check("card says so", r1.card.title === "Đã điểm danh Shopee", r1.card.title);
  check("coins shown", JSON.stringify(r1.card.stats ?? []).includes("+100 Xu"));
  check("lastCheckInDay recorded", typeof a.lastCheckInDay === "string" && a.lastCheckInDay > "");
  check("two requests: settings then checkin", calls.length === 2, String(calls.length));

  // Second run the same day: no request at all.
  reset();
  const r2 = await runShopeeCheckIn(a);
  check("already credited today -> already_done", r2.outcome === "already_done", r2.outcome);
  check("…without any network call", calls.length === 0, String(calls.length));

  // Server already counts today (user checked in the app, or day unrolled).
  reset();
  responder = () => json(settingsBody({}, { checked_in_today: true }));
  const b = account({ lastCheckInDay: undefined });
  const r3 = await runShopeeCheckIn(b);
  check("server says covered -> already_done", r3.outcome === "already_done", r3.outcome);
  check("…and does not POST", calls.length === 1, String(calls.length));
  check("userid picked up from settings", b.userid === "778899");
}

// ── 4. Auth ───────────────────────────────────────────────────────────────
{
  reset();
  responder = () => json({ code: 401, msg: "Unauthorization with sso" }, 401);
  const a = account();
  const r = await runShopeeCheckIn(a);
  check("401 -> session_expired", r.outcome === "session_expired", r.outcome);
  check("account marked invalid", a.sessionInvalid === true);
  check(
    "card tells the user how to fix it",
    r.card.blocks?.some((b) => b.text.includes("shopee-login")) === true,
  );
  check("…and stops after the first request", calls.length === 1, String(calls.length));

  // The other shape: HTTP 200 with `is_login:false`.
  reset();
  responder = () => json({ is_login: false, error: 90309999 });
  const b = account();
  const r2 = await runShopeeCheckIn(b);
  check("is_login:false -> session_expired", r2.outcome === "session_expired", r2.outcome);
  check("…too", b.sessionInvalid === true);
}

// ── 5. "Already" behind a non-zero code ───────────────────────────────────
{
  reset();
  // The day rolls over between the POST and the re-read: the first settings
  // says the day is open, the POST answers "already", the second settings
  // confirms it is now covered.
  let settingsCalls = 0;
  responder = (call) => {
    if (call.url.endsWith("checkin_new")) {
      return json({ code: 500_111, msg: "already checkin today" });
    }
    settingsCalls++;
    return json(settingsBody({}, { checked_in_today: settingsCalls > 1 }));
  };
  const r = await runShopeeCheckIn(account());
  check(
    "non-zero code + checked_in_today -> already_done",
    r.outcome === "already_done",
    r.outcome,
  );
  check("…after re-reading settings", calls.length === 3, String(calls.length));

  // Non-zero code and the day is genuinely not covered: a real failure.
  reset();
  responder = (call) =>
    call.url.endsWith("checkin_new")
      ? json({ code: 500_999, msg: "system busy" })
      : json(settingsBody());
  const r2 = await runShopeeCheckIn(account());
  check("non-zero code, still open -> failed", r2.outcome === "failed", r2.outcome);
  check("…and the code reaches the card", JSON.stringify(r2.card).includes("500999"));
}

// ── 6. Network trouble ────────────────────────────────────────────────────
{
  reset();
  responder = () => {
    throw new TypeError("error sending request");
  };
  const r = await runShopeeCheckIn(account());
  check("fetch throwing -> failed, not a crash", r.outcome === "failed", r.outcome);
}

// ── 7. The status screen ──────────────────────────────────────────────────
{
  reset();
  responder = () => json(settingsBody({}, { checked_in_today: true, today_index: 4 }));
  const a = account();
  const card = await shopeeStatusCard(a);
  check("status card title", card.title === "Shopee Xu — điểm danh", card.title);
  check(
    "…reads checked-in today",
    card.stats?.some((s) => s.value.includes("Đã điểm danh")) === true,
  );
  check("…and the day of the streak", card.stats?.some((s) => s.label === "Ngày") === true);
  check(
    "status is GET only",
    calls.every((c) => c.method === "GET"),
    calls.map((c) => c.method).join(","),
  );
  check("status does not clear a good session", a.sessionInvalid === false);

  reset();
  responder = () => json({ code: 401, msg: "Unauthorization with sso" }, 401);
  const b = account();
  const bad = await shopeeStatusCard(b);
  check(
    "status with a dead cookie -> the expired card",
    bad.tone === "error" && b.sessionInvalid === true,
  );
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll OK");
Deno.exit(failed ? 1 : 0);
