/**
 * Offline tests for the scheduler's timing rules — no network, no waiting for midnight.
 *
 * Covers (1) the window arithmetic in `planRun` (wake-up boundary, catch-up,
 * giving up), (2) `decideFromStatus`, the rule that tells "the server has not
 * opened the new day yet" apart from "already checked in", and (3) `pollDelay`,
 * the cadence that decides how fast the bot notices the day has flipped.
 * Vietnam is UTC+7 with no DST, so wall times below are exact.
 *
 *   deno task timing
 */
Deno.env.set("TELEGRAM_BOT_TOKEN", "timing-test-token");
Deno.env.set("BOT_SECRET", "timing-secret");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-timing");

const { planRun, shopeeCatchUpCronSpec, shopeeCronSpec } = await import("../src/scheduler.ts");
const { checkedInAtOf, decideFromStatus, pollDelay, vnMidnightMs } = await import(
  "../src/checkin.ts"
);
type ScheduleSettings = import("../src/scheduler.ts").ScheduleSettings;
type CheckInStatus = import("../src/types.ts").CheckInStatus;

/** A Date for a wall-clock time in Vietnam (UTC+7, no DST). */
const atVN = (y: number, mo: number, d: number, h: number, mi: number, s = 0): Date =>
  new Date(Date.UTC(y, mo - 1, d, h - 7, mi, s));

/** Midnight, waking up 5s early, retrying for up to 10 minutes. */
const MIDNIGHT: ScheduleSettings = { nominalSeconds: 0, earlySeconds: 5, maxWaitSeconds: 600 };
/** Same, but no early wake-up. */
const EXACT: ScheduleSettings = { nominalSeconds: 0, earlySeconds: 0, maxWaitSeconds: 600 };
/** A non-midnight schedule: 08:00, 5s early. */
const EIGHT_AM: ScheduleSettings = {
  nominalSeconds: 8 * 3600,
  earlySeconds: 5,
  maxWaitSeconds: 600,
};

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
}

function secondsLeft(plan: ReturnType<typeof planRun>, now: Date): number | null {
  return plan ? Math.round((plan.retryUntil - now.getTime()) / 1000) : null;
}

// ── Wake-up boundary ─────────────────────────────────────────────────────
{
  const before = atVN(2026, 10, 6, 23, 59, 54);
  check("23:59:54 — still 1s too early", planRun(before, MIDNIGHT) === null);

  const at = atVN(2026, 10, 6, 23, 59, 55);
  const p = planRun(at, MIDNIGHT);
  check("23:59:55 — attempt window opens", p !== null);
  check("23:59:55 — pre-roll is on", p?.preRoll === true);
  check("23:59:55 — targets tomorrow", p?.runDate === "2026-10-07", p?.runDate);
  check(
    "23:59:55 — retries until 00:10:00",
    secondsLeft(p, at) === 605,
    String(secondsLeft(p, at)),
  );
}

// ── The day must not be double-run across midnight ───────────────────────
{
  const pre = planRun(atVN(2026, 10, 6, 23, 59, 59), MIDNIGHT);
  const post = planRun(atVN(2026, 10, 7, 0, 0, 3), MIDNIGHT);
  check(
    "same runDate on both sides of midnight (no double run)",
    pre?.runDate !== undefined && pre.runDate === post?.runDate,
    `${pre?.runDate} vs ${post?.runDate}`,
  );
}

// ── Right after midnight ─────────────────────────────────────────────────
{
  const at = atVN(2026, 10, 7, 0, 0, 0);
  const p = planRun(at, MIDNIGHT);
  check("00:00:00 — in window", p !== null);
  check("00:00:00 — pre-roll off", p?.preRoll === false);
  check("00:00:00 — retries for 600s", secondsLeft(p, at) === 600, String(secondsLeft(p, at)));

  const at3 = atVN(2026, 10, 7, 0, 0, 3);
  check("00:00:03 — retries for 597s", secondsLeft(planRun(at3, MIDNIGHT), at3) === 597);

  const at959 = atVN(2026, 10, 7, 0, 9, 59);
  check("00:09:59 — 1s of retry left", secondsLeft(planRun(at959, MIDNIGHT), at959) === 1);
}

// ── Give-up deadline and catch-up window ─────────────────────────────────
{
  check(
    "00:10:00 — deadline reached, single attempt from now on",
    planRun(atVN(2026, 10, 7, 0, 10, 0), MIDNIGHT)?.retryUntil === 0,
  );
  check(
    "00:15:00 — still inside catch-up, but no retrying left",
    planRun(atVN(2026, 10, 7, 0, 15, 0), MIDNIGHT)?.retryUntil === 0,
  );
  check(
    "00:30:01 — catch-up window closed",
    planRun(atVN(2026, 10, 7, 0, 30, 1), MIDNIGHT) === null,
  );
  check("12:00:00 — nothing to do", planRun(atVN(2026, 10, 6, 12, 0, 0), MIDNIGHT) === null);
}

// ── CHECKIN_EARLY_SECONDS=0 keeps the old behaviour ──────────────────────
{
  check("early=0: 23:59:59 does not run", planRun(atVN(2026, 10, 6, 23, 59, 59), EXACT) === null);
  const p = planRun(atVN(2026, 10, 7, 0, 0, 0), EXACT);
  check("early=0: 00:00:00 runs for 2026-10-07", p?.runDate === "2026-10-07", p?.runDate);
}

// ── Non-midnight schedules ───────────────────────────────────────────────
{
  const early = atVN(2026, 10, 7, 7, 59, 55);
  const p = planRun(early, EIGHT_AM);
  check("08:00 schedule: wakes at 07:59:55", p !== null);
  check("08:00 schedule: same-day runDate", p?.runDate === "2026-10-07", p?.runDate);
  check(
    "08:00 schedule: retries 605s",
    secondsLeft(p, early) === 605,
    String(secondsLeft(p, early)),
  );
  check(
    "08:00 schedule: 07:59:54 is too early",
    planRun(atVN(2026, 10, 7, 7, 59, 54), EIGHT_AM) === null,
  );
}

// ── Check-in decision: "day not open yet" vs "already done" ──────────────
{
  const status = (todayCheckedIn: boolean, dates: string[]): CheckInStatus => ({
    todayCheckedIn,
    history: dates.map((checkInDate) => ({ checkInDate })),
  });

  check(
    "new day is open -> POST",
    decideFromStatus(status(false, []), "2026-10-07") === "check_in",
  );
  check(
    "pre-roll: newest entry is yesterday -> retry",
    decideFromStatus(status(true, ["2026-10-06"]), "2026-10-07") === "pending_day",
  );
  check(
    "newest entry is the target day -> already done",
    decideFromStatus(status(true, ["2026-10-07", "2026-10-06"]), "2026-10-07") === "already_done",
  );
  check(
    "target day reached -> already done (same-day /checkin)",
    decideFromStatus(status(true, ["2026-10-06"]), "2026-10-06") === "already_done",
  );
  check(
    "history order does not matter",
    decideFromStatus(status(true, ["2026-10-05", "2026-10-06"]), "2026-10-07") === "pending_day" &&
      decideFromStatus(status(true, ["2026-10-05", "2026-10-06"]), "2026-10-06") === "already_done",
  );
  check(
    "checked in but no history yet -> retry rather than give up",
    decideFromStatus(status(true, []), "2026-10-07") === "pending_day",
  );
}

// ── Poll cadence around the deadline ─────────────────────────────────────
{
  const target = vnMidnightMs("2026-10-07");
  check(
    "vnMidnightMs is 17:00 UTC on the eve",
    target === Date.UTC(2026, 9, 6, 17, 0, 0),
    new Date(target).toISOString(),
  );
  check("vnMidnightMs rejects a malformed date", Number.isNaN(vnMidnightMs("nonsense")));

  // The bot woke at 23:59:55, five seconds before `target`.
  const start = target - 5_000;
  const at = (offsetMs: number) => pollDelay(target, target + offsetMs, start);

  check("23:59:59 — inside the fine window, 50ms", at(-1_000) === 50, String(at(-1_000)));
  check("23:59:58.001 — fine window opens", at(-1_999) === 50, String(at(-1_999)));
  check("23:59:58 — just outside, 1s", at(-2_001) === 1_000, String(at(-2_001)));
  check("00:00:00 — deadline itself, 50ms", at(0) === 50, String(at(0)));
  check("00:00:01.999 — still fine", at(1_999) === 50, String(at(1_999)));
  check("00:00:02.001 — fine window closed, 1s", at(2_001) === 1_000, String(at(2_001)));
  check("00:00:25 — race over, 10s", at(25_000) === 10_000, String(at(25_000)));
  check("00:25:00 — catch-up run, 10s", at(1_500_000) === 10_000, String(at(1_500_000)));

  // A catch-up run started long after midnight must not enter the fine window.
  const lateStart = target + 900_000;
  check(
    "late start — never polls at 50ms",
    pollDelay(target, lateStart + 500, lateStart) === 1_000,
    String(pollDelay(target, lateStart + 500, lateStart)),
  );
}

// ── Reporting the check-in time from the server's own record ─────────────
{
  const s: CheckInStatus = {
    history: [{ checkInDate: "2026-10-07", createdAt: "2026-10-06T17:13:05.192Z" }],
  };
  const got = checkedInAtOf(s);
  check(
    "checkedInAtOf renders the UTC record in VN time",
    got !== undefined && got.includes("00:13:05"),
    String(got),
  );
  check("checkedInAtOf with no history -> undefined", checkedInAtOf({}) === undefined);
  check("checkedInAtOf with no history array -> undefined", checkedInAtOf(null) === undefined);
}

// ── Shopee: two jobs that fire *on* the minute, not the minute before ─────
{
  // Caffi's specs land one second early so `msUntilWindow` can nap into the
  // exact second; Shopee has no race to win and must not nap past midnight.
  check("shopee runs at 00:00 VN = 17:00 UTC", shopeeCronSpec() === "0 17 * * *", shopeeCronSpec());
  check(
    "shopee catch-up runs at 00:30 VN = 17:30 UTC",
    shopeeCatchUpCronSpec() === "30 17 * * *",
    shopeeCatchUpCronSpec(),
  );
  check("…neither is pulled a minute early", !shopeeCronSpec().startsWith("59"));
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll OK");
Deno.exit(failed ? 1 : 0);
