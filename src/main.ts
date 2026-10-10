import type { Bot } from "grammy";
import { boot, type Booted } from "./boot.ts";
import { config } from "./config.ts";
import { startScheduler } from "./scheduler.ts";
import { store } from "./store.ts";
import { ensureWebhook, webhookHandler } from "./telegram.ts";
// Imported for its side effect: `Deno.cron` must be registered while the module
// is still being evaluated (Deno Deploy discovers the schedule at build time).
import "./cron.ts";

/**
 * Every shape shares the store, the scheduler and the command handlers — only
 * delivery differs. `polling` is the local shape (grammY long polling plus an
 * interval scheduler); `webhook` and `worker` are the two serverless shapes
 * (an HTTP endpoint plus a cron), because both hosts run several isolated
 * instances at once and two polling loops would fight.
 */
async function main() {
  console.log("🚀 Caffi Auto Check-in Bot");

  const booted = await boot();
  console.log(
    `💾 Store: ${
      config.runtimeMode === "worker" ? "D1 (Cloudflare)" : `${config.dataDir}/store.kv`
    }` +
      (store.encrypted ? " · AES-256-GCM" : " · PLAINTEXT (set BOT_SECRET!)"),
  );

  const { bot, fanOut } = booted;
  console.log(`🤖 Logged in to Telegram as @${bot.botInfo.username}`);

  if (config.runtimeMode === "webhook") {
    await startWebhook(booted);
  } else {
    await warnIfWebhookSet(bot);
    startScheduler(fanOut);
    startPolling(bot);
  }
}

/**
 * Deno Deploy: one HTTP endpoint plus two cron jobs.
 *
 * The handler is created once and reused — grammY's webhook adapter is a
 * closure over the bot, not a per-request factory.
 */
async function startWebhook({ bot }: Booted) {
  const telegram = webhookHandler(bot);

  if (config.publicUrl) {
    await ensureWebhook(bot).catch((e) => console.error("[webhook] setWebhook failed:", e));
  } else {
    console.warn("⚠️ PUBLIC_URL is not set — Telegram will have nowhere to deliver updates.");
  }

  Deno.serve({
    port: config.port,
    onListen: ({ port }) => console.log(`🌐 Listening on :${port}`),
  }, async (req) => {
    const { pathname } = new URL(req.url);

    if (pathname === "/telegram") return await telegram(req);
    if (pathname === "/probe") {
      // TEMPORARY: how far this isolate is from the Caffi servers.
      const { apiFor } = await import("./checkin.ts");
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
    if (pathname === "/" || pathname === "/healthz") {
      return new Response("caffi check-in bot", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  });
}

/** grammY owns retries and backoff; it rethrows 401 (bad token) and 409 (conflict). */
function startPolling(bot: Bot) {
  bot.start({ allowed_updates: ["message", "callback_query"] }).catch((e) => {
    if ((e as { error_code?: number }).error_code === 409) {
      console.error("❌ Conflict: another instance is already polling. Exiting.");
    } else {
      console.error(`[poll] ${e?.message ?? e} — giving up.`);
    }
    Deno.exit(1);
  });
}

/** Long polling and a webhook are mutually exclusive; say so instead of 409-ing. */
async function warnIfWebhookSet(bot: Bot) {
  const info = await bot.api.getWebhookInfo().catch(() => undefined);
  if (info?.url) {
    console.warn(
      `⚠️ Telegram still has a webhook (${info.url}).\n` +
        `   Run \`deno task webhook off\` before long polling.`,
    );
  }
}

async function shutdown() {
  console.log("\n🛑 Shutting down...");
  try {
    await store.flush();
  } catch (e) {
    console.error(e);
  }
  Deno.exit(0);
}

// Deno.serve owns graceful shutdown on Deploy; only polling needs a handler.
if (config.runtimeMode === "polling") {
  Deno.addSignalListener("SIGINT", () => void shutdown());
  Deno.addSignalListener("SIGTERM", () => void shutdown());
}

if (import.meta.main) {
  await main();
}
