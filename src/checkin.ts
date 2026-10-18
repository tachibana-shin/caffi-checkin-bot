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
 * This is the fallback cadence, `runCheckIn`'s retry loop — the nightly batch
 * does not poll at all (it fires the blind grid below). It decides how fast a
 * run that lost the grid notices that the day has opened: 50ms across the two
 * seconds either side of the deadline, then 1s for the first 20s, then 10s, so
 * a slow server costs nothing.
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
 * The blind grid — how the nightly race is won.
 *
 * Reading the flip cannot be fast enough. The day only turns inside a status
 * response, so a POST sent when a read *shows* the flip leaves one full round
 * trip after the server has already opened its day: measured 15-18 Oct 2026,
 * the read-then-POST race landed +582ms..+1215ms past midnight while first
 * place on the leaderboard sat at +263ms. Midnight itself needs no reading — it
 * is `vnMidnightMs(runDate)`, a fixed instant on the clock — so the batch does
 * not wait for the flip to be *seen*; it *arrives* at it. Each account fires a
 * short grid of POSTs across midnight: every shot that lands before the flip
 * answers "đã điểm danh hôm nay" (the previous day is still today, and it is
 * done), and the first shot that lands after it *is* the check-in. What bounds
 * the arrival is the grid spacing, not the round trip — a 90ms connection and a
 * 265ms one score the same instant.
 *
 * The geometry, midnight at T:
 *   - the first shot leaves `SPRINT_LEAD_MS` before T, so a server clock ahead
 *     of ours is still scored;
 *   - shots follow every `SPRINT_GAP_MS`, `SPRINT_SHOTS` of them, so a server
 *     clock behind by a second still finds a shot after the flip;
 *   - the next account's grid is offset half a gap, so two accounts interleave
 *     instead of doubling up on the same instants.
 *
 * The grid sounds trigger-happy; it is not. Every shot but the winner costs one
 * rejected duplicate lookup, and a shot that answers 200 cancels the rest. A
 * grid that never sees 200 falls back to read-and-post, which is what keeps a
 * clock surprise from losing the day.
 *
 * One wrinkle the grid cannot ignore: a 200 only says "the day the server calls
 * today is booked", and before the flip its today is *yesterday*. If yesterday
 * was missed, the first shot books **it** — and standing down there skips the
 * night. So one status read goes out before the grid ("is yesterday already
 * booked?", normally yes) and decides whether a 200 can be trusted; when it
 * cannot, the shot's own `history[].checkInDate` decides before the grid stands
 * down.
 */
const SPRINT_LEAD_MS = 900;
const SPRINT_GAP_MS = 200;
const SPRINT_STAGGER_MS = SPRINT_GAP_MS / 2;
const SPRINT_SHOTS = 10;

/**
 * Epoch-ms instants one account's blind POSTs leave, with midnight at `targetMs`.
 *
 * `startedAtMs` is when the run entered the grid: normally seconds before
 * midnight, so the first shot waits for `T - SPRINT_LEAD_MS`. A run that starts
 * *late* (a slow wake-up, a re-run already near the hour) anchors the grid at
 * "now" instead — it still crosses midnight, it just has less runway.
 */
export function sprintShots(targetMs: number, startedAtMs: number, slot: number): number[] {
  const base = Math.max(startedAtMs, targetMs - SPRINT_LEAD_MS) + slot * SPRINT_STAGGER_MS;
  return Array.from({ length: SPRINT_SHOTS }, (_, k) => base + k * SPRINT_GAP_MS);
}

/** "+"/"-" sign of a delta in ms, for the grid log. */
const signed = (ms: number): string => `${ms >= 0 ? "+" : ""}${ms}`;

/**
 * One account's grid, from the first shot to a confirmed check-in.
 *
 * The grid is blind — no read stands between the clock and a shot — but one
 * read goes out before it, five seconds early and off the critical path: it
 * asks whether yesterday is already booked, which is what makes a 200
 * readable. When it cannot be answered, the fallback is to verify each 200's
 * `history[].checkInDate` instead of trusting it.
 */
async function sprintCheckIn(
  account: Account,
  runDate: string,
  slot: number,
  deadline: number,
): Promise<CheckInResult> {
  const api = apiFor(account);
  const targetMs = vnMidnightMs(runDate);
  const shots = sprintShots(targetMs, Date.now(), slot);
  /** Set once the grid is decided — a 200, a dead session, a rate limit. */
  let settled = false;
  let winPostedAt: number | undefined;
  let fatal: CheckInResult | undefined;

  // Resolves long before the first shot, and answers "may a 200 be read as the
  // new day?". A dead session stands the grid down here; anything else says
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

  const fire = async (k: number) => {
    const delay = shots[k]! - Date.now();
    if (delay > 0) await sleep(delay);
    if (settled) return;
    const postedAt = Date.now();
    const mark = signed(postedAt - targetMs);
    try {
      await api.postCheckIn();
      // 200 — but of *which* day? If yesterday was already booked, every shot
      // before the flip must have been answered "already done", so this one can
      // only have landed after it. Otherwise it may have booked yesterday.
      if (winPostedAt === undefined) {
        if (await trusted) {
          winPostedAt = postedAt;
          settled = true;
          console.log(`[sprint] ${account.username} #${k + 1} ${mark}ms → OPEN`);
        } else {
          const s = await api.getCheckInStatus().catch(() => null);
          const day = s ? lastCheckInDate(s) : undefined;
          if (day !== undefined && day >= runDate) {
            winPostedAt = postedAt;
            settled = true;
            console.log(`[sprint] ${account.username} #${k + 1} ${mark}ms → OPEN (verified)`);
          } else {
            console.log(`[sprint] ${account.username} #${k + 1} ${mark}ms → booked an earlier day`);
          }
        }
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        settled = true;
        fatal = sessionExpiredCard(e, account);
        console.log(`[sprint] ${account.username} #${k + 1} ${mark}ms → session gone`);
        return;
      }
      const err = e as Error & { code?: string };
      if (err.code === "RATE_LIMITED") {
        settled = true;
        fatal = failedCard(err);
        console.log(`[sprint] ${account.username} #${k + 1} ${mark}ms → rate limited`);
        return;
      }
      // "Hôm nay bạn đã điểm danh rồi" is what every shot before the flip must
      // answer, and a transport blip is tolerated the same way: keep the grid.
      // A 200 whose response was lost is settled by the fallback read.
      const label = err.message.includes("điểm danh") ? "already" : (err.code ?? err.message);
      console.log(`[sprint] ${account.username} #${k + 1} ${mark}ms → ${label}`);
    }
  };

  await Promise.all(Array.from({ length: SPRINT_SHOTS }, (_, k) => fire(k)));

  if (fatal) return fatal;
  if (winPostedAt !== undefined) {
    return await finishCheckIn(api, account, runDate, null, winPostedAt);
  }
  // The grid never landed after the flip: the server's midnight is further from
  // ours than it assumes. Read-and-post still works, just one round trip later.
  console.log(`[sprint] ${account.username}: grid exhausted, reading instead`);
  return await runCheckIn(account, { runDate, retryUntil: deadline });
}

/**
 * Check every account in around midnight, as close to the flip as possible.
 *
 * Before midnight that is one blind grid per account (see the block above),
 * all anchored to the same instants. `runCheckIn` — read, decide, maybe post —
 * stays the manual path and the fallback. Once the day is open (a catch-up
 * run, a restart, a re-run) there is no race left to win, so each account
 * answers on its own session and "already checked in" is honoured per login.
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
  // nothing to read — fire the grid under it.
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
): Promise<CheckInResult> {
  // Re-read status + balance to report the real outcome.
  const [after, wallet] = await Promise.all([
    readConfirmedStatus(api, before, runDate),
    api.getWallet().catch(() => null),
  ]);

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
