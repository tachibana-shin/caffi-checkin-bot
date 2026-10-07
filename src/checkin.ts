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
 * The `earliest` leaderboard puts first place at +134ms past midnight and one
 * round trip is ~36ms, so a 1s poll can only ever land near +500ms (about 4th).
 * Polling every 50ms across the couple of seconds either side of the deadline
 * shrinks the window in which the day can flip unnoticed to under 100ms.
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

    await api.postCheckIn();
    const postedAt = Date.now();

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
  } catch (e) {
    if (e instanceof SessionExpiredError) {
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
    const err = e as Error & { code?: string };
    // A premature attempt is rejected by the server — that is exactly what we retry.
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
  before: CheckInStatus,
): Promise<CheckInStatus | null> {
  let last: CheckInStatus | null = null;
  let confirmed: CheckInStatus | null = null;
  for (let i = 0; i < 3; i++) {
    const s = await api.getCheckInStatus().catch(() => null);
    if (s) {
      last = s;
      if (s.todayCheckedIn) {
        confirmed = s;
        if ((s.currentStreak ?? 0) > (before.currentStreak ?? 0)) return s;
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
