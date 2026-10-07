/**
 * Live rehearsal of the pre-midnight race — runs the REAL production path
 * (`planRun` -> `runCheckIn` retry loop) against your account.
 *
 * It waits until the attempt window opens, then performs exactly ONE check-in:
 * the same one the scheduler would do at 00:00. Requires tokens produced by
 * `scripts/test-login.ts verify <otp>`.
 *
 *   deno run -A scripts/race.ts
 *
 * Prints how far from 00:00 VN the winning POST went out.
 */
import type { Account } from "../src/types.ts";
import type { RunPlan } from "../src/scheduler.ts";

Deno.env.set("TELEGRAM_BOT_TOKEN", "race-test-token");
Deno.env.set("BOT_SECRET", "race-secret");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-race");

const CHALLENGE_FILE = "/tmp/opencode/caffi-challenge.json";
const VN_OFFSET_MS = 7 * 3600 * 1000;

const { runCheckIn, nowVn, sleep } = await import("../src/checkin.ts");
const { planRun } = await import("../src/scheduler.ts");
const { renderPlain } = await import("../src/view.ts");

const saved = JSON.parse(await Deno.readTextFile(CHALLENGE_FILE));
if (!saved.tokens) {
  console.error("No tokens — run scripts/test-login.ts first");
  Deno.exit(1);
}

const account: Account = {
  username: saved.user,
  password: saved.pass,
  tokens: {
    accessToken: saved.tokens.accessToken,
    refreshToken: saved.tokens.refreshToken,
  },
  autoCheckIn: true,
  sessionInvalid: false,
  createdAt: new Date().toISOString(),
};

/** The midnight (VN) closest to `now`, as epoch ms. Vietnam is UTC+7, no DST. */
function nearestMidnight(now: Date): number {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const startOfDay = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) -
    VN_OFFSET_MS;
  const endOfDay = startOfDay + 24 * 3600 * 1000;
  return now.getTime() - startOfDay <= endOfDay - now.getTime() ? startOfDay : endOfDay;
}

async function waitForWindow(): Promise<RunPlan> {
  for (;;) {
    const plan = planRun(new Date());
    if (plan) return plan;
    await sleep(250);
  }
}

const midnight = nearestMidnight(new Date());
console.log(`Midnight: ${new Date(midnight).toISOString()} (00:00 VN)`);
console.log(`Now     : ${nowVn()} — waiting for the attempt window...`);

const plan = await waitForWindow();
const offsetMs = Date.now() - midnight;
console.log(
  `Window open at ${nowVn()} — ${offsetMs >= 0 ? "+" : ""}${(offsetMs / 1000).toFixed(1)}s ` +
    `relative to 00:00 VN (preRoll=${plan.preRoll}, runDate=${plan.runDate})`,
);

const t0 = performance.now();
const r = await runCheckIn(account, { runDate: plan.runDate, retryUntil: plan.retryUntil });
const postMs = r.postedAt === undefined ? null : r.postedAt - midnight;
const doneMs = Date.now() - midnight;

console.log(
  `\nDone in ${Math.round(performance.now() - t0)}ms — outcome=${r.outcome}\n` +
    `POST went out at ${
      postMs === null ? "unknown" : `${postMs >= 0 ? "+" : ""}${postMs}ms`
    } relative to 00:00 VN (run returned at +${doneMs}ms)`,
);
console.log(renderPlain(r.card));

// Keep the rotated tokens so the next run does not have to log in again.
const rotated = account.tokens.accessToken !== saved.tokens.accessToken ||
  account.tokens.refreshToken !== saved.tokens.refreshToken;
if (rotated) {
  await Deno.writeTextFile(
    CHALLENGE_FILE,
    JSON.stringify({ ...saved, tokens: account.tokens }),
  );
  console.log(`(tokens were rotated — written back to ${CHALLENGE_FILE})`);
}
