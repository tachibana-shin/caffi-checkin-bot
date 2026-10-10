/**
 * The `scheduled` side of the Worker: `Deno.cron` has no equivalent here, so
 * wrangler's `[triggers]` fire the same two jobs and this handler routes them.
 *
 * It does one round trip of work itself — booting the isolate — and then hands
 * the actual check-in to `/race` over HTTP. That is not indirection for its own
 * sake: Smart Placement only applies to fetch handlers, and the Caffi servers
 * are a single VNPT address in Vietnam. A cron invocation runs wherever
 * Cloudflare had a spare machine (~265ms away on Deno Deploy's `ord`/`ams`);
 * a fetch runs in the colo closest to the API it is about to call.
 */
import { boot } from "./boot.ts";
import { config } from "./config.ts";
import { catchUpCronSpec, preRollCronSpec } from "./scheduler.ts";
import type { ScheduledController, WorkerEnv } from "./worker.ts";

export async function handleScheduled(controller: ScheduledController, _env: WorkerEnv) {
  const cron = controller.cron;
  const job = jobFor(cron);

  // Boot first: the store read and the Telegram getMe are each a round trip, and
  // neither should be paid at 00:00.
  try {
    await boot();
  } catch (e) {
    console.error("[scheduled] boot failed:", e);
    return;
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(`${config.publicUrl}/race?job=${job}`, {
      headers: { authorization: `Bearer ${config.workerSecret}` },
    });
    const placement = res.headers.get("cf-placement") ?? "unknown colo";
    console.log(
      `⏰ ${job} (${cron}) -> ${res.status} in ${Date.now() - startedAt}ms · ${placement}`,
    );
  } catch (e) {
    console.error(`[scheduled] ${job} failed:`, e);
  }
}

/** Which of the two registered cron expressions just fired. */
function jobFor(cron: string): "pre-roll" | "catch-up" {
  if (cron === catchUpCronSpec()) return "catch-up";
  return "pre-roll";
}

/** Exported for the cron-spec drift check in `scripts/check-cron.ts`. */
export const CRON_SPECS = { preRollCronSpec, catchUpCronSpec };
