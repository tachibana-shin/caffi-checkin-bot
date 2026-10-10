import type { Bot } from "grammy";
import { config } from "./config.ts";
import { store } from "./store.ts";
import { createBot, type Sender, senderFor } from "./telegram.ts";

export interface Booted {
  /** grammY instance — polling mode registers its handlers on this one. */
  bot: Bot;
  /** Delivers cards to Telegram. */
  tg: Sender;
  /** Routes a chat id to the platform it belongs to. */
  fanOut: Sender;
}

let pending: Promise<Booted> | undefined;

/**
 * Load the store and stand up both adapters — exactly once per isolate.
 *
 * The HTTP path and the cron path share this: a `Deno.cron` handler may wake an
 * isolate that has never served a request, and an isolate serving a request may
 * later be asked to run the midnight check-in.
 */
export function boot(): Promise<Booted> {
  pending ??= create();
  return pending;
}

async function create(): Promise<Booted> {
  await store.load();

  const bot = createBot(config.botToken);
  const tg = senderFor(bot);

  const fanOut: Sender = {
    async send(chatId, card, opts) {
      await tg.send(String(chatId), card, opts).catch(logSend);
    },
  };

  return { bot, tg, fanOut };
}

function logSend(e: unknown) {
  console.error("[send] failed:", e);
}
