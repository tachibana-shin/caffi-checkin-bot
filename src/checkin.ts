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
 * The `earliest` leaderboard puts first place at +134ms past midnight, so a 1s
 * poll can only ever land near +500ms (about 4th). Polling every 50ms across the
 * couple of seconds either side of the deadline shrinks the window in which the
 * day can flip unnoticed to under 100ms.
 * Everywhere else backs off to 1s, then 10s, so a slow server costs nothing.
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

/** How `waitForDayOpen` learned that the server has opened the day. */
type DayOpenMode = "race" | "catch_up";

/**
 * One session watches the server until it counts `runDate` as today.
 *
 * Nothing else can answer "is it midnight on the server yet": the flip is only
 * visible in a status read. Sharing the watch is what makes every POST land
 * together — on its own each account pays for the discovery, and with a ~250ms
 * round trip to the Caffi servers that is the whole race: measured on
 * 2026-10-09 the account that watched from the pre-roll got rank 3 at
 * 00:00:00 while the one that woke up at midnight and had to look for itself
 * got rank 10 at 00:00:01.
 *
 * Returns `"race"` when the day flipped while we were waiting — nobody has
 * checked in for it yet — and `"catch_up"` when it was already open, which
 * means each account has to answer "already done?" for itself.
 */
async function waitForDayOpen(
  api: CaffiApi,
  runDate: string,
  deadline: number,
): Promise<DayOpenMode | null> {
  const targetMs = vnMidnightMs(runDate);
  const startedAt = Date.now();
  let reads = 0;

  for (;;) {
    reads++;
    try {
      const s = await api.getCheckInStatus();
      // "check_in" (fresh day, not yet taken) and "already_done" (this account
      // is in) both mean the day is open; only the previous day blocks.
      if (decideFromStatus(s, runDate) !== "pending_day") return reads === 1 ? "catch_up" : "race";
      await sleep(pollDelay(targetMs, Date.now(), startedAt));
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e;
      // A dropped read is not a verdict: come back quickly instead of backing
      // off to 10s, which a pre-roll cannot afford.
      if (Date.now() >= deadline) return null;
      await sleep(200);
    }
    if (Date.now() >= deadline) return null;
  }
}

/**
 * The POST itself, with the status read skipped on purpose.
 *
 * Only safe once `waitForDayOpen` has seen the flip: a read costs one round
 * trip (~250ms to Vietnam), and one read per account is exactly what used to
 * spread the accounts a second apart. `postedAt` is stamped the moment the
 * request leaves, so the log measures what the leaderboard ranks.
 */
async function postAtOpen(
  account: Account,
  runDate: string,
  deadline: number,
): Promise<CheckInResult> {
  const api = apiFor(account);
  const postedAt = Date.now();
  try {
    await api.postCheckIn();
  } catch (e) {
    if (e instanceof SessionExpiredError) return sessionExpiredCard(e, account);
    const err = e as Error & { code?: string };
    if (err.code === "RATE_LIMITED") return failedCard(err);
    // The gate can lag the server's clock by a round trip; retry this one
    // account on its own rather than losing the run.
    return await runCheckIn(account, { runDate, retryUntil: deadline });
  }
  return await finishCheckIn(api, account, runDate, null, postedAt);
}

/**
 * Check every account in as close to the same instant as possible.
 *
 * `runCheckIn` answers "what does this one account see" and polls on its own,
 * which is right for a manual `/checkin`. For the nightly race it is wasteful:
 * every account polls and then each lands on its own round trip. Here one
 * session watches for the flip and every POST is issued from a single
 * `Promise.all`, so the requests leave within microseconds of each other and
 * arrive within one round trip of each other.
 */
export async function runCheckInAll(
  targets: CheckInTarget[],
  opts: RunCheckInOptions = {},
): Promise<Array<CheckInTarget & { result: CheckInResult }>> {
  const runDate = opts.runDate ?? vnDate();
  const deadline = opts.retryUntil ?? 0;
  if (!targets.length) return [];

  // A 401 costs two extra round trips, and they would land on the POST whose
  // rank is being measured. Warm the tokens that are about to lapse while the
  // second is still worth nothing.
  await Promise.all(targets.map(async ({ account }) => {
    try {
      await apiFor(account).warm();
    } catch {
      // Nothing to fix here — the POST reports the dead session.
    }
  }));

  // The watcher is the first account that can still read the server. A dead
  // session must not burn the window — hand the watch to the next one.
  let gate: DayOpenMode | null = null;
  for (const target of targets) {
    try {
      gate = await waitForDayOpen(apiFor(target.account), runDate, deadline);
      break;
    } catch (e) {
      if (!(e instanceof SessionExpiredError)) throw e;
    }
  }

  // The flip was observed: everyone POSTs at once, reads skipped.
  if (gate === "race") {
    return await Promise.all(
      targets.map(async (target) => ({
        ...target,
        result: await postAtOpen(target.account, runDate, deadline),
      })),
    );
  }

  // Already open (catch-up, restart, a re-run) or we ran out of window: answer
  // each account on its own session, so "already checked in" is respected.
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
): Promise<CheckInResult> {
  // Re-read status + balance to report the real outcome.
  const [after, wallet] = await Promise.all([
    readConfirmedStatus(api, before),
    api.getWallet().catch(() => null),
  ]);

  account.lastCheckInDay = runDate;
  account.lastCheckInResult = "ok";
  store.touch();

  const balance = balanceOf(wallet);
  const position = fmt(after?.todayCheckInPosition);
  const confirmed = after?.todayCheckedIn === true;
  return {
    outcome: "checked_in",
    postedAt,
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
 * number the server has not committed, confirm it: the flag must be set and the
 * streak must have moved past what we saw before the POST.
 */
async function readConfirmedStatus(
  api: CaffiApi,
  before: CheckInStatus | null,
): Promise<CheckInStatus | null> {
  let last: CheckInStatus | null = null;
  let confirmed: CheckInStatus | null = null;
  for (let i = 0; i < 3; i++) {
    const s = await api.getCheckInStatus().catch(() => null);
    if (s) {
      last = s;
      if (s.todayCheckedIn) {
        confirmed = s;
        if ((s.currentStreak ?? 0) > (before?.currentStreak ?? -1)) return s;
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
