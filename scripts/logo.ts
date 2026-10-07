/**
 * Applies the app icon extracted from the Caffi APK (`assets/logo.png`) to the
 * bot's identity on both platforms.
 *
 *   deno task logo
 *
 * Discord takes the picture over its REST API. Telegram does not: the Bot API
 * has no call for the bot's own photo, so that one stays with @BotFather —
 * this script prints the exact command instead of pretending it worked.
 */
import { config } from "../src/config.ts";
import { createBot } from "../src/telegram.ts";

const DISCORD_LOGO = new URL("../assets/logo-256.png", import.meta.url);

const NAME = "Caffi Điểm Danh";
const DESCRIPTION = "Tự động điểm danh Caffi đúng 00:00 mỗi ngày, báo ngay khi bị đăng xuất. " +
  "Quản lý nhiều tài khoản trong một chat. Gõ /start để bắt đầu.";
const SHORT = "Điểm danh Caffi lúc 00:00 mỗi ngày · đa tài khoản";

async function main() {
  await setTelegram();
  await setDiscord();
}

async function setTelegram() {
  const bot = createBot(config.botToken);
  await bot.init();
  console.log(`Telegram: @${bot.botInfo.username}`);

  console.log(`  setMyName: ${await bot.api.setMyName(NAME)}`);
  console.log(`  setMyDescription: ${await bot.api.setMyDescription(DESCRIPTION)}`);
  console.log(`  setMyShortDescription: ${await bot.api.setMyShortDescription(SHORT)}`);

  // No Bot API method changes the bot's own picture — only BotFather can.
  console.log("  profile photo: the Bot API cannot set it.");
  console.log("    send assets/logo.png to @BotFather and run /setuserpic there.");
}

async function setDiscord() {
  if (!config.discordToken) {
    console.log("Discord: skipped (DISCORD_TOKEN is empty)");
    return;
  }

  const png = await Deno.readFile(DISCORD_LOGO);
  const b64 = btoa(String.fromCharCode(...png));
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    method: "PATCH",
    headers: {
      authorization: `Bot ${config.discordToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ avatar: `data:image/png;base64,${b64}` }),
  });

  if (!res.ok) {
    console.error(`Discord: avatar update failed — ${res.status} ${await res.text()}`);
    return;
  }
  const body = await res.json() as { username: string; id: string };
  console.log(`Discord: avatar set for ${body.username} (${body.id})`);
}

if (import.meta.main) await main();
