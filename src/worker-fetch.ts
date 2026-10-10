/**
 * The HTTP side of the Worker: the Telegram webhook, a health check, and the
 * `/race` route the cron handler calls on itself.
 *
 * The routes are the same ones Deno Deploy served, so the Telegram webhook URL
 * only needs its host swapped.
 */
import type { WorkerEnv } from "./worker.ts";
import { boot } from "./boot.ts";
import { config } from "./config.ts";
import { store } from "./store.ts";

export async function handleFetch(req: Request, _env: WorkerEnv): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (pathname === "/telegram") return await telegram(req);
  if (pathname === "/race") return await race(req);
  if (pathname === "/" || pathname === "/healthz" || pathname === "/health") {
    return new Response("caffi check-in bot", { status: 200 });
  }
  if (pathname === "/probe") return await probe();
  if (pathname === "/handle") return await handleNow(req);
  return new Response("Not found", { status: 404 });
}

/** Boots the shared graph once per isolate; both webhook paths need it. */
async function booted() {
  const bootedOnce = await boot();
  // Point Telegram here once per isolate. The stored URL makes this a single
  // meta read, and it is what moves the webhook over when the host changes —
  // without it the previous host keeps every update.
  const { ensureWebhook } = await import("./telegram.ts");
  await ensureWebhook(bootedOnce.bot).catch((e) =>
    console.error("[webhook] setWebhook failed:", e)
  );
  return bootedOnce;
}

async function telegram(req: Request): Promise<Response> {
  const { bot } = await booted();
  const { webhookHandler } = await import("./telegram.ts");
  return await webhookHandler(bot)(req);
}

/**
 * The midnight check-in, as an HTTP call.
 *
 * The cron handler invokes this on itself for one reason: Smart Placement only
 * applies to fetch handlers, so running the race here is what puts the isolate
 * next to the Caffi servers instead of wherever the scheduler woke up.
 *
 * The bearer token is WORKER_SECRET (BOT_SECRET when unset). Without it anyone
 * could force a run — the store's per-day markers would stop a real double
 * check-in, but there is no reason to accept the traffic.
 */
async function race(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${config.workerSecret}`) {
    return new Response(null, { status: 401 });
  }

  const url = new URL(req.url);
  const job = url.searchParams.get("job") ?? "pre-roll";
  const { createRunner, preRollCronSpec, catchUpCronSpec } = await import("./scheduler.ts");

  const spec = job === "catch-up" ? catchUpCronSpec() : preRollCronSpec();
  const startedAt = Date.now();
  const { fanOut } = await booted();
  const runner = createRunner(fanOut);
  // `force` is what lets the catch-up job finish a run the pre-roll started but
  // never completed (an isolate recycled mid-flight).
  await runner.tick(job === "catch-up");
  await store.flush();

  const ms = Date.now() - startedAt;
  console.log(`🏁 race (${spec}) finished in ${ms}ms`);
  return new Response(`ok ${ms}ms`, { status: 200 });
}

/**
 * How far this isolate is from the Caffi servers, measured on the wire.
 *
 * Used once after a deploy to see whether Smart Placement actually moved the
 * Worker — the `cf-placement` response header also names the colo that ran it.
 */
async function probe(): Promise<Response> {
  const { apiFor } = await import("./checkin.ts");
  await store.load();
  const targets = store.autoAccounts();
  const out: string[] = [];
  for (const { account } of targets.slice(0, 1)) {
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await apiFor(account).getCheckInStatus().catch((e) => String(e));
      out.push(`${Date.now() - t}ms`);
    }
  }
  return new Response(`caffi status rtt: ${out.join(", ")}`, { status: 200 });
}
