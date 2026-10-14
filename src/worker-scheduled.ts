/**
 * The `scheduled` side of the Worker: `Deno.cron` has no equivalent here, so
 * wrangler's `[triggers]` fire the same two jobs and this handler runs them.
 *
 * It used to wake `/race` over HTTP, because Smart Placement only applies to
 * fetch handlers. That never worked: a Worker cannot subrequest itself — the
 * `workers.dev` hostname answers 404 and a custom domain answers 522, both of
 * which leave the cron invocation reporting success while the check-in never
 * happened (2026-10-11: the pre-roll ran at 23:56:26, "Success", 41.8ms CPU,
 * and the day's check-in landed at 00:14:55 — by hand). So the race runs here.
 *
 * The pre-roll is the reason a nap exists. Cron has minute resolution and
 * every scheduler measured so far is late by tens of seconds — Cloudflare by
 * ~28s (17:28:00 fired at 17:28:30), cron-job.org by up to 64s (00:00:00
 * fired at 00:01:04, which is the two days the check-in went out at 00:01).
 * Firing three minutes early makes all of that free: the handler warms the
 * connections, sleeps until the window opens, and only then races. A cron
 * invocation may run 15 minutes of wall time for 10ms of CPU, and sleeping
 * costs none of it.
 *
 * Placement only holds for fetch handlers, so this path is unplaced — that
 * costs a slower round trip, never a later trigger, and the trigger is what
 * the ranking is made of.
 */
import { apiFor, sleep } from "./checkin.ts";
import { boot } from "./boot.ts";
import {
  catchUpCronSpec,
  createRunner,
  preRollCronSpec,
  preRollNap,
  recordRun,
  type RunReport,
} from "./scheduler.ts";
import { store } from "./store.ts";
import type { ScheduledController, WorkerEnv } from "./worker.ts";

export async function handleScheduled(controller: ScheduledController, _env: WorkerEnv) {
  const cron = controller.cron;
  const job = jobFor(cron);
  const startedAt = Date.now();

  try {
    await boot();
  } catch (e) {
    // Before, this returned without leaving a trace — the one failure mode
    // that looked exactly like "the trigger never fired".
    console.error("[scheduled] boot failed:", e);
    await recordRun({
      job,
      via: "cron",
      cron,
      firedAt: new Date(startedAt).toISOString(),
      error: `boot: ${e instanceof Error ? e.message : String(e)}`,
      ms: Date.now() - startedAt,
    }).catch(() => {});
    return;
  }

  // One read per account before anything else: it measures how far this
  // isolate is from the Caffi servers and pays the connection setup now, while
  // the second is still worth nothing — the first request a fresh isolate makes
  // costs ~1.1s (module graph, DNS, TLS) against ~100-400ms warm, which is
  // larger than the whole race.
  //
  // Everything here is an optimisation, so it is fenced off: a warm-up that
  // throws must cost a slow round trip, never the run itself.
  let rttMs: number | null = null;
  let napMs = 0;
  try {
    rttMs = await warmConnections();
    if (job === "pre-roll") {
      napMs = preRollNap();
      if (napMs > 0) {
        console.log(`⏰ pre-roll: napping ${Math.round(napMs / 1000)}s for the window to open`);
        await sleep(napMs);
        // The connections idled for minutes and a server may have dropped them —
        // re-warm while the window is still closed, so any handshake is paid at
        // 23:59:55 and never at 00:00:00.
        rttMs = (await warmConnections()) ?? rttMs;
      }
    }
  } catch (e) {
    console.error("[scheduled] warm-up/nap failed, racing anyway:", e);
  }

  try {
    const { fanOut } = await boot();
    const report: RunReport | null = await createRunner(fanOut).tick(job === "catch-up");
    // The day markers first: a trace written twice is history, a marker lost
    // with the isolate is a whole day.
    await store.flush();

    await recordRun({
      job,
      via: "cron",
      cron,
      firedAt: new Date(startedAt).toISOString(),
      napMs,
      rttMs,
      report,
      doneDate: store.data.lastAutoRunDoneDate,
      ms: Date.now() - startedAt,
    });

    const outcome = report === null
      ? "skipped"
      : report.allDone
      ? `booked ${report.date}`
      : `unfinished: ${report.unfinished.join("; ")}`;
    console.log(
      `🏁 ${job} done in ${
        Date.now() - startedAt
      }ms · nap ${napMs}ms · rtt ${rttMs}ms · ${outcome}`,
    );
  } catch (e) {
    console.error("[scheduled] race failed:", e);
    await recordRun({
      job,
      via: "cron",
      cron,
      firedAt: new Date(startedAt).toISOString(),
      napMs,
      rttMs,
      doneDate: store.data.lastAutoRunDoneDate,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - startedAt,
    }).catch(() => {});
  }
}

/**
 * One status read per auto account, in parallel.
 *
 * Besides the timing, this is where a dropped session shows up while there is
 * still a minute to report it, rather than inside the race.
 */
async function warmConnections(): Promise<number | null> {
  const targets = store.autoAccounts();
  if (!targets.length) return null;
  const startedAt = Date.now();
  await Promise.all(
    targets.map(({ account }) =>
      apiFor(account).getCheckInStatus().catch((e) => {
        console.error("[scheduled] warm-up read failed:", e);
      })
    ),
  );
  return Date.now() - startedAt;
}

/** Which of the two registered cron expressions just fired. */
function jobFor(cron: string): "pre-roll" | "catch-up" {
  return cron === catchUpCronSpec() ? "catch-up" : "pre-roll";
}

/** Exported so the specs stay in one place for the drift check. */
export const CRON_SPECS = { preRollCronSpec, catchUpCronSpec };
