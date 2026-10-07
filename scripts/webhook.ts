/**
 * Toggle Telegram's webhook — long polling and a webhook are mutually exclusive.
 *
 *   deno task webhook status   show what Telegram currently points at
 *   deno task webhook on       point Telegram at PUBLIC_URL/telegram (Deploy)
 *   deno task webhook off      detach it so `deno task start` can poll locally
 */
import { config } from "../src/config.ts";
import { clearWebhook, createBot, ensureWebhook } from "../src/telegram.ts";
import { store } from "../src/store.ts";

const mode = Deno.args[0] ?? "status";

const bot = createBot(config.botToken);
await bot.init();
await store.load();

if (mode === "on") {
  if (!config.publicUrl) {
    console.error("❌ PUBLIC_URL is not set — cannot build the webhook URL.");
    Deno.exit(1);
  }
  await ensureWebhook(bot);
} else if (mode === "off") {
  await clearWebhook(bot);
} else {
  const info = await bot.api.getWebhookInfo();
  console.log(
    info.url
      ? `📡 Telegram webhook: ${info.url}` +
        `\n   pending updates: ${info.pending_update_count}` +
        `\n   last error: ${info.last_error_message ?? "none"}`
      : "📡 No webhook — the bot receives updates by long polling.",
  );
}

await store.flush();
