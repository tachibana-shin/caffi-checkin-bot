import type { Bot } from "grammy";
import { type Ctx, handleNav, handleText } from "./commands.ts";
import { store } from "./store.ts";
import type { Sender } from "./telegram.ts";

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
