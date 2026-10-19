/**
 * Offline proof for the nightly batch: aiming a queued check-in job at midnight.
 *
 * Stubs `fetch` against the Caffi base URL and makes the server behave like the
 * real one does now that we know how it works: a POST is queued per account,
 * only one job runs at a time, and the check-in row (its `createdAt`, which is
 * what the `earliest` leaderboard ranks) is written when the job *finishes*.
 * Before midnight the finished job answers 400 "Hôm nay bạn đã điểm danh rồi"
 * (the previous day is still today, and it is done); the first job that finishes
 * after the flip is the check-in, and any job started while one is running is
 * answered 429 CHECK_IN_QUEUE_FULL. Records when each job *finished*.
 *
 * Covers (1) the stopwatch-and-aim race, with the flip landing between shots,
 * (2) a day that was already open (catch-up, restart, re-run), where each
 * account answers for itself and nothing is posted twice, (3) a dead session,
 * which must stand down without holding the other account back, (4) an expiring
 * token, refreshed before the race instead of during it, (5) a flip beyond the
 * aim, which the read-and-post fallback must still book, (6) a rate limit,
 * which must stop that account's race and leave the other alone, (7) a missed
 * yesterday, whose booking by a stopwatch shot must not be mistaken for
 * tonight's win, (8) a status that lies and says the booking is done — the day
 * must be reported unfinished rather than marked done on a 200 that booked an
 * earlier day, and (9) a queue-full answer, which must be retried rather than
 * treated as a failure.
 *
 * The race waits for `midnight - 6s`, and the harness does not: it moves the
 * clock instead — `Date.now()` reports "1.5 seconds before midnight" and keeps
 * ticking, while timers stay real. The stub reads the same clock, so a job that
 * takes 200ms takes 200ms of race time, not of wall time.
 *
 *   deno task batch
 */
const BASE = "https://client-api.caffiliate.vn";

Deno.env.set("TELEGRAM_BOT_TOKEN", "batch-test-token");
Deno.env.set("BOT_SECRET", "batch-secret");
Deno.env.set("RUNTIME_MODE", "polling");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-batch");

const { runCheckInAll, vnMidnightMs } = await import("../src/checkin.ts");

/** The midnight the race aims at. */
const RUN_DATE = "2030-01-01";
const MIDNIGHT = vnMidnightMs(RUN_DATE);
/** The day before it: the "today" the server still counts before the flip. */
const OLD_DAY = "2029-12-31";
/** Where the fake clock parks: close enough that the race runs at once. */
const FAKE_LEAD_MS = 1_500;
/** One status read and one check-in job take this long on the wire. */
const READ_MS = 265;
const JOB_MS = 200;

const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
let offset = 0;
/** Point the clock `leadMs` before `MIDNIGHT`, keeping it ticking. */
const seekTo = (leadMs: number) => {
  offset = MIDNIGHT - leadMs - realNow();
};
/** Point the clock at `FAKE_LEAD_MS` before `MIDNIGHT` — where scenarios start. */
const seek = () => seekTo(FAKE_LEAD_MS);
seek();
Date.now = () => realNow() + offset;
globalThis.Date = class extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length === 0 ? [realNow() + offset] : args) as [number]));
  }
  static override now() {
    return realNow() + offset;
  }
} as unknown as DateConstructor;

interface Stub {
  /** Fake-clock ms at which the server opens `runDate`. */
  flipAt: number;
  /** The day the stub is keeping time for. */
  runDate: string;
  /** Accounts whose session is dead: every authed call answers 401. */
  dead: Set<string>;
  /** Accounts already checked in for `runDate` (only meaningful after the flip). */
  alreadyIn: Set<string>;
  /** Accounts whose POST is answered 429 RATE_LIMITED. */
  rateLimited: Set<string>;
  /** Accounts whose *previous* day was never booked: a pre-flip POST books it. */
  oldDayMissed: Set<string>;
  /** Accounts that booked the previous day during this scenario. */
  oldDayBooked: Set<string>;
  /** Accounts whose status claims the current day is booked when it is not. */
  staleTrue: Set<string>;
  /** Accounts whose next POST is answered 429 CHECK_IN_QUEUE_FULL once. */
  queueFullOnce: Set<string>;
  /** Accounts with a check-in job running right now — the per-account queue. */
  busy: Set<string>;
  /** Job durations the server cycles through, ms. */
  jobPlan: number[];
  /** How many jobs have run, to index `jobPlan`. */
  jobsRun: number;
  /** Fake-clock ms of each account's last booked row — what `createdAt` says. */
  bookedAt: Map<string, number>;
}

const S: Stub = {
  flipAt: 0,
  runDate: RUN_DATE,
  dead: new Set(),
  alreadyIn: new Set(),
  rateLimited: new Set(),
  oldDayMissed: new Set(),
  oldDayBooked: new Set(),
  staleTrue: new Set(),
  queueFullOnce: new Set(),
  busy: new Set(),
  jobPlan: [JOB_MS],
  jobsRun: 0,
  bookedAt: new Map(),
};

interface Call {
  user: string;
  at: number;
  status: number;
}
const posts: Call[] = [];
const statusReads: Array<Omit<Call, "status">> = [];
const refreshes: Array<{ token: string; at: number }> = [];
/** Peak check-in jobs running at once — one per account, never more. */
let maxInFlightPosts = 0;
let inFlightPosts = 0;

/** A JWT-shaped access token with the given `exp` (seconds). */
const jwt = (exp: number) =>
  `h.${btoa(JSON.stringify({ exp })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

const rtt = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The stub is async because a call has to take the round trip it takes on the
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
    const next = jwt(Math.floor((now + 3_600_000) / 1000));
    return json(200, { data: { accessToken: next, refreshToken: `${body.refreshToken}` } });
  }

  if (path === "/api/v2/xeng/check-in/status") {
    if (S.dead.has(user)) return json(401, { error: { code: "UNAUTHORIZED" } });
    await rtt(READ_MS);
    statusReads.push({ user, at: now });
    // What the app sees. Before the server opens the day, "today" is still
    // yesterday: `todayCheckedIn` tells whether *yesterday* is booked, and
    // `staleTrue` models a status that lies about it.
    const done = Date.now();
    const open = done >= S.flipAt;
    const already = S.alreadyIn.has(user);
    const missed = S.oldDayMissed.has(user) && !S.oldDayBooked.has(user);
    const booked = open ? already : (!missed || S.staleTrue.has(user));
    return json(200, {
      data: {
        todayCheckedIn: booked,
        currentStreak: already || S.oldDayBooked.has(user) ? 5 : 4,
        todayCheckInPosition: 1,
        history: [{
          checkInDate: open && already
            ? S.runDate
            : (S.oldDayBooked.has(user) ? OLD_DAY : "1999-01-01"),
          createdAt: new Date(S.bookedAt.get(user) ?? 0).toISOString(),
        }],
      },
    });
  }

  if (path === "/api/v2/xeng/check-in" && method === "POST") {
    if (S.dead.has(user)) return json(401, { error: { code: "UNAUTHORIZED" } });
    // The queue is per account and holds one job: anything posted while a job
    // runs is turned away at once, exactly like the real server.
    if (S.busy.has(user) || S.queueFullOnce.delete(user)) {
      posts.push({ user, at: Date.now(), status: 429 });
      return json(429, {
        status: 429,
        success: false,
        code: "CHECK_IN_QUEUE_FULL",
        message: "Điểm danh của bạn đang được xử lý. Vui lòng chờ một chút.",
      });
    }
    // The order matches the real server: limiter first, then the day check, so
    // a shot before the flip is a 400 and never looks like a rate problem.
    if (S.rateLimited.has(user)) {
      posts.push({ user, at: Date.now(), status: 429 });
      return json(429, { error: { code: "RATE_LIMITED", message: "Quá nhiều yêu cầu" } });
    }
    S.busy.add(user);
    inFlightPosts++;
    maxInFlightPosts = Math.max(maxInFlightPosts, inFlightPosts);
    await rtt(S.jobPlan[S.jobsRun++ % S.jobPlan.length]!);
    S.busy.delete(user);
    inFlightPosts--;
    // The row — and the `createdAt` the leaderboard ranks — is written when the
    // job *finishes*, not when the POST arrived.
    const done = Date.now();
    if (done < S.flipAt) {
      // Still yesterday for the server: a duplicate unless yesterday was
      // missed, in which case this job books *it*.
      if (S.oldDayMissed.has(user) && !S.oldDayBooked.has(user)) {
        S.oldDayBooked.add(user);
        S.bookedAt.set(user, done);
        posts.push({ user, at: done, status: 200 });
        return json(200, { data: {} });
      }
      posts.push({ user, at: done, status: 400 });
      return json(400, { success: false, message: "Hôm nay bạn đã điểm danh rồi", status: 400 });
    }
    if (S.alreadyIn.has(user)) {
      posts.push({ user, at: done, status: 400 });
      return json(400, { success: false, message: "Hôm nay bạn đã điểm danh rồi", status: 400 });
    }
    S.alreadyIn.add(user);
    S.bookedAt.set(user, done);
    posts.push({ user, at: done, status: 200 });
    return json(200, { data: {} });
  }

  if (path === "/api/v2/xeng/wallet") {
    return json(200, { data: { wallet: { balance: 123_456 } } });
  }

  throw new Error(`unexpected ${method} ${path}`);
};

globalThis.fetch = stub as unknown as typeof fetch;

function account(username: string): import("../src/types.ts").Account {
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
  seek(); // every scenario starts 1.5s before the same midnight
  posts.length = 0;
  statusReads.length = 0;
  refreshes.length = 0;
  maxInFlightPosts = 0;
  inFlightPosts = 0;
  S.flipAt = 0;
  S.runDate = RUN_DATE;
  S.dead.clear();
  S.alreadyIn.clear();
  S.rateLimited.clear();
  S.oldDayMissed.clear();
  S.oldDayBooked.clear();
  S.staleTrue.clear();
  S.queueFullOnce.clear();
  S.busy.clear();
  S.jobPlan = [JOB_MS];
  S.jobsRun = 0;
  S.bookedAt.clear();
}

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
}

type BatchRun = Array<{ chatId: string; result: import("../src/checkin.ts").CheckInResult }>;
const outcomeAt = (run: BatchRun, i: number) => run[i]?.result.outcome;
/** When the check-in landed for a user: the first 200, in fake-clock ms. */
const firstWin = (user: string) =>
  posts.filter((p) => p.user === user && p.status === 200).map((p) => p.at).sort((a, b) =>
    a - b
  )[0];
const callsOf = (user: string) => posts.filter((p) => p.user === user);
const rel = (at: number) => `${at - MIDNIGHT >= 0 ? "+" : ""}${at - MIDNIGHT}ms`;

// ── 1. The race: the aim puts a job's finish just past midnight ─────────────
reset();
S.flipAt = MIDNIGHT; // the server's midnight is ours — no skew to learn
const targets = [
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
];

const race = await runCheckInAll(targets, { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });

check("both accounts checked in", race.every((r) => r.result.outcome === "checked_in"));
{
  const lead = posts[0]!.at - MIDNIGHT;
  check(
    "the first shot is a stopwatch, fired as soon as the race opens",
    lead >= -1_600 && lead <= -800,
    rel(posts[0]!.at),
  );
}
for (const user of ["a@x.com", "main@x.com"]) {
  const win = firstWin(user);
  check(
    `${user}: the job aimed at midnight finishes just after it`,
    win !== undefined && win >= S.flipAt && win - S.flipAt <= 400,
    win === undefined ? "no 200" : `+${win - S.flipAt}ms after the flip`,
  );
  check(
    `${user}: jobs before the flip answer "already" and the race keeps aiming`,
    callsOf(user).some((p) => p.status === 400),
  );
  const last = Math.max(...callsOf(user).map((p) => p.at));
  check(
    `${user}: the race stands down the moment the day is booked`,
    last <= (win ?? 0) + 1,
    `${last - (win ?? 0)}ms after the win`,
  );
  const reads = statusReads.filter((r) => r.user === user);
  const firstShot = Math.min(...callsOf(user).map((p) => p.at));
  check(
    `${user}: only the pre-race read happens before the shots`,
    reads.filter((r) => r.at < firstShot).length === 1,
    `${reads.filter((r) => r.at < firstShot).length} read(s)`,
  );
  check(
    `${user}: nothing reads the status between the first shot and the win`,
    reads.every((r) => r.at < firstShot || r.at >= (win ?? 0)),
    `${reads.length} read(s)`,
  );
}
check(
  "one job per account at a time, the two accounts alongside each other",
  maxInFlightPosts === 2,
  `peak ${maxInFlightPosts} job(s) in flight`,
);
check("the race fires shots one by one, not a burst", posts.length <= 16, `${posts.length} posts`);

// ── 2. Catch-up: the day was open before we looked ─────────────────────────
reset();
S.runDate = OLD_DAY; // the fake clock already sits on the 1st
S.alreadyIn.add("a@x.com"); // this one is already in — must not POST again
const done = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
], { runDate: OLD_DAY, retryUntil: Date.now() + 60_000 });
check(
  "a run once the day is open does not fire the race at all",
  callsOf("a@x.com").length === 0 && callsOf("main@x.com").length === 1,
  `${posts.length} POST(s)`,
);
check(
  "the checked-in account is reported as such",
  outcomeAt(done, 0) === "already_done",
  outcomeAt(done, 0),
);
check("the other one still checks in", outcomeAt(done, 1) === "checked_in");

// ── 3. Dead session inside the race ────────────────────────────────────────
reset();
S.flipAt = MIDNIGHT;
S.dead.add("a@x.com");
const handed = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
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
check("the dead account never got a shot recorded", callsOf("a@x.com").length === 0);
{
  const win = firstWin("main@x.com");
  check(
    "the dead session did not hold the live one back",
    win !== undefined && win - S.flipAt <= 700,
    win === undefined ? "no 200" : `+${win - S.flipAt}ms after the flip`,
  );
}

// ── 4. Expiring token: refreshed before the race, not during it ────────────
reset();
S.flipAt = MIDNIGHT;
const stale = account("stale@x.com");
// A JWT that expired yesterday: `warm` must replace it up front, so no shot
// spends two extra round trips discovering that.
const expired = jwt(Math.floor((Date.now() - 86_400_000) / 1000));
stale.tokens = { accessToken: expired, refreshToken: "stale@x.com" };
const warmed = await runCheckInAll(
  [{ chatId: "tg:1", account: stale }, { chatId: "tg:1", account: account("main@x.com") }],
  { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 },
);
const fresh = stale.tokens.accessToken;
check(
  "the expiring token was refreshed",
  refreshes.length === 1,
  `${refreshes.length} refresh(es)`,
);
check("the refreshed token is the one that raced", fresh !== expired && callsOf(fresh).length > 0);
check("both accounts checked in", warmed.every((r) => r.result.outcome === "checked_in"));
{
  const win = firstWin(fresh);
  check(
    "the refresh did not push the account's race out of the aim",
    win !== undefined && win - S.flipAt <= 700,
    win === undefined ? "no 200" : `+${win - S.flipAt}ms after the flip`,
  );
}

// ── 5. Flip beyond the aim: the fallback must still book the day ───────────
reset();
S.flipAt = MIDNIGHT + 2_100; // well past the last aimed job's finish
const late = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
check(
  "both accounts checked in after the race came up empty",
  late.every((r) => r.result.outcome === "checked_in"),
);
for (const user of ["a@x.com", "main@x.com"]) {
  const win = firstWin(user);
  check(
    `${user}: the fallback caught the late flip`,
    win !== undefined && win >= S.flipAt && win - S.flipAt <= 2_000,
    win === undefined ? "no 200" : `+${win - S.flipAt}ms after the flip`,
  );
}

// ── 6. Rate limit: that account stops, the other is untouched ──────────────
reset();
S.flipAt = MIDNIGHT;
S.rateLimited.add("a@x.com");
const limited = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
const limitedPosts = callsOf("a@x.com");
check(
  "the rate-limited account fails instead of hammering",
  outcomeAt(limited, 0) === "failed" && limitedPosts.every((p) => p.status === 429) &&
    limitedPosts.length <= 2,
  `${limitedPosts.length} POST(s)`,
);
check(
  "…and stops firing right away",
  Math.max(...limitedPosts.map((p) => p.at)) - limitedPosts[0]!.at <= 700,
);
check(
  "the other account's race is unaffected",
  outcomeAt(limited, 1) === "checked_in" && firstWin("main@x.com")! - S.flipAt <= 700,
  outcomeAt(limited, 1),
);

// ── 7. A missed yesterday: the first shot repairs it, tonight still wins ───
reset();
S.flipAt = MIDNIGHT;
S.oldDayMissed.add("a@x.com"); // never checked in yesterday
const repaired = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
{
  const wins = posts.filter((p) => p.user === "a@x.com" && p.status === 200)
    .map((p) => p.at)
    .sort((a, b) => a - b);
  check(
    "the missed day is repaired by a pre-midnight shot",
    wins.length > 0 && wins[0]! < S.flipAt,
    `${wins.length} 200(s), first ${rel(wins[0] ?? 0)}`,
  );
  const tonight = wins.find((at) => at >= S.flipAt);
  check(
    "…and tonight's win is the first 200 after the flip, not the repair",
    tonight !== undefined && tonight - S.flipAt <= 700,
    tonight === undefined ? "never booked tonight" : `+${tonight - S.flipAt}ms after the flip`,
  );
}
check(
  "the repaired account is reported as checked in",
  outcomeAt(repaired, 0) === "checked_in",
  outcomeAt(repaired, 0),
);
check("the healthy account is untouched", outcomeAt(repaired, 1) === "checked_in");

// ── 8. A status that lies: a wrong-day 200 must not mark the day done ──────
reset();
S.flipAt = MIDNIGHT;
S.oldDayMissed.add("a@x.com"); // the read would say "missed"…
S.staleTrue.add("a@x.com"); // …but this status claims it is booked
const liar = account("a@x.com");
const lied = await runCheckInAll(
  [{ chatId: "tg:1", account: liar }],
  { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 },
);
check(
  "a wrong-day 200 is reported unfinished, never as a win",
  outcomeAt(lied, 0) === "pending_day",
  outcomeAt(lied, 0),
);
check(
  "…and the day is left unmarked for the net to finish",
  liar.lastCheckInDay !== RUN_DATE,
  String(liar.lastCheckInDay),
);
check(
  "the race stood down after the one 200 it trusted",
  callsOf("a@x.com").filter((p) => p.status === 200).length === 1,
  `${callsOf("a@x.com").length} POST(s)`,
);

// ── 9. Queue full: a retry, never a failure ────────────────────────────────
reset();
S.flipAt = MIDNIGHT;
S.queueFullOnce.add("a@x.com"); // a job from an earlier invocation is still alive
const queued = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
check(
  "a queue-full answer does not fail the account",
  outcomeAt(queued, 0) === "checked_in",
  outcomeAt(queued, 0),
);
check(
  "…and the race retries straight after it",
  callsOf("a@x.com").some((p) => p.status === 429) &&
    callsOf("a@x.com").some((p) => p.status === 200),
  `${callsOf("a@x.com").length} POST(s)`,
);

// ── 10. The real runway: six seconds without burning the shot budget ───────
reset();
seekTo(6_000); // what the cron handler actually gives the race
S.flipAt = MIDNIGHT;
S.jobPlan = [500]; // a middling job: a naive refresh loop fires one per job
const runway = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
check(
  "a six-second runway still books the day",
  outcomeAt(runway, 0) === "checked_in",
  outcomeAt(runway, 0),
);
const runwayShots = callsOf("a@x.com").length;
check(
  "…with shots to spare, not by looping until the budget runs out",
  runwayShots <= 6,
  `${runwayShots} shot(s)`,
);
{
  const win = firstWin("a@x.com");
  check(
    "…and the aim still lands just past midnight",
    win !== undefined && win >= MIDNIGHT && win - MIDNIGHT <= 700,
    win === undefined ? "no 200" : `${win - MIDNIGHT}ms after midnight`,
  );
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll OK");
Deno.exit(failed ? 1 : 0);
