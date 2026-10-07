import type { Bot } from "grammy";
import { boot, type Booted } from "./boot.ts";
import { type Ctx, handleNav, handleText } from "./commands.ts";
import { config } from "./config.ts";
import { startScheduler } from "./scheduler.ts";
import { store } from "./store.ts";
import { ensureWebhook, type Sender, webhookHandler } from "./telegram.ts";
// Imported for its side effect: `Deno.cron` must be registered while the module
// is still being evaluated (Deno Deploy discovers the schedule at build time).
import "./cron.ts";

/**
 * Both transports share the store, the scheduler and the command handlers —
 * only delivery differs. `polling` is the local shape (grammY long polling +
 * Discord gateway + an interval scheduler); `webhook` is the Deno Deploy shape
 * (HTTP endpoint + `Deno.cron`), because Deno Deploy runs several isolated
 * instances at once and two polling loops or two gateways would fight.
 */
async function main() {
  console.log("🚀 Caffi Auto Check-in Bot");

  const booted = await boot();
  console.log(
    `💾 Store: Deno KV${config.deploy ? " (platform)" : ` at ${config.dataDir}/store.kv`}` +
      (store.encrypted ? " · AES-256-GCM" : " · PLAINTEXT (set BOT_SECRET!)"),
  );

  const { bot, tg, fanOut } = booted;
  await bot.init();
  console.log(`🤖 Logged in to Telegram as @${bot.botInfo.username}`);

  registerHandlers(bot, tg);

  if (config.runtimeMode === "webhook") {
    await startWebhook(booted);
  } else {
    await warnIfWebhookSet(bot);
    startScheduler(fanOut);
    startPolling(bot);
  }
}

/**
 * Handlers are identical in both modes — grammY routes updates either way.
 * Exported for `scripts/deploycheck.ts`, which feeds the webhook callback
 * through the very same wiring the deployed app uses.
 */
export function registerHandlers(bot: Bot, tg: Sender) {
  // Private chats only: the login/OTP flow is strictly 1:1.
  bot.on("message:text", async (ctx) => {
    const msg = ctx.message;
    if (msg.chat.type !== "private") return;

    const cmdCtx: Ctx = {
      tg,
      chatId: `tg:${msg.chat.id}`,
      userId: msg.from?.id ?? msg.chat.id,
      raw: msg.text,
    };

    try {
      await handleText(cmdCtx);
    } catch (e) {
      console.error(`[cmd] failed on "${msg.text.slice(0, 40)}":`, e);
      await tg.send(`tg:${msg.chat.id}`, {
        icon: "❌",
        title: "Có lỗi xảy ra",
        subtitle: "Thử lại sau ít phút.",
        tone: "error",
      }).catch(() => {});
    }

    await store.flush();
  });

  // Menu buttons redraw the message they came from instead of posting a new one.
  bot.on("callback_query:data", async (ctx) => {
    const query = ctx.callbackQuery;
    const data = query.data;
    if (!data.startsWith("nav:")) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    const chat = query.message?.chat;
    if (!chat || chat.type !== "private") {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    // Answer first: the button must stop spinning even if the command fails.
    await ctx.answerCallbackQuery().catch(() => {});

    const cmdCtx: Ctx = {
      tg,
      chatId: `tg:${chat.id}`,
      userId: ctx.from?.id ?? chat.id,
      raw: "",
      editMessageId: query.message?.message_id,
    };

    try {
      await handleNav(cmdCtx, data);
    } catch (e) {
      console.error(`[nav] failed on "${data}":`, e);
    }

    await store.flush();
  });

  // Middleware errors must not take the transport down with them.
  bot.catch((err) => console.error(`[grammy] update ${err.ctx.update.update_id}:`, err.error));
}

/**
 * Deno Deploy: one HTTP endpoint plus two cron jobs.
 *
 * The handler is created once and reused — grammY's webhook adapter is a
 * closure over the bot, not a per-request factory.
 */
async function startWebhook({ bot, discord }: Booted) {
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
    if (pathname === "/discord") {
      if (!discord) return new Response("Discord is not configured", { status: 503 });
      return await discord.handleInteractions(req);
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
