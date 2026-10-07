/**
 * Applies the app icon extracted from the Caffi APK (`assets/logo.png`) to the
 * bot's identity on both platforms.
 *
 *   deno task logo
 *
 * Discord takes the avatar of the bot user over its REST API. Two pictures stay
 * out of reach of their respective APIs — Telegram's bot photo and Discord's
 * application icon (that one wants a *user* token, a bot gets
 * `403 Bots cannot use this endpoint`) — so the script prints where to upload
 * them instead of pretending it worked.
 */
import { config } from "../src/config.ts";
import { createBot } from "../src/telegram.ts";

// The bot user's avatar: square, small enough for a chat list.
const DISCORD_AVATAR = new URL("../assets/logo-256.png", import.meta.url);
// The application's own icon (Developer Portal → General Information). Discord
// wants at least 512×512 here, hence the unresized file.
const DISCORD_APP_ICON = new URL("../assets/logo.png", import.meta.url);

/** Base64 without spreading the buffer: `String.fromCharCode(...png)` blows the argument cap. */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

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

  const headers = {
    authorization: `Bot ${config.discordToken}`,
    "content-type": "application/json",
  };

  // Two different pictures, two different endpoints: the avatar belongs to the
  // bot *user* (what people see in a chat), the icon to the *application*
  // (Developer Portal, and any embedded app surface).
  const avatar = await patch(
    "https://discord.com/api/v10/users/@me",
    headers,
    { avatar: dataUri(await Deno.readFile(DISCORD_AVATAR)) },
    "avatar",
  );
  if (avatar) console.log(`Discord: avatar set for ${avatar.username} (${avatar.id})`);

  // The application icon cannot go the same way: `PATCH /oauth2/applications/@me`
  // wants a *user* token and answers a bot token with
  // `403 {"code":20001,"message":"Bots cannot use this endpoint"}`.
  console.log("Discord: application icon: the Bot API cannot set it.");
  console.log("    Developer Portal → your app → General Information → App Icon.");
  console.log(`    upload ${DISCORD_APP_ICON.pathname} (512×512 PNG).`);
}

function dataUri(png: Uint8Array): string {
  return `data:image/png;base64,${toBase64(png)}`;
}

async function patch(
  url: string,
  headers: Record<string, string>,
  body: Record<string, string>,
  what: string,
): Promise<{ id?: string; username?: string; icon?: string | null } | null> {
  const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    console.error(`Discord: ${what} update failed — ${res.status} ${await res.text()}`);
    return null;
  }
  return await res.json() as { id?: string; username?: string; icon?: string | null };
}

if (import.meta.main) await main();
