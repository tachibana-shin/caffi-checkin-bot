import type { Bot } from "grammy";
import { config } from "./config.ts";
import { type DiscordRuntime, startDiscord, startDiscordRest } from "./discord.ts";
import { store } from "./store.ts";
import { createBot, type Sender, senderFor } from "./telegram.ts";

export interface Booted {
  /** grammY instance — polling mode registers its handlers on this one. */
  bot: Bot;
  /** Delivers cards to Telegram only. */
  tg: Sender;
  discord?: DiscordRuntime;
  /** Routes `tg:`/`ds:` chat ids to the right platform. */
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
  // Webhook mode never opens a gateway — several instances would fight over it.
  const discord = config.runtimeMode === "webhook"
    ? await startDiscordRest()
    : await startDiscord();

  const fanOut: Sender = {
    async send(chatId, card, opts) {
      const key = String(chatId);
      if (key.startsWith("ds:")) {
        if (!discord) {
          console.warn(`[send] Discord is disabled — dropped message for ${key}`);
          return;
        }
        await discord.sender.send(key, card, opts).catch(logSend);
        return;
      }
      await tg.send(key, card, opts).catch(logSend);
    },
  };

  return { bot, tg, discord, fanOut };
}

function logSend(e: unknown) {
  console.error("[send] failed:", e);
}
