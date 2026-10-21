/**
 * Offline proof for the nightly batch: knocking a check-in onto the flip.
 *
 * Stubs `fetch` against the Caffi base URL and makes the server behave like the
 * real one does now that we know how it works. A POST that arrives before the
 * day opens is turned away in one round trip and never enters the queue. The
 * first POST that arrives after the flip starts a per-account job, any POST
 * while it runs answers 429 CHECK_IN_QUEUE_FULL, and the check-in row — its
 * `createdAt` is what the `earliest` leaderboard ranks — is written when the
 * job *finishes*. The one pre-flip POST that is a real job is a repair of a
 * missed yesterday.
 *
 * Covers (1) the knock race, which must put the accepted POST within one round
 * trip of the flip, (2) a day that was already open (catch-up, restart, re-run),
 * where each account answers for itself and nothing is posted twice, (3) a dead
 * session, which must stand down without holding the other account back, (4) an
 * expiring token, refreshed before the race instead of during it, (5) a flip
 * beyond the knock window, which the read-and-post fallback must still book,
 * (6) a rate limit, which must stop that account's race and leave the other
 * alone, (7) a missed yesterday, whose booking by a pre-flip knock must not be
 * mistaken for tonight's win, (8) a status that lies and says the booking is
 * done — the day must be reported unfinished rather than marked done on a 200
 * that booked an earlier day, (9) a queue-full answer, which must be retried
 * rather than treated as a failure, and (10) a lost response, after which the
 * next knock is a slow duplicate that must be read as "already booked".
 *
 * The race naps until 600ms before midnight, and the harness does not: it moves
 * the clock instead — `Date.now()` reports "1.5 seconds before midnight" and
 * keeps ticking, while timers stay real. The stub reads the same clock, so a
 * job that takes 500ms takes 500ms of race time, not of wall time.
 *
 *   deno task batch
 */
const BASE = "https://client-api.caffiliate.vn";

Deno.env.set("TELEGRAM_BOT_TOKEN", "batch-test-token");
Deno.env.set("BOT_SECRET", "batch-secret");
Deno.env.set("RUNTIME_MODE", "polling");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-batch");

const { runCheckInAll, vnMidnightMs, KNOCK_LEAD_MS } = await import("../src/checkin.ts");

/** The midnight the race aims at. */
const RUN_DATE = "2030-01-01";
const MIDNIGHT = vnMidnightMs(RUN_DATE);
/** The day before it: the "today" the server still counts before the flip. */
const OLD_DAY = "2029-12-31";
/** Where the fake clock parks: close enough that the race runs at once. */
const FAKE_LEAD_MS = 1_500;
/** One status read takes this long on the wire. */
const READ_MS = 265;
/** One turned-away knock: the round trip, no job. */
const KNOCK_MS = 65;
/** The accepted check-in job, from arrival to the row being written. */
const JOB_MS = 500;

const RealDate = Date;
/**
 * The fake clock, driven by a virtual timer queue.
 *
 * `Date.now()` is the fake time, and `setTimeout` does not wait — it parks the
 * callback in a queue and the pump advances the fake clock to its deadline. So
 * a 500ms job still takes 500ms of race time, but no wall time, and the timing
 * assertions do not depend on how loaded the machine is. Callbacks are handed
 * back on a real macrotask so the promises they resolve can interleave.
 */
let now = 0;
let pumping = false;
let seq = 0;
interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}
const timers: Timer[] = [];
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

function schedule(): void {
  if (pumping || !timers.length) return;
  pumping = true;
  realSetTimeout(pump, 0);
}

function pump(): void {
  pumping = false;
  timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const t = timers.shift();
  if (!t) return;
  if (t.at > now) now = t.at;
  t.fn();
  schedule();
}

globalThis.setTimeout = ((fn: () => void, ms?: number) => {
  timers.push({ at: now + (ms ?? 0), seq: seq++, fn });
  schedule();
  return 0;
}) as unknown as typeof setTimeout;

/** Point the clock `leadMs` before `MIDNIGHT`. */
const seekTo = (leadMs: number) => {
  now = MIDNIGHT - leadMs;
};
/** Point the clock at `FAKE_LEAD_MS` before `MIDNIGHT` — where scenarios start. */
const seek = () => seekTo(FAKE_LEAD_MS);
seek();
Date.now = () => now;
globalThis.Date = class extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length === 0 ? [now] : args) as [number]));
  }
  static override now() {
    return now;
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
  /** Accounts whose next *accepted* POST has its response lost on the way back. */
  lostOnce: Set<string>;
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
  lostOnce: new Set(),
  busy: new Set(),
  jobPlan: [JOB_MS],
  jobsRun: 0,
  bookedAt: new Map(),
};

interface Call {
  user: string;
  /** Fake-clock ms at which the POST arrived — what the knock cadence sees. */
  at: number;
  /** Fake-clock ms at which the server answered (the row instant for a 200). */
  done: number;
  status: number;
  /** For a 200: the day the written row belongs to. */
  day?: string;
}
const posts: Call[] = [];
const statusReads: Array<{ user: string; at: number }> = [];
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
    const arrivedAt = Date.now();
    if (S.dead.has(user)) return json(401, { error: { code: "UNAUTHORIZED" } });
    // The queue is per account and holds one job: anything posted while a job
    // runs is turned away at once, exactly like the real server.
    if (S.busy.has(user) || S.queueFullOnce.delete(user)) {
      posts.push({ user, at: arrivedAt, done: Date.now(), status: 429 });
      return json(429, {
        status: 429,
        success: false,
        code: "CHECK_IN_QUEUE_FULL",
        message: "Điểm danh của bạn đang được xử lý. Vui lòng chờ một chút.",
      });
    }
    // The order matches the real server: limiter first, then the day check, so
    // a knock before the flip is a 400 and never looks like a rate problem.
    if (S.rateLimited.has(user)) {
      posts.push({ user, at: arrivedAt, done: Date.now(), status: 429 });
      return json(429, { error: { code: "RATE_LIMITED", message: "Quá nhiều yêu cầu" } });
    }
    // The day check happens when the POST *arrives*: before the flip, the
    // request is turned away in one round trip and never enters the queue.
    // The single exception is a yesterday that was missed — that is a real
    // job, and it books yesterday.
    const open = arrivedAt >= S.flipAt;
    const repairing = !open && S.oldDayMissed.has(user) && !S.oldDayBooked.has(user);
    if (!open && !repairing) {
      await rtt(KNOCK_MS);
      posts.push({ user, at: arrivedAt, done: Date.now(), status: 400 });
      return json(400, { success: false, message: "Hôm nay bạn đã điểm danh rồi", status: 400 });
    }
    // Accepted: one job per account, and the row — with the `createdAt` the
    // leaderboard ranks — is written when the job *finishes*.
    const lost = S.lostOnce.delete(user);
    S.busy.add(user);
    inFlightPosts++;
    maxInFlightPosts = Math.max(maxInFlightPosts, inFlightPosts);
    await rtt(S.jobPlan[S.jobsRun++ % S.jobPlan.length]!);
    S.busy.delete(user);
    inFlightPosts--;
    const done = Date.now();
    if (repairing) {
      S.oldDayBooked.add(user);
      S.bookedAt.set(user, done);
      posts.push({ user, at: arrivedAt, done, status: 200, day: OLD_DAY });
      return json(200, { data: {} });
    }
    if (S.alreadyIn.has(user)) {
      posts.push({ user, at: arrivedAt, done, status: 400 });
      return json(400, { success: false, message: "Hôm nay bạn đã điểm danh rồi", status: 400 });
    }
    S.alreadyIn.add(user);
    S.bookedAt.set(user, done);
    posts.push({ user, at: arrivedAt, done, status: 200, day: S.runDate });
    // The job ran and the row is written, but the answer never makes it back:
    // from our side this looks like a transport blip, and the next knock will
    // be answered as a duplicate.
    if (lost) throw new TypeError("connection reset by peer");
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
  S.lostOnce.clear();
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
/** The first row this user's race wrote — a 200's `createdAt`, in fake-clock ms. */
const firstWin = (user: string) =>
  posts.filter((p) => p.user === user && p.status === 200).map((p) => p.done).sort((a, b) =>
    a - b
  )[0];
/** The POST that opened the day (arrival), judged against the flip. */
const openingPost = (user: string) =>
  posts.find((p) => p.user === user && p.status === 200 && p.done >= S.flipAt);
const callsOf = (user: string) => posts.filter((p) => p.user === user);
const rel = (at: number) => `${at - MIDNIGHT >= 0 ? "+" : ""}${at - MIDNIGHT}ms`;

// ── 1. The race: knock until the server's flip, then let the job run ──────
reset();
S.flipAt = MIDNIGHT; // the server's midnight is ours
const targets = [
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
];

const race = await runCheckInAll(targets, { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });

check("both accounts checked in", race.every((r) => r.result.outcome === "checked_in"));
for (const user of ["a@x.com", "main@x.com"]) {
  const calls = callsOf(user);
  const win = openingPost(user);
  check(
    `${user}: the first knock leaves at the start of the lead window`,
    calls[0] !== undefined &&
      calls[0].at - MIDNIGHT >= -KNOCK_LEAD_MS - 20 &&
      calls[0].at - MIDNIGHT <= -KNOCK_LEAD_MS + 120,
    calls[0] === undefined ? "no POST" : rel(calls[0].at),
  );
  check(
    `${user}: the accepted POST is the first one after the flip`,
    win !== undefined && win.at >= S.flipAt && win.at - S.flipAt <= 2 * KNOCK_MS,
    win === undefined ? "no 200" : `sent ${rel(win.at)}`,
  );
  check(
    `${user}: …so the row is only the job's own duration late`,
    win !== undefined && win.done - S.flipAt <= JOB_MS + 2 * KNOCK_MS,
    win === undefined ? "no 200" : `row ${rel(win.done)} (${win.done - win.at}ms job)`,
  );
  const knocks = calls.filter((p) => p.status === 400);
  check(
    `${user}: knocks before the flip are turned away in one round trip`,
    knocks.length > 0 && knocks.every((p) => p.done - p.at <= KNOCK_MS + 10),
    `${knocks.length} knock(s)`,
  );
  check(
    `${user}: one knock at a time, a round trip apart — never a burst`,
    calls.every((p, i) => i === 0 || p.at - calls[i - 1]!.at >= KNOCK_MS - 10),
    `${calls.length} POST(s)`,
  );
  const last = Math.max(...calls.map((p) => p.at));
  check(
    `${user}: the race stands down the moment the day is booked`,
    win !== undefined && last <= win.done,
    `${last - (win?.done ?? 0)}ms after the row`,
  );
  const reads = statusReads.filter((r) => r.user === user);
  check(
    `${user}: both warm-up reads happen before the first knock`,
    reads.filter((r) => r.at < calls[0]!.at).length === 2,
    `${reads.filter((r) => r.at < calls[0]!.at).length} read(s)`,
  );
  check(
    `${user}: nothing reads the status between the first knock and the win`,
    reads.every((r) => r.at < calls[0]!.at || r.at >= (win?.done ?? 0)),
    `${reads.length} read(s)`,
  );
}
check(
  "one job per account at a time, the two accounts alongside each other",
  maxInFlightPosts === 2,
  `peak ${maxInFlightPosts} job(s) in flight`,
);
check(
  "the race fires one knock per round trip, not a blind grid",
  posts.length <= 2 * Math.ceil(KNOCK_LEAD_MS / KNOCK_MS) + 4,
  `${posts.length} posts`,
);

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

// ── 5. Flip beyond the knock window: the fallback must still book the day ──
reset();
S.flipAt = MIDNIGHT + 3_200; // past RACE_STOP_MS: every knock is still early
const late = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
  { chatId: "tg:1", account: account("main@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
check(
  "both accounts checked in after the knock window came up empty",
  late.every((r) => r.result.outcome === "checked_in"),
);
for (const user of ["a@x.com", "main@x.com"]) {
  const win = firstWin(user);
  check(
    `${user}: the fallback caught the late flip`,
    win !== undefined && win >= S.flipAt && win - S.flipAt <= 3_000,
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
  const rows = posts.filter((p) => p.user === "a@x.com" && p.status === 200);
  const repair = rows.find((p) => p.day === OLD_DAY);
  check(
    "the missed day is repaired by a pre-flip knock",
    repair !== undefined && repair.at < S.flipAt,
    repair === undefined ? "never repaired" : `sent ${rel(repair.at)}, row ${rel(repair.done)}`,
  );
  const tonight = rows.find((p) => p.day === S.runDate);
  check(
    "…and tonight's win is its own row, not the repair",
    tonight !== undefined && tonight.done - S.flipAt <= JOB_MS + READ_MS + 2 * KNOCK_MS + 250,
    tonight === undefined ? "never booked tonight" : `row ${rel(tonight.done)}`,
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

// ── 10. The real runway: six seconds without burning a single knock ────────
reset();
seekTo(6_000); // what the cron handler actually gives the race
S.flipAt = MIDNIGHT;
const runway = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
check(
  "a six-second runway still books the day",
  outcomeAt(runway, 0) === "checked_in",
  outcomeAt(runway, 0),
);
const runwayCalls = callsOf("a@x.com");
check(
  "…without knocking during the runway",
  runwayCalls[0] !== undefined && runwayCalls[0].at >= MIDNIGHT - KNOCK_LEAD_MS - 20,
  runwayCalls[0] === undefined ? "no POST" : rel(runwayCalls[0].at),
);
check(
  "…and with knocks to spare, not by looping until the budget runs out",
  runwayCalls.length <= Math.ceil(KNOCK_LEAD_MS / KNOCK_MS) + 4,
  `${runwayCalls.length} POST(s)`,
);
{
  const win = openingPost("a@x.com");
  check(
    "…and the accepted POST still lands on the flip",
    win !== undefined && win.at >= MIDNIGHT && win.at - MIDNIGHT <= 2 * KNOCK_MS + 60,
    win === undefined ? "no 200" : `sent ${rel(win.at)}, row ${rel(win.done)}`,
  );
}

// ── 11. A lost response: the slow failure must read as "already booked" ────
reset();
S.flipAt = MIDNIGHT;
S.lostOnce.add("a@x.com"); // the job runs and the row is written, the answer dies
const dropped = await runCheckInAll([
  { chatId: "tg:1", account: account("a@x.com") },
], { runDate: RUN_DATE, retryUntil: Date.now() + 60_000 });
check(
  "a lost response still ends checked in",
  outcomeAt(dropped, 0) === "checked_in",
  outcomeAt(dropped, 0),
);
{
  const rows = posts.filter((p) => p.user === "a@x.com" && p.status === 200);
  const lostAt = rows[0]?.done ?? 0;
  const tail = callsOf("a@x.com").filter((p) => p.at > lostAt);
  check(
    "…from the row the lost job wrote, without posting a second one",
    rows.length === 1 && rows[0]!.day === S.runDate && tail.length === 0,
    `${rows.length} 200(s), ${tail.length} POST(s) after it`,
  );
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll OK");
Deno.exit(failed ? 1 : 0);
