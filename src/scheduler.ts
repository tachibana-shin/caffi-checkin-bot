import { config } from "./config.ts";
import { runCheckIn, sleep, vnDate, vnMidnightMs } from "./checkin.ts";
import { store } from "./store.ts";
import type { Sender } from "./telegram.ts";
import type { Card } from "./view.ts";

/** Catch-up window: if the bot restarts after the check-in time, still run (max 30 minutes). */
const CATCH_UP_MINUTES = 30;
/** The tick must be finer than CHECKIN_EARLY_SECONDS, otherwise we can wake up late. */
const TICK_MS = 500;
const SECONDS_PER_DAY = 86_400;
/** Vietnam is UTC+7 all year — no DST, so this offset never changes. */
const VN_UTC_OFFSET = 7 * 3600;
/** `Deno.cron` runs in UTC and only fires once a minute, so this is the longest nap it may take. */
const MAX_PRE_ROLL_SLEEP = 2 * 3600 * 1000;
/**
 * How far ahead of the attempt window the pre-roll job is registered.
 *
 * Deno Deploy promises only that "the exact invocation time of your `Deno.cron`
 * handler may vary by up to a minute from the scheduled time". The window opens
 * `CHECKIN_EARLY_SECONDS` before midnight, so a spec sitting in the minute right
 * before it leaves *less than a minute* of slack: the jitter eats the nap and the
 * isolate wakes up **after** the day has already turned. It did — on 2026-10-08
 * the job started at 00:00:02.8 and the check-in landed on second 6, because
 * every millisecond of the pre-roll is spent establishing the connection instead
 * of polling for the flip.
 *
 * Firing early is free: `msUntilWindow` just sleeps longer. Three minutes of lead
 * absorbs about four minutes of jitter while keeping the nap itself short.
 */
const PRE_ROLL_LEAD_SECONDS = 3 * 60;

const FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

interface VnParts {
  date: string;
  secondsOfDay: number;
}

function vnParts(d: Date): VnParts {
  const parts = FORMATTER.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  // "24" is 00:00 under ICU with hour12:false
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const second = Number(get("second"));

  return {
    date: `${year}-${month}-${day}`,
    secondsOfDay: hour * 3600 + minute * 60 + second,
  };
}

/** Seconds from `from` to the next occurrence of `to`, both in seconds-of-day space. */
function secondsUntil(from: number, to: number): number {
  const d = to - from;
  return d >= 0 ? d : d + SECONDS_PER_DAY;
}

export interface RunPlan {
  /** The VN date this attempt is checking in for. */
  runDate: string;
  /** Epoch-ms until a day the server has not opened yet may keep being retried. 0 = single attempt. */
  retryUntil: number;
  /** True when we woke up before the scheduled time (the window started on the previous day). */
  preRoll: boolean;
}

export interface ScheduleSettings {
  /** Scheduled time in seconds-of-day (0 = midnight). */
  nominalSeconds: number;
  /** How far before `nominalSeconds` the attempt starts. */
  earlySeconds: number;
  /** How long after `nominalSeconds` a not-yet-rolled day may keep being retried. */
  maxWaitSeconds: number;
}

function currentSettings(): ScheduleSettings {
  return {
    nominalSeconds: config.checkInHour * 3600 + config.checkInMinute * 60,
    earlySeconds: Math.min(Math.max(config.checkInEarlySeconds, 0), 3600),
    maxWaitSeconds: Math.max(config.checkInMaxWaitSeconds, 0),
  };
}

/**
 * Pure window arithmetic for one instant — exported so the timing can be tested
 * without waiting for midnight. Returns null when there is nothing to do.
 */
export function planRun(now: Date, s: ScheduleSettings = currentSettings()): RunPlan | null {
  // The attempt starts before the scheduled time, so the window can span midnight.
  const start = s.nominalSeconds - s.earlySeconds;
  const end = s.nominalSeconds + CATCH_UP_MINUTES * 60;
  const retryEnd = s.nominalSeconds + s.maxWaitSeconds;

  const { date, secondsOfDay: sec } = vnParts(now);

  let preRoll: boolean;
  if (start >= 0) {
    if (sec < start || sec > end) return null;
    preRoll = false;
  } else {
    preRoll = sec >= start + SECONDS_PER_DAY;
    if (!preRoll && sec > end) return null;
  }

  // The run belongs to the day being checked in — tomorrow when we start before midnight.
  const runDate = preRoll ? vnDate(new Date(now.getTime() + SECONDS_PER_DAY * 1000)) : date;

  const retryUntil = preRoll
    ? now.getTime() + secondsUntil(sec, retryEnd) * 1000
    : sec < retryEnd
    ? now.getTime() + (retryEnd - sec) * 1000
    : 0;

  return { runDate, retryUntil, preRoll };
}

// ── Cron (Deno Deploy) ─────────────────────────────────────────────────────

/** Seconds-of-day, in Vietnam, at which the attempt window opens. */
function windowStartSeconds(): number {
  const { nominalSeconds, earlySeconds } = currentSettings();
  const raw = nominalSeconds - earlySeconds;
  return ((raw % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

/**
 * A `Deno.cron` expression for a moment given in VN seconds-of-day.
 *
 * Cron has minute resolution, so this lands on the minute **before** the given
 * time — the handler then naps until the exact instant. That keeps the
 * sub-second wake-up the check-in race needs while staying inside the spec.
 */
function cronSpecAt(vnSeconds: number): string {
  const fireAt = ((vnSeconds - VN_UTC_OFFSET - 1) % SECONDS_PER_DAY + SECONDS_PER_DAY) %
    SECONDS_PER_DAY;
  const minute = Math.floor(fireAt / 60) % 60;
  const hour = Math.floor(fireAt / 3600) % 24;
  return `${minute} ${hour} * * *`;
}

/**
 * Daily 24/7: fires `PRE_ROLL_LEAD_SECONDS` before the window so the jitter of
 * the platform cannot push the wake-up past midnight; the handler naps the rest.
 */
export function preRollCronSpec(): string {
  return cronSpecAt(windowStartSeconds() - PRE_ROLL_LEAD_SECONDS);
}

/** Safety net, `CATCH_UP_MINUTES - 1` after the scheduled time. */
export function catchUpCronSpec(): string {
  return cronSpecAt(currentSettings().nominalSeconds + (CATCH_UP_MINUTES - 1) * 60);
}

/** How long to nap before the window opens. 0 when it is open already. */
export function msUntilWindow(now: Date): number {
  if (planRun(now)) return 0;
  const delta = secondsUntil(vnParts(now).secondsOfDay, windowStartSeconds()) * 1000 -
    now.getMilliseconds();
  // Already past the window (or a spec that makes no sense): just tick, it will no-op.
  return delta < 0 || delta > MAX_PRE_ROLL_SLEEP ? 0 : delta;
}

// ── Runner ─────────────────────────────────────────────────────────────────

export interface SchedulerRunner {
  /**
   * One attempt. `force` lets a catch-up run retry a day whose attempt was
   * started but never finished (the isolate was recycled, the network died).
   */
  tick(force?: boolean): Promise<void>;
}

export function createRunner(tg: Sender): SchedulerRunner {
  let running = false;

  return {
    async tick(force = false) {
      if (running) return;

      const plan = planRun(new Date());
      if (!plan) return;
      // Finished is finished — no cron, no restart, no amount of ticking re-runs it.
      if (store.data.lastAutoRunDoneDate === plan.runDate) return;
      if (!force && store.data.lastAutoRunDate === plan.runDate) return;

      running = true;
      store.data.lastAutoRunDate = plan.runDate;
      store.touch();

      try {
        await runDaily(tg, plan.runDate, plan.retryUntil);
        store.data.lastAutoRunDoneDate = plan.runDate;
        store.touch();
      } catch (e) {
        console.error(`[scheduler] run failed for ${plan.runDate}:`, e);
      } finally {
        running = false;
      }
    },
  };
}

/** The interval-driven scheduler: local mode, and the catch-up on restart. */
export function startScheduler(tg: Sender): void {
  const { earlySeconds: early, maxWaitSeconds: maxWait } = currentSettings();
  const runner = createRunner(tg);

  setInterval(() => void runner.tick(), TICK_MS);
  logReady(early, maxWait, "interval");
}

function logReady(early: number, maxWait: number, driver: string): void {
  console.log(
    `⏰ Scheduler ready (${driver}): ${String(config.checkInHour).padStart(2, "0")}:` +
      `${String(config.checkInMinute).padStart(2, "0")} ${config.timeZone} ` +
      `(wake up ${early}s early, max wait ${maxWait}s, catch-up ${CATCH_UP_MINUTES} min)`,
  );
}

/** How long a `Deno.cron` handler must nap before it can start ticking. */
export function preRollNap(): number {
  return msUntilWindow(new Date());
}

async function runDaily(tg: Sender, date: string, retryUntil: number): Promise<void> {
  const targets = store.autoAccounts();
  const invalid = store.invalidAccounts();
  if (!targets.length && !invalid.length) {
    console.log(`[scheduler] ${date}: no auto-enabled accounts.`);
    return;
  }

  console.log(
    `[scheduler] ${date}: ${targets.length} check-ins, ${invalid.length} expired sessions.`,
  );

  // Only the first account polls for the flip; the rest wake up at midnight.
  //
  // The day turns on the *server's* clock, so one status read after it is as
  // good as a hundred — having every account run the 50ms loop would multiply
  // the request rate by the number of logins (straight into rate-limit
  // territory) without landing a single POST any earlier. Waking them together
  // keeps all of them within one round trip of each other, instead of queueing
  // each one behind the previous account's status read-back and Telegram send.
  const midnight = vnMidnightMs(date);
  await Promise.all(targets.map(async ({ chatId, account }, index) => {
    // Optional stagger — leave CHECKIN_JITTER_MAX at 0 to stay first in line.
    const jitter = Math.floor(Math.random() * Math.max(0, config.checkInJitterMax) * 1000);
    if (jitter > 0) await sleep(jitter);
    // A run that starts after midnight (catch-up, restart) must not wait at all.
    if (index > 0) await sleep(Math.max(0, midnight - Date.now()));

    const r = await runCheckIn(account, { runDate: date, retryUntil });
    console.log(`[scheduler] ${account.username}: ${r.outcome}`);
    // The whole pre-roll exists to land this POST as close to 00:00 as it can.
    if (r.postedAt !== undefined) {
      const delta = r.postedAt - midnight;
      console.log(
        `[scheduler] ${account.username}: POST ${delta >= 0 ? "+" : ""}${delta}ms after 00:00`,
      );
    }

    if (r.outcome === "already_done") return;
    const stamp = `${String(config.checkInHour).padStart(2, "0")}:` +
      `${String(config.checkInMinute).padStart(2, "0")}`;
    await safeSend(tg, chatId, {
      ...r.card,
      // Keep the account visible: one chat may hold several Caffi logins.
      subtitle: [account.username, r.card.subtitle].filter(Boolean).join(" · "),
      footer: `⏰ Tự động ${stamp} · ${config.timeZone}`,
    });
  }));

  // Dropped session: remind every 24h until the user sends /login again.
  for (const { chatId, account } of invalid) {
    const last = account.lastInvalidRemindAt ?? 0;
    if (Date.now() - last < 24 * 60 * 60 * 1000) continue;
    account.lastInvalidRemindAt = Date.now();
    store.touch();
    console.log(`[scheduler] ${account.username}: re-login reminder`);
    await safeSend(tg, chatId, {
      icon: "🔒",
      title: `${account.username} đang bị đăng xuất`,
      subtitle: account.invalidReason ?? "Phiên hết hạn",
      tone: "error",
      blocks: [{ text: "Gõ /login để bot tiếp tục tự điểm danh." }],
      footer: "Bot sẽ KHÔNG tự điểm danh cho tới khi bạn đăng nhập lại.",
    });
  }
}

async function safeSend(tg: Sender, chatId: string, card: Card) {
  try {
    await tg.send(chatId, card);
  } catch (e) {
    console.error(`[scheduler] failed to send to ${chatId}:`, e);
  }
}
