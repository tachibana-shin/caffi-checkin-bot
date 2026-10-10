import { boot } from "./boot.ts";
import { config } from "./config.ts";
import { apiFor, sleep } from "./checkin.ts";
import { catchUpCronSpec, createRunner, msUntilWindow, preRollCronSpec } from "./scheduler.ts";
import { store } from "./store.ts";

/**
 * `Deno.cron` has to be registered while the module is being evaluated.
 *
 * Deno Deploy discovers the schedule when it builds a revision, and the Deno
 * CLI only tracks cron jobs registered during start-up — both need this file
 * imported for its side effect, before anything awaits.
 *
 * The two jobs are in UTC because that is all cron speaks; Vietnam is UTC+7
 * all year, so `preRollCronSpec()` translates the local schedule once here.
 */
function registerCron(): void {
  Deno.cron(
    "caffi-checkin-pre-roll",
    preRollCronSpec(),
    { backoffSchedule: [1000, 5000] },
    async () => {
      // Pay for the cold isolate now, while the second is still worth nothing:
      // the first request a fresh isolate makes to Caffi costs ~1.1s (booting
      // modules, DNS, TLS) against ~265ms once the connection is warm, and that
      // difference is larger than the whole race. 09-10-2026 measured +1730ms
      // at the server, of which ~1.1s was this.
      await warmConnections();
      const nap = msUntilWindow(new Date());
      if (nap > 0) {
        // Cron only has minute resolution; the race needs the exact second.
        console.log(`⏰ cron: sleeping ${Math.round(nap / 1000)}s for the window to open`);
        await sleep(nap);
      }
      await run(false);
    },
  );

  // A second, later attempt for a run that started but never finished —
  // the isolate was recycled mid-flight, or the network died on us.
  Deno.cron(
    "caffi-checkin-catch-up",
    catchUpCronSpec(),
    { backoffSchedule: [1000, 5000] },
    () => run(true),
  );

  console.log(`⏰ Cron: ${preRollCronSpec()} (pre-roll) · ${catchUpCronSpec()} (catch-up) UTC`);
}

/**
 * One read per account, three minutes before the window, so the isolate, the
 * module graph and the TLS connection to Caffi are all hot by 23:59:55. Also
 * flushes out a dropped session while there is still time to report it.
 */
async function warmConnections(): Promise<void> {
  try {
    await store.load();
    const startedAt = Date.now();
    await Promise.all(
      store.autoAccounts().map(async ({ account }) => {
        await apiFor(account).getCheckInStatus().catch(() => {});
      }),
    );
    console.log(`🔥 Pre-roll warmed in ${Date.now() - startedAt}ms`);
  } catch (e) {
    console.error("[warm] failed:", e);
  }
}

async function run(force: boolean): Promise<void> {
  try {
    const { fanOut } = await boot();
    await createRunner(fanOut).tick(force);
    await store.flush();
  } catch (e) {
    console.error("[cron] run failed:", e);
  }
}

if (config.runtimeMode === "webhook") {
  if (typeof Deno.cron === "function") registerCron();
  else console.warn("⚠️ Deno.cron is unavailable — the check-in will not be scheduled.");
}
