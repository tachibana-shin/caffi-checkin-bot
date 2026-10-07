import { boot } from "./boot.ts";
import { config } from "./config.ts";
import { sleep } from "./checkin.ts";
import {
  catchUpCronSpec,
  createRunner,
  msUntilWindow,
  preRollCronSpec,
  runShopeeDaily,
  shopeeCatchUpCronSpec,
  shopeeCronSpec,
} from "./scheduler.ts";
import { store } from "./store.ts";

/**
 * `Deno.cron` has to be registered while the module is being evaluated.
 *
 * Deno Deploy discovers the schedule when it builds a revision, and the Deno
 * CLI only tracks cron jobs registered during start-up — both need this file
 * imported for its side effect, before anything awaits.
 *
 * The jobs are in UTC because that is all cron speaks; Vietnam is UTC+7 all
 * year, so the specs above translate the local schedule once here.
 */
function registerCron(): void {
  Deno.cron(
    "caffi-checkin-pre-roll",
    preRollCronSpec(),
    { backoffSchedule: [1000, 5000] },
    async () => {
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

  // Shopee: no nap and no race, so both jobs fire on the minute. The first is
  // midnight; the second covers a day the server had not rolled over yet.
  Deno.cron(
    "shopee-checkin",
    shopeeCronSpec(),
    { backoffSchedule: [1000, 5000] },
    () => runShopee(false),
  );
  Deno.cron(
    "shopee-checkin-catch-up",
    shopeeCatchUpCronSpec(),
    { backoffSchedule: [1000, 5000] },
    () => runShopee(true),
  );

  console.log(
    `⏰ Cron: ${preRollCronSpec()} (pre-roll) · ${catchUpCronSpec()} (catch-up) UTC` +
      ` · ${shopeeCronSpec()} (shopee) · ${shopeeCatchUpCronSpec()} (shopee catch-up)`,
  );
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

async function runShopee(force: boolean): Promise<void> {
  try {
    const { fanOut } = await boot();
    await runShopeeDaily(fanOut, force);
  } catch (e) {
    console.error("[cron] shopee run failed:", e);
  }
}

if (config.runtimeMode === "webhook") {
  if (typeof Deno.cron === "function") registerCron();
  else console.warn("⚠️ Deno.cron is unavailable — the check-in will not be scheduled.");
}
