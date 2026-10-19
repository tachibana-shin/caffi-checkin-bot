import { CaffiApi, SessionExpiredError, type SessionHandle } from "./caffi.ts";
import { store } from "./store.ts";
import type { Account, CheckInStatus, Wallet } from "./types.ts";
import type { Card } from "./view.ts";

export function apiFor(account: Account): CaffiApi {
  const handle: SessionHandle = {
    getTokens: () => account.tokens,
    saveTokens: (tokens) => {
      account.tokens = tokens;
      store.touch();
    },
    clearSession: (reason) => {
      account.sessionInvalid = true;
      account.invalidReason = reason;
      store.touch();
    },
  };
  return new CaffiApi(handle);
}

export type CheckInOutcome =
  | "checked_in"
  | "already_done"
  /** The server still counts the previous day — worth retrying. */
  | "pending_day"
  | "session_expired"
  | "failed";

export interface CheckInResult {
  outcome: CheckInOutcome;
  /** What the user sees — rendered per platform by `view.ts`. */
  card: Card;
  /** Internal: safe to retry inside the pre-roll window (e.g. "day not open yet"). */
  retryable?: boolean;
  /** Epoch-ms of the POST that opened the day — what the midnight race is measured by. */
  postedAt?: number;
  /** Epoch-ms the winning job *finished* (its `createdAt`) — the ranked instant. */
  finishedAt?: number;
}

export interface RunCheckInOptions {
  /** The VN date this run is aiming at. Defaults to today. */
  runDate?: string;
  /** Keep retrying until this epoch-ms. 0 (default) = a single attempt. */
  retryUntil?: number;
}

/** One chat's account, as the nightly run needs it. */
export interface CheckInTarget {
  chatId: string;
  account: Account;
}

const fmt = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("vi-VN") : "—";

/** Coins — the server nests them under response.wallet.balance. */
export const balanceOf = (w: Wallet | null | undefined): string => fmt(w?.wallet?.balance);

/**
 * Body for `pending_day` results that are never shown — `runCheckIn` swaps them
 * for `dayNotOpenYet()` as soon as it stops retrying, so only the outcome and
 * the retryable flag matter here.
 */
const emptyCard = (): Card => ({ icon: "", title: "", tone: "info" });

/** Vietnam is UTC+7 with no DST, so midnight never moves. */
const VN_OFFSET_MS = 7 * 3600 * 1000;

/** Poll cadence around midnight — chosen by `pollDelay`. */
const FINE_INTERVAL_MS = 50;
const FINE_BEFORE_MS = 2_000;
const FINE_AFTER_MS = 2_000;
const COARSE_INTERVAL_MS = 1_000;
const SLOW_INTERVAL_MS = 10_000;
/** Once this long has passed with no deadline nearby, stop spending requests. */
const RACE_MS = 20_000;

/** Midnight (VN) of a "YYYY-MM-DD" date, as epoch ms. */
export function vnMidnightMs(runDate: string): number {
  const [y, m, d] = runDate.split("-").map(Number);
  if (!y || !m || !d) return Number.NaN;
  return Date.UTC(y, m - 1, d) - VN_OFFSET_MS;
}

/**
 * How long to wait before re-reading the status.
 *
 * This is the fallback cadence, `runCheckIn`'s retry loop — the nightly batch
 * does not poll (it aims a queued job across midnight, see below). It decides
 * how fast a run that lost the race notices that the day has opened: 50ms
 * across the two seconds either side of the deadline, then 1s for the first
 * 20s, then 10s, so a slow server costs nothing.
 */
export function pollDelay(targetMs: number, nowMs: number, startedAtMs: number): number {
  if (nowMs > targetMs - FINE_BEFORE_MS && nowMs < targetMs + FINE_AFTER_MS) {
    return FINE_INTERVAL_MS;
  }
  return nowMs - startedAtMs < RACE_MS ? COARSE_INTERVAL_MS : SLOW_INTERVAL_MS;
}

/**
 * Time of the newest check-in, as "HH:MM:SS DD/MM" in Vietnam.
 *
 * The status payload has no `checkedInAt` — only `history[].createdAt` (UTC),
 * so this is the only server-side timestamp worth showing.
 */
export function checkedInAtOf(s: CheckInStatus | null | undefined): string | undefined {
  let latest = 0;
  for (const h of s?.history ?? []) {
    const t = h.createdAt ? Date.parse(h.createdAt) : Number.NaN;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest > 0 ? nowVn(new Date(latest)) : undefined;
}

/**
 * Run a check-in for one account.
 *
 * - already checked in for the target day  => do nothing
 * - server has not rolled over yet         => retry until `retryUntil` (pre-midnight attempt)
 * - session dropped by the server          => flag sessionInvalid so the bot can ask for /login
 *
 * The scheduler starts a few seconds before midnight because the fastest
 * check-in earns a bigger reward; `retryUntil` is what makes that safe when
 * the server clock has not turned the day yet.
 */
export async function runCheckIn(
  account: Account,
  opts: RunCheckInOptions = {},
): Promise<CheckInResult> {
  const runDate = opts.runDate ?? vnDate();
  const deadline = opts.retryUntil ?? 0;
  const api = apiFor(account);
  const startedAt = Date.now();
  const targetMs = vnMidnightMs(runDate);

  for (;;) {
    const r = await attemptCheckIn(api, account, runDate);
    const canRetry = r.outcome === "pending_day" ||
      (r.outcome === "failed" && r.retryable === true);
    if (!canRetry || Date.now() >= deadline) {
      return r.outcome === "pending_day" ? dayNotOpenYet() : r;
    }
    await sleep(pollDelay(targetMs, Date.now(), startedAt));
  }
}

/**
 * The completion-aimed race — how midnight is won.
 *
 * The server does not check a POST in when it arrives. It queues the request
 * per account and runs it as a job; while that job is alive, every other POST
 * from the same account is answered `429 CHECK_IN_QUEUE_FULL` ("Điểm danh của
 * bạn đang được xử lý…"), and the check-in row — with its `createdAt` — is
 * written when the job *finishes*. Measured 19-20 Oct 2026: a job takes
 * 200ms-2s. A blind grid is therefore useless: only the first shot enters the
 * queue, the rest bounce off 429, and the rank is decided by how long the one
 * job in flight takes. That is why shot grids still landed +1188ms/+1320ms
 * while the day's leader sat at +119ms.
 *
 * So the race is not "when to send" but "when does the job *finish*". Shots go
 * out one at a time; each round trip is a free stopwatch for how long the
 * server is currently taking, and the next shot is sent so that its job
 * finishes `AIM_PAST_MS` after midnight. A job that finishes before the flip
 * answers "already done" (yesterday is still today, and it is booked) — that
 * updates the stopwatch and the loop repeats. The first job that finishes
 * after the flip *is* the check-in.
 *
 * The one thing the clock cannot tell us is how far the server's own midnight
 * sits from ours, so it is learned from the winning row (`race:skew`) and used
 * the following night; the fallback read-and-post stays as the net when the
 * queue never frees.
 */
const RACE_START_MS = 6_000;
const RACE_STOP_MS = 3_000;
/** Aim a job's *completion* this far past midnight — covers the return leg. */
const AIM_PAST_MS = 230;
/** A stopwatch reading older than this is stale — re-measure before aiming. */
const AIM_REFRESH_MS = 1_200;
/** At most this many shots are spent purely re-timing the server. */
const AIM_REFRESH_MAX = 3;
/** A queue-full answer means our own job is still running; try again shortly. */
const QUEUE_RETRY_MS = 150;
/** Two accounts share one network path, not one queue — offset them a little. */
const SPRINT_STAGGER_MS = 100;
const MAX_SHOTS = 8;
/** Return leg assumed when turning a round trip into a job duration. */
const RETURN_LEG_MS = 120;

/**
 * When to send so the job finishes `skewMs + AIM_PAST_MS + slotMs` past
 * midnight. `measuredMs` is the last send→response round trip; sending that
 * much early puts the finish where the aim wants it. `skewMs` is the stored
 * calibration (server midnight minus ours), so the aim rides the server clock.
 */
export function aimSendAt(
  targetMs: number,
  measuredMs: number,
  skewMs: number,
  slotMs: number,
): number {
  return targetMs + skewMs + AIM_PAST_MS + slotMs - measuredMs;
}

/** "+"/"-" sign of a delta in ms, for the race log. */
const signed = (ms: number): string => `${ms >= 0 ? "+" : ""}${ms}`;

/** One shot as the race log keeps it: when it left, how long, what it said. */
interface RaceShot {
  at: number;
  ms: number;
  label: string;
}

/** "Điểm danh của bạn đang được xử lý" — our own job is still in the queue. */
function isQueueFull(err: Error & { code?: string }): boolean {
  return err.code === "CHECK_IN_QUEUE_FULL" || /đang được xử lý/i.test(err.message);
}

/**
 * One account's race, from the first stopwatch shot to a confirmed check-in.
 *
 * One read runs alongside it, five seconds early and off the critical path: it
 * asks whether yesterday is already booked, which is what makes a 200 readable.
 * When it cannot be answered, each 200's `history[].checkInDate` is verified
 * instead.
 */
async function sprintCheckIn(
  account: Account,
  runDate: string,
  slot: number,
  deadline: number,
): Promise<CheckInResult> {
  const api = apiFor(account);
  const targetMs = vnMidnightMs(runDate);
  const stopAt = targetMs + RACE_STOP_MS;
  const slotMs = slot * SPRINT_STAGGER_MS;
  /** Learned from last night's winning row: server midnight minus ours. */
  const skewMs = (await store.meta<number>("race:skew").catch(() => undefined)) ?? 0;
  const shots: RaceShot[] = [];
  /** Set once the race is decided — a 200, a dead session, a rate limit. */
  let settled = false;
  let winPostedAt: number | undefined;
  let winFinishedAt: number | undefined;
  let fatal: CheckInResult | undefined;

  // Resolves long before the first shot, and answers "may a 200 be read as the
  // new day?". A dead session stands the race down here; anything else says
  // "no" and the 200s are verified instead.
  const trusted = api.getCheckInStatus().then((s) => {
    if (s.todayCheckedIn === true) return true;
    console.log(`[sprint] ${account.username}: yesterday was never booked — wins must be verified`);
    return false;
  }).catch((e) => {
    if (e instanceof SessionExpiredError) {
      settled = true;
      fatal = sessionExpiredCard(e, account);
      console.log(`[sprint] ${account.username}: session gone (pre-race read)`);
    } else {
      console.error(`[sprint] ${account.username}: pre-race read failed, verifying every win:`, e);
    }
    return false;
  });

  // Start the stopwatch chain just before midnight — or right away when the
  // wake-up was late; the aim formula handles both.
  const openAt = targetMs - RACE_START_MS + slotMs;
  if (openAt > Date.now()) await sleep(openAt - Date.now());

  // The trust answer must describe the world *before* the first shot: a job
  // that repairs a missed yesterday flips the very status field the read is
  // watching, and a read that lands after that repair would trust the repair as
  // tonight's win. Wait for it — but never past the runway.
  await Promise.race([trusted, sleep(2_000)]);

  let measured = 0;
  /** When the last `measured` reading came back — the server's load drifts. */
  let measuredAt = 0;
  /** Shots spent re-timing the server; the rest of the budget is for the aim. */
  let refreshes = 0;
  while (!settled && fatal === undefined && Date.now() < stopAt && shots.length < MAX_SHOTS) {
    if (measured > 0) {
      const now = Date.now();
      const aim = aimSendAt(targetMs, measured, skewMs, slotMs);
      if (aim > now) {
        // The send instant is still ahead. Wait for it — but wake early when
        // the stopwatch is getting old, because a reading from another second
        // is only a guess about a server whose load drifts. Only a few shots
        // are spent that way: past that, waiting beats burning the budget.
        const age = now - measuredAt;
        // A refresh shot must not eat the aim itself: only spend one while
        // there is room for another job's worth of time before the send
        // instant. Past that, waiting beats re-timing.
        const refreshDue = age >= AIM_REFRESH_MS && refreshes < AIM_REFRESH_MAX &&
          aim - now > 2 * measured;
        if (!refreshDue) {
          const wait = age >= AIM_REFRESH_MS
            ? aim - now
            : Math.min(aim - now, AIM_REFRESH_MS - age);
          await sleep(Math.max(1, wait));
          if (settled || fatal !== undefined) break;
          continue; // the aim is due now, or the reading is due a refresh
        }
        refreshes++;
      }
      // The aim is already in the past (a late wake-up): fire at once.
    }
    const postedAt = Date.now();
    const mark = signed(postedAt - targetMs);
    const n = shots.length + 1;
    try {
      await api.postCheckIn();
      const finishedAt = Date.now();
      const jobMs = finishedAt - postedAt;
      shots.push({ at: postedAt, ms: jobMs, label: "OPEN" });
      if (winPostedAt === undefined) {
        // 200 — but of *which* day? If yesterday was already booked, every job
        // before the flip must have answered "already done", so this one can
        // only have finished after it. Otherwise it may have booked yesterday.
        if (await trusted) {
          winPostedAt = postedAt;
          winFinishedAt = finishedAt;
          settled = true;
          console.log(`[sprint] ${account.username} #${n} ${mark}ms → OPEN in ${jobMs}ms`);
        } else {
          const s = await api.getCheckInStatus().catch(() => null);
          const day = s ? lastCheckInDate(s) : undefined;
          if (day !== undefined && day >= runDate) {
            winPostedAt = postedAt;
            winFinishedAt = finishedAt;
            settled = true;
            console.log(
              `[sprint] ${account.username} #${n} ${mark}ms → OPEN (verified) in ${jobMs}ms`,
            );
          } else {
            measured = jobMs;
            measuredAt = finishedAt;
            console.log(`[sprint] ${account.username} #${n} ${mark}ms → booked an earlier day`);
          }
        }
      }
    } catch (e) {
      const jobMs = Date.now() - postedAt;
      if (e instanceof SessionExpiredError) {
        settled = true;
        fatal = sessionExpiredCard(e, account);
        shots.push({ at: postedAt, ms: jobMs, label: "session gone" });
        console.log(`[sprint] ${account.username} #${n} ${mark}ms → session gone`);
        break;
      }
      const err = e as Error & { code?: string };
      if (isQueueFull(err)) {
        // Our own previous job has not cleared yet — no stopwatch value here.
        shots.push({ at: postedAt, ms: jobMs, label: "queue full" });
        await sleep(QUEUE_RETRY_MS);
        continue;
      }
      if (err.code === "RATE_LIMITED") {
        settled = true;
        fatal = failedCard(err);
        shots.push({ at: postedAt, ms: jobMs, label: "rate limited" });
        console.log(`[sprint] ${account.username} #${n} ${mark}ms → rate limited`);
        break;
      }
      // "Hôm nay bạn đã điểm danh rồi" is what every job before the flip must
      // answer, and a transport blip is tolerated the same way: keep aiming.
      measured = jobMs;
      measuredAt = Date.now();
      const label = err.message.includes("điểm danh") ? "already" : (err.code ?? err.message);
      shots.push({ at: postedAt, ms: jobMs, label });
      console.log(`[sprint] ${account.username} #${n} ${mark}ms → ${label} (job ${jobMs}ms)`);
    }
  }

  // Kept for tuning: the trace only says we booked, this says how the aim went.
  await store.setMeta(`race:shots:${account.username}`, { date: runDate, skewMs, shots })
    .catch(() => {});

  if (fatal) return fatal;
  if (winPostedAt !== undefined) {
    return await finishCheckIn(api, account, runDate, null, winPostedAt, winFinishedAt);
  }
  // The queue never landed after the flip: the server's midnight is further
  // from ours than the aim assumes. Read-and-post still works, one job later.
  console.log(`[sprint] ${account.username}: queue never landed after the flip, reading instead`);
  return await runCheckIn(account, { runDate, retryUntil: deadline });
}

/**
 * Check every account in around midnight, as close to the flip as possible.
 *
 * Before midnight each account runs the completion-aimed race (see the block
 * above). `runCheckIn` — read, decide, maybe post — stays the manual path and
 * the fallback. Once the day is open (a catch-up run, a restart, a re-run)
 * there is no race left to win, so each account answers on its own session and
 * "already checked in" is honoured per login.
 */
export async function runCheckInAll(
  targets: CheckInTarget[],
  opts: RunCheckInOptions = {},
): Promise<Array<CheckInTarget & { result: CheckInResult }>> {
  const runDate = opts.runDate ?? vnDate();
  const deadline = opts.retryUntil ?? 0;
  if (!targets.length) return [];

  // A 401 costs two extra round trips, and they would land on the shot whose
  // rank is being measured. Warm the tokens that are about to lapse while the
  // second is still worth nothing.
  await Promise.all(targets.map(async ({ account }) => {
    try {
      await apiFor(account).warm();
    } catch {
      // Nothing to fix here — the POST reports the dead session.
    }
  }));

  // Midnight still ahead: the flip has not happened by definition, so there is
  // nothing to read — start the race under it.
  if (Date.now() < vnMidnightMs(runDate)) {
    return await Promise.all(
      targets.map(async ({ chatId, account }, slot) => ({
        chatId,
        account,
        result: await sprintCheckIn(account, runDate, slot, deadline),
      })),
    );
  }

  // Already open (catch-up, restart, a re-run): answer each account on its own
  // session, so "already checked in" is respected.
  return await Promise.all(
    targets.map(async (target) => ({
      ...target,
      result: await runCheckIn(target.account, { runDate, retryUntil: deadline }),
    })),
  );
}

/** One status check + one POST. Retries are decided by the caller. */
async function attemptCheckIn(
  api: CaffiApi,
  account: Account,
  runDate: string,
): Promise<CheckInResult> {
  try {
    const before = await api.getCheckInStatus();
    const decision = decideFromStatus(before, runDate);

    if (decision === "already_done") {
      account.lastCheckInResult = "already";
      store.touch();
      return {
        outcome: "already_done",
        card: {
          icon: "✅",
          title: "Đã điểm danh hôm nay rồi",
          tone: "success",
          stats: [
            { label: "Chuỗi", value: `${fmt(before.currentStreak)} ngày` },
            { label: "Hạng hôm nay", value: fmt(before.todayCheckInPosition) },
            { label: "Điểm danh lúc", value: checkedInAtOf(before) ?? "—" },
          ],
        },
      };
    }

    if (decision === "pending_day") {
      // The newest entry is still the previous day: we are running before midnight.
      return { outcome: "pending_day", card: emptyCard(), retryable: true };
    }

    const postedAt = Date.now();
    await api.postCheckIn();
    return await finishCheckIn(api, account, runDate, before, postedAt);
  } catch (e) {
    if (e instanceof SessionExpiredError) return sessionExpiredCard(e, account);
    return failedCard(e as Error & { code?: string });
  }
}

function sessionExpiredCard(e: SessionExpiredError, account: Account): CheckInResult {
  return {
    outcome: "session_expired",
    card: {
      icon: "🔒",
      title: "Phiên đã bị đăng xuất",
      subtitle: e.message,
      tone: "error",
      blocks: [{
        text: `Tài khoản: ${account.username}\n\n` +
          `Gửi lại lệnh để tiếp tục:\n` +
          `/login ${account.username} ${account.password}`,
        mono: true,
      }],
    },
  };
}

/**
 * A POST or a status read that could not be answered. Only a rate limit is
 * worth treating as fatal — a premature attempt waits for the day to open.
 */
function failedCard(err: Error & { code?: string }): CheckInResult {
  return {
    outcome: "failed",
    retryable: err.code !== "RATE_LIMITED",
    card: {
      icon: "⚠️",
      title: "Điểm danh thất bại",
      subtitle: err.code ? `${err.message} (${err.code})` : err.message,
      tone: "error",
    },
  };
}

/**
 * Everything after the POST went out: confirm it really landed, report it.
 *
 * `before` is the status read that came first — null when the caller skipped
 * that read on purpose (the day was known to be open already).
 */
async function finishCheckIn(
  api: CaffiApi,
  account: Account,
  runDate: string,
  before: CheckInStatus | null,
  postedAt: number,
  /** When the winning POST's response came back — the job's finish, our clock. */
  finishedAt?: number,
): Promise<CheckInResult> {
  // Re-read status + balance to report the real outcome.
  const [after, wallet] = await Promise.all([
    readConfirmedStatus(api, before, runDate),
    api.getWallet().catch(() => null),
  ]);

  // Calibrate the race aim. The row's `createdAt` is the server's own clock at
  // the insert, so (response time − return leg) − createdAt is how far the
  // server's midnight sits from ours; the next night's aim rides that offset.
  // Smoothed because the split between insert and response is not exact.
  if (finishedAt !== undefined && after) {
    const row = newestCreatedAt(after);
    if (row !== undefined) {
      const sample = Math.round(finishedAt - RETURN_LEG_MS - row);
      if (Math.abs(sample) < 10_000) {
        const prev = await store.meta<number>("race:skew").catch(() => undefined);
        const skew = prev === undefined ? sample : Math.round((prev + sample) / 2);
        await store.setMeta("race:skew", skew).catch(() => {});
        console.log(`[sprint] ${account.username}: aim skew ${sample}ms (stored ${skew}ms)`);
      }
    }
  }

  // Booked, but not for the day that was raced: the POST landed while the
  // server's "today" was still yesterday (which a missed night leaves open).
  // Nothing is lost — the new day is simply still closed — but reporting a win
  // here would mark `runDate` done and skip the night. Callers wait for the
  // flip instead (and the catch-up cron is the net for a read that stays stale).
  const bookedDay = after ? lastCheckInDate(after) : undefined;
  if (bookedDay !== undefined && bookedDay < runDate) {
    return dayNotOpenYet();
  }

  account.lastCheckInDay = runDate;
  account.lastCheckInResult = "ok";
  store.touch();

  const balance = balanceOf(wallet);
  const position = fmt(after?.todayCheckInPosition);
  const confirmed = after?.todayCheckedIn === true;
  return {
    outcome: "checked_in",
    postedAt,
    finishedAt,
    card: {
      icon: confirmed ? "🎉" : "⚠️",
      title: confirmed ? "Điểm danh thành công" : "Đã gửi yêu cầu, chưa xác nhận",
      tone: confirmed ? "success" : "warn",
      stats: [
        { label: "Chuỗi hiện tại", value: `${fmt(after?.currentStreak)} ngày` },
        { label: "Hạng hôm nay", value: position },
        { label: "Số Xèng trong ví", value: balance },
        { label: "Điểm danh lúc", value: checkedInAtOf(after) ?? nowVn() },
      ],
    },
  };
}

/**
 * Read the status back after the POST, waiting until it really reflects it.
 *
 * Production evidence (07-10-2026): the wallet row was written at
 * `17:13:05.000Z` and the check-in row at `17:13:05.192Z`, so a status read
 * issued straight after the POST can still come back with the *previous*
 * streak — it answered 3 while the true value was 4. Rather than reporting a
 * number the server has not committed, confirm it: the day must be booked, the
 * streak must have moved past what we saw before the POST, and the newest
 * `history[].checkInDate` must be `runDate` — a pre-midnight POST books
 * *yesterday* when a night was missed, and that is not this day's win.
 */
async function readConfirmedStatus(
  api: CaffiApi,
  before: CheckInStatus | null,
  runDate: string,
): Promise<CheckInStatus | null> {
  let last: CheckInStatus | null = null;
  let confirmed: CheckInStatus | null = null;
  for (let i = 0; i < 3; i++) {
    const s = await api.getCheckInStatus().catch(() => null);
    if (s) {
      last = s;
      if (s.todayCheckedIn) {
        confirmed = s;
        const day = lastCheckInDate(s);
        if (
          (s.currentStreak ?? 0) > (before?.currentStreak ?? -1) &&
          day !== undefined && day >= runDate
        ) {
          return s;
        }
      }
    }
    if (i < 2) await sleep(250);
  }
  return confirmed ?? last;
}

function dayNotOpenYet(): CheckInResult {
  return {
    outcome: "pending_day",
    retryable: true,
    card: {
      icon: "⏳",
      title: "Chưa mở ngày điểm danh mới",
      subtitle: "Server vẫn ghi nhận ngày cũ nên bot chưa điểm danh được.",
      tone: "warn",
      blocks: [{ text: "Thử lại sau bằng /checkin" }],
    },
  };
}

/** Newest check-in date reported by the status endpoint (order-independent). */
function lastCheckInDate(s: CheckInStatus): string | undefined {
  let max: string | undefined;
  for (const h of s.history ?? []) {
    const d = h.checkInDate;
    if (d && (max === undefined || d > max)) max = d;
  }
  return max;
}

/**
 * Newest `history[].createdAt` as epoch ms — the server's own clock at the
 * insert, which is what the leaderboard ranks. `undefined` when the endpoint
 * reports dates without times.
 */
function newestCreatedAt(s: CheckInStatus): number | undefined {
  let max: number | undefined;
  for (const h of s.history ?? []) {
    const t = h.createdAt ? Date.parse(h.createdAt) : Number.NaN;
    if (Number.isFinite(t) && (max === undefined || t > max)) max = t;
  }
  return max;
}

export type StatusDecision = "check_in" | "already_done" | "pending_day";

/**
 * The core rule of the pre-midnight attempt: read `todayCheckedIn` together with
 * the newest history entry, so a day the server has not opened yet is told apart
 * from a day that was already checked in.
 *
 * - `check_in`     — the new day is open, go ahead and POST
 * - `already_done` — the newest entry already belongs to the target day
 * - `pending_day`  — the server still counts the previous day, retry later
 */
export function decideFromStatus(before: CheckInStatus, runDate: string): StatusDecision {
  if (!before.todayCheckedIn) return "check_in";
  const last = lastCheckInDate(before);
  return last !== undefined && last >= runDate ? "already_done" : "pending_day";
}

/** The current date as "YYYY-MM-DD" in Vietnam time. */
export function vnDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function nowVn(d = new Date()): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
