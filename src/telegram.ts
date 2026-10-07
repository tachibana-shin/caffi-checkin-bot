/**
 * Telegram side of the bot, backed by grammY.
 *
 * grammY already owns long polling, retries and update offsets; what is left
 * here is turning a `Card` into a message (with an optional button grid) and
 * the tiny `Sender` interface the command handlers and scheduler are written
 * against. Both bots depend on that interface, never on grammY itself.
 */
import { Bot, GrammyError, InlineKeyboard, webhookCallback } from "grammy";
import { config } from "./config.ts";
import { store } from "./store.ts";
import { type Card, type KeyRows, renderHtml } from "./view.ts";

export interface SendOptions {
  /** Buttons shown under the message. */
  keys?: KeyRows;
  /** Replace this message instead of sending a new one (button presses). */
  editMessageId?: number;
}

export interface Sender {
  send(chatId: number | string, card: Card, opts?: SendOptions): Promise<void>;
}

export function createBot(token: string): Bot {
  return new Bot(token);
}

/** Adapt a grammY `Bot` to the `Sender` used everywhere else. */
export function senderFor(bot: Bot): Sender {
  return {
    send: (chatId, card, opts) => sendCard(bot, chatId, card, opts),
  };
}

/**
 * Store keys are `<platform>:<id>` so the two adapters never mistake one for
 * the other (both platforms use plain numbers). Telegram only ever sees `tg:`.
 */
function chatIdParam(chatId: number | string): number | string {
  const raw = typeof chatId === "string" ? chatId.replace(/^tg:/, "") : chatId;
  return typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

function keyboard(keys?: KeyRows): InlineKeyboard | undefined {
  if (!keys?.length) return undefined;
  const kb = new InlineKeyboard();
  keys.forEach((row, i) => {
    if (i > 0) kb.row();
    for (const k of row) kb.text(k.label, k.data);
  });
  return kb;
}

async function sendCard(
  bot: Bot,
  chatId: number | string,
  card: Card,
  opts?: SendOptions,
): Promise<void> {
  const id = chatIdParam(chatId);
  const html = renderHtml(card);
  const kb = keyboard(opts?.keys);
  const other = {
    link_preview_options: { is_disabled: true },
    ...(kb ? { reply_markup: kb } : {}),
  };

  if (opts?.editMessageId !== undefined) {
    // Nothing to do when the text and the buttons are unchanged.
    await bot.api
      .editMessageText(id, opts.editMessageId, html, { parse_mode: "HTML", ...other })
      .catch((e) => {
        if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
        throw e;
      });
    return;
  }

  try {
    await bot.api.sendMessage(id, html, { parse_mode: "HTML", ...other });
  } catch (e) {
    // Safety net: retry without parse_mode when our HTML is not valid.
    if (e instanceof GrammyError && e.description.includes("can't parse entities")) {
      await bot.api.sendMessage(id, stripTags(html), other);
      return;
    }
    throw e;
  }
}

function stripTags(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

// ── Webhook (Deno Deploy) ──────────────────────────────────────────────────

/**
 * Deno Deploy runs several isolated instances at once, so long polling would
 * make them fight over `getUpdates` (Telegram answers 409 to the loser).
 * Telegram pushes to us instead, and grammY validates `X-Telegram-Bot-Api-Secret-Token`.
 */
export function webhookHandler(bot: Bot): (req: Request) => Promise<Response> {
  const handle = webhookCallback(bot, "std/http", {
    secretToken: config.webhookSecret,
    // No update is worth more than the isolate; Telegram will redeliver.
    timeoutMilliseconds: 20_000,
  });
  return async (req: Request) => await handle(req);
}

/** Point Telegram at our endpoint — skipped when another isolate already did. */
export async function ensureWebhook(bot: Bot): Promise<void> {
  const url = `${config.publicUrl}/telegram`;
  if ((await store.meta<string>("telegramWebhook")) === url) return;

  await bot.api.setWebhook(url, {
    secret_token: config.webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  await store.setMeta("telegramWebhook", url);
  console.log(`🤖 Telegram: webhook -> ${url}`);
}

/** Detach again so `deno task start` can take over with long polling. */
export async function clearWebhook(bot: Bot): Promise<void> {
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  await store.setMeta("telegramWebhook", "");
  console.log("🤖 Telegram: webhook cleared (long polling)");
}

export { escapeHtml } from "./view.ts";
