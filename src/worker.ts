/**
 * Cloudflare Workers entry point.
 *
 * Two shapes, one codebase. `fetch` serves the same endpoints Deno Deploy did
 * (Telegram webhook, Discord interactions, health) and `/race`, which is the
 * midnight check-in. `scheduled` replaces `Deno.cron`.
 *
 * The split matters because of **placement**: Smart Placement holds the isolate
 * in the Cloudflare colo closest to the Caffi servers in Vietnam, but it only
 * applies to `fetch` handlers. The Caffi API is a single VNPT address, so
 * Cloudflare can triangulate it — and the race is a knock loop, one POST per
 * round trip, so the placement's shorter round trip buys a tighter race.
 *
 * A Worker cannot subrequest itself (`workers.dev` answers 404, a custom domain
 * 522), so the cron handler does not "wake `/race`": it runs the race right
 * there, unplaced. `/race` is the placed path for an external scheduler that
 * can hit it (cron-job.com).
 *
 * The dynamic imports are deliberate. workerd has no `Deno.env`, so the config
 * has to be pointed at the `env` binding *before* any module reads it, and a
 * dynamic import is the only place that ordering can be guaranteed. It also
 * keeps the cold-start module graph to what each handler actually needs.
 */
import { useEnv } from "./env.ts";
import type { D1Like } from "./records.ts";

/** `env` plus the bindings wrangler injects for this app. */
export type WorkerEnv = Record<string, string | undefined> & { caffi: D1Like };

/** What wrangler hands the `scheduled` handler (the rest of `workers-types` is not needed). */
export interface ScheduledController {
  cron: string;
  type: "scheduled";
  scheduledTime: number;
  noRetry(): void;
}

/** Hands the runtime's bindings to the config and the store. */
function install(env: WorkerEnv): void {
  useEnv(env);
  (globalThis as { __caffiDb?: D1Like }).__caffiDb = env.caffi;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    install(env);
    const { handleFetch } = await import("./worker-fetch.ts");
    return await handleFetch(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    install(env);
    const { handleScheduled } = await import("./worker-scheduled.ts");
    // A cron handler may run for 15 minutes; the isolated work below can outlive
    // the response.
    ctx.waitUntil(handleScheduled(controller, env));
  },
};
