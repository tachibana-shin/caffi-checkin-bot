/**
 * The `scheduled` side of the Worker: `Deno.cron` has no equivalent here, so
 * wrangler's `[triggers]` fire the same two jobs and this handler runs them.
 *
 * It used to wake `/race` over HTTP, because Smart Placement only applies to
 * fetch handlers. That never worked: a Worker cannot subrequest itself — the
 * `workers.dev` hostname answers 404 and a custom domain answers 522, both of
 * which leave the cron invocation reporting success while the check-in never
 * happened (2026-10-11: the pre-roll ran at 23:56:26, "Success", 41.8ms CPU,
 * and the day's check-in landed at 00:14:55 — by hand). So the race runs here,
 * unplaced, and every run leaves a record in the store so the next one can be
 * checked without needing the platform's logs.
 */
import { apiFor } from "./checkin.ts";
import { boot } from "./boot.ts";
import { createRunner } from "./scheduler.ts";
import { store } from "./store.ts";
import { catchUpCronSpec, preRollCronSpec } from "./scheduler.ts";
import type { ScheduledController, WorkerEnv } from "./worker.ts";

export async function handleScheduled(controller: ScheduledController, _env: WorkerEnv) {
  const cron = controller.cron;
  const job = jobFor(cron);
  const startedAt = Date.now();

  try {
    await boot();
  } catch (e) {
    console.error("[scheduled] boot failed:", e);
    return;
  }

  // One read, before anything else: how far this isolate is from the Caffi
  // servers. It warms the connection too, which a cold isolate otherwise pays
  // for during the race (~1.1s against ~150ms warm).
  let rttMs: number | null = null;
  const target = store.autoAccounts()[0];
  if (target) {
    const t = Date.now();
    try {
      await apiFor(target.account).getCheckInStatus();
      rttMs = Date.now() - t;
    } catch (e) {
      console.error("[scheduled] warm-up read failed:", e);
    }
  }

  try {
    const { fanOut } = await boot();
    await createRunner(fanOut).tick(job === "catch-up");
    await store.flush();

    const run = {
      job,
      cron,
      at: new Date().toISOString(),
      rttMs,
      doneDate: store.data.lastAutoRunDoneDate,
      ms: Date.now() - startedAt,
    };
    await store.setMeta("cron:lastRun", run);
    console.log(`🏁 ${job} done in ${run.ms}ms · rtt ${rttMs}ms · day ${run.doneDate}`);
  } catch (e) {
    console.error("[scheduled] race failed:", e);
    await store.setMeta("cron:lastError", {
      job,
      cron,
      at: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    }).catch(() => {});
  }
}

/** Which of the two registered cron expressions just fired. */
function jobFor(cron: string): "pre-roll" | "catch-up" {
  return cron === catchUpCronSpec() ? "catch-up" : "pre-roll";
}

/** Exported so the specs stay in one place for the drift check. */
export const CRON_SPECS = { preRollCronSpec, catchUpCronSpec };
