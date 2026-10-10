/**
 * Offline proof for the nightly batch: one watcher, simultaneous POSTs.
 *
 * Stubs `fetch` against the Caffi base URL and records when each POST request
 * actually leaves — which is what the `earliest` leaderboard ranks. Covers
 * (1) the race, where the day flips mid-watch and every POST must leave
 * together, (2) a day that was already open (catch-up, restart, re-run), where
 * each account answers for itself and nothing is posted twice, and (3) a dead
 * watcher, where the watch hands over to a live session.
 *
 *   deno task batch
 */
const BASE = "https://client-api.caffiliate.vn";

Deno.env.set("TELEGRAM_BOT_TOKEN", "batch-test-token");
Deno.env.set("BOT_SECRET", "batch-secret");
Deno.env.set("RUNTIME_MODE", "polling");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-batch");

type Mode = "race" | "catch_up";

interface Stub {
  mode: Mode;
  /** Wall-clock ms at which the server opens the day. */
  flipAt: number;
  /** Accounts whose session is dead: every authed call answers 401. */
  dead: Set<string>;
  /** Accounts that already checked in today (only meaningful in catch_up). */
  alreadyIn: Set<string>;
}

const S: Stub = {
  mode: "race",
  flipAt: 0,
  dead: new Set(),
  alreadyIn: new Set(),
};

const posts: Array<{ user: string; at: number }> = [];
const statusReads: Array<{ user: string; at: number }> = [];
const refreshes: Array<{ token: string; at: number }> = [];
/** Peak number of status reads in flight — proves the watcher pipelines. */
let maxInFlight = 0;
let inFlight = 0;

/** A JWT-shaped access token with the given `exp` (seconds). */
const jwt = (exp: number) =>
  `h.${btoa(JSON.stringify({ exp })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

// The stub is async because a read has to take the round trip it takes on the
// wire; `fetch`'s real signature is what the bot awaits either way.
const stub = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const auth = (init?.headers as Record<string, string>)?.Authorization ??
    (input instanceof Request ? (input.headers.get("Authorization") ?? "") : "");
  const user = auth.replace("Bearer ", "");

  if (!url.startsWith(BASE)) throw new Error(`unexpected host ${url}`);
  const path = url.slice(BASE.length);
  const now = Date.now();

  if (path === "/auth/mobile/refresh" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { refreshToken?: string };
    refreshes.push({ token: String(body.refreshToken), at: now });
    // A dead session cannot be brought back — the client flags it for /login.
    if (S.dead.has(String(body.refreshToken))) {
      return json(401, { error: { code: "REFRESH_TOKEN_INVALID" } });
    }
    const next = jwt(Math.floor((Date.now() + 3_600_000) / 1000));
    return json(200, { data: { accessToken: next, refreshToken: `${body.refreshToken}` } });
  }

  if (path === "/api/v2/xeng/check-in/status") {
    if (S.dead.has(user)) return json(401, { error: { code: "UNAUTHORIZED" } });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // A read takes the round trip it would take on the wire.
    await new Promise((r) => setTimeout(r, 265));
    inFlight--;
    statusReads.push({ user, at: now });
    // What the app sees. Before the server opens the day, "today" is still
    // yesterday and we already checked in for it — that is `pending_day`.
    // Afterwards today has no entry yet, so `todayCheckedIn` is false.
    const open = now >= S.flipAt;
    const already = S.alreadyIn.has(user);
    return json(200, {
      data: {
        todayCheckedIn: open ? already : true,
        currentStreak: already ? 5 : 4,
        todayCheckInPosition: 1,
        history: [{
          checkInDate: open && already ? TODAY : YESTERDAY,
          createdAt: new Date(now - 3_600_000).toISOString(),
        }],
      },
    });
  }

  if (path === "/api/v2/xeng/check-in" && method === "POST") {
    if (S.dead.has(user)) return json(401, { error: { code: "UNAUTHORIZED" } });
    posts.push({ user, at: now });
    return json(200, { data: {} });
  }

  if (path === "/api/v2/xeng/wallet") {
    return json(200, { data: { wallet: { balance: 123_456 } } });
  }

  throw new Error(`unexpected ${method} ${path}`);
};

globalThis.fetch = stub as unknown as typeof fetch;
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const { runCheckInAll } = await import("../src/checkin.ts");

const vn = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

const TODAY = vn(new Date());
const YESTERDAY = vn(new Date(Date.now() - 86_400_000));

function account(username: string) {
  return {
    username,
    password: "pw",
    // The username doubles as both tokens: the stub keys a dead session off the
    // bearer it sees, so marking `a@x.com` dead has to kill auth *and* refresh.
    tokens: { accessToken: username, refreshToken: username },
    autoCheckIn: true,
    sessionInvalid: false,
    createdAt: new Date().toISOString(),
  };
}

function reset() {
  posts.length = 0;
  statusReads.length = 0;
  refreshes.length = 0;
  maxInFlight = 0;
  inFlight = 0;
  S.dead.clear();
  S.alreadyIn.clear();
}

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
}

type BatchRun = Array<{ chatId: string; result: import("../src/checkin.ts").CheckInResult }>;
const outcomeAt = (run: BatchRun, i: number) => run[i]?.result.outcome;

// ── 1. Race: the day flips mid-watch ────────────────────────────────────────
reset();
S.mode = "race";
S.flipAt = Date.now() + 250;
const targets = [
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
];

const t0 = Date.now();
const race = await runCheckInAll(targets, { runDate: TODAY, retryUntil: t0 + 60_000 });
const raceMs = Date.now() - t0;

const sent = posts.map((p) => p.at);
const spread = Math.max(...sent) - Math.min(...sent);
check("both accounts POSTed", posts.length === 2, `${posts.length} POST(s)`);
check(
  "the watcher keeps several reads in flight, not one at a time",
  maxInFlight >= 2,
  `peak ${maxInFlight} in flight`,
);
check(
  "POSTs leave together (< one round trip)",
  spread < 50,
  `${spread}ms apart`,
);
check(
  "the watcher did not poll on behalf of the others",
  statusReads.filter((r) => r.user === "main@x.com").every((r) => r.at >= S.flipAt) &&
    statusReads.filter((r) => r.user === "a@x.com").length > 1,
  `reads: ${statusReads.map((r) => `${r.user.split("@")[0]}+${r.at - t0}`).join(", ")} (flip +${
    S.flipAt - t0
  })`,
);
check("both report checked_in", race.every((r) => r.result.outcome === "checked_in"));
console.log(`   (batch finished in ${raceMs}ms, flip at +${S.flipAt - t0}ms)`);

// ── 2. Catch-up: the day was open before we looked ─────────────────────────
reset();
S.mode = "catch_up";
S.alreadyIn.add("a@x.com"); // this one is already in — must not POST again
const done = await runCheckInAll(
  [{ chatId: "tg:1", account: account("a@x.com") }, {
    chatId: "tg:1",
    account: account("main@x.com"),
  }],
  { runDate: TODAY, retryUntil: Date.now() + 60_000 },
);
check(
  "already-checked-in account does not POST again",
  posts.length === 1,
  `${posts.length} POST(s)`,
);
check(
  "the checked-in account is reported as such",
  outcomeAt(done, 0) === "already_done",
  outcomeAt(done, 0),
);
check("the other one still checks in", outcomeAt(done, 1) === "checked_in");

// ── 3. Dead watcher: the watch hands over ─────────────────────────────────
reset();
S.mode = "race";
S.flipAt = Date.now() + 250;
S.dead.add("a@x.com");
const handed = await runCheckInAll(
  [{ chatId: "tg:1", account: account("a@x.com") }, {
    chatId: "tg:1",
    account: account("main@x.com"),
  }],
  { runDate: TODAY, retryUntil: Date.now() + 60_000 },
);
// The dead session cannot POST either — it must be reported, and the live one
// must not be held back by it.
check("the watch moved to a live session", posts.length === 1, `${posts.length} POST(s)`);
check(
  "the dead session is reported, not silently skipped",
  outcomeAt(handed, 0) === "session_expired",
  outcomeAt(handed, 0),
);
check(
  "the live account still checked in",
  outcomeAt(handed, 1) === "checked_in",
  outcomeAt(handed, 1),
);
const sentHanded = posts.map((p) => p.at);
check("the surviving account raced on its own", sentHanded.length === 1);

// ── 4. Expiring token: refreshed before the race, not during it ────────────
reset();
S.mode = "race";
S.flipAt = Date.now() + 250;
const stale = account("stale@x.com");
// A JWT that expired yesterday: `warm` must replace it up front, so the POST
// does not spend two round trips discovering that.
stale.tokens = {
  accessToken: jwt(Math.floor((Date.now() - 86_400_000) / 1000)),
  refreshToken: "stale@x.com",
};
const warmed = await runCheckInAll(
  [{ chatId: "tg:1", account: stale }, { chatId: "tg:1", account: account("main@x.com") }],
  { runDate: TODAY, retryUntil: Date.now() + 60_000 },
);
const sentWarm = posts.map((p) => p.at);
check(
  "the expiring token was refreshed",
  refreshes.length === 1,
  `${refreshes.length} refresh(es)`,
);
check(
  "the refreshed account uses the new token",
  posts.some((p) => p.user !== "main@x.com") &&
    stale.tokens.accessToken !== jwt(Math.floor((Date.now() - 86_400_000) / 1000)),
);
check(
  "the refresh did not push the POST out of the race",
  posts.length === 2 && Math.max(...sentWarm) - Math.min(...sentWarm) < 50,
  `${posts.length} POST(s), ${Math.max(...sentWarm) - Math.min(...sentWarm)}ms apart`,
);
check("both accounts checked in", warmed.every((r) => r.result.outcome === "checked_in"));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll OK");
Deno.exit(failed ? 1 : 0);
