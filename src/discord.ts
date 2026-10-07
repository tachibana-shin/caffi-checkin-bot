/**
 * Discord side of the bot, backed by discordeno.
 *
 * The same command handlers run here as on Telegram — they only ever see a
 * `Ctx` and a `Sender`. What differs is delivery: a slash command is deferred
 * the moment it arrives (Discord allows three seconds to answer, and these
 * handlers talk to the Caffi API), then edited into the finished card. A menu
 * button redraws the message it was attached to.
 *
 * Everything is ephemeral: each user sees only their own card, even when they
 * run a command in a server.
 */
import {
  type ActionRow,
  ApplicationCommandOptionTypes,
  type Bot,
  ButtonStyles,
  type CreateApplicationCommand,
  createBot,
  createDesiredPropertiesObject,
  type DesiredPropertiesBehavior,
  DiscordInteractionContextType,
  Intents,
  type Interaction,
  type InteractionCallbackData,
  InteractionTypes,
  type MessageComponent,
  MessageComponentTypes,
  type SetupDesiredProps,
} from "@discordeno/bot";
import { type Ctx, handleNav, handleText } from "./commands.ts";
import { config } from "./config.ts";
import { store } from "./store.ts";
import type { Card, KeyRows } from "./view.ts";
import { toEmbed } from "./view.ts";
// The `Sender` interface lives next to the Telegram adapter; both bots speak it.
import type { Sender, SendOptions } from "./telegram.ts";

/** Only the fields the bot actually reads — discordeno omits the rest entirely. */
const desiredProperties = createDesiredPropertiesObject({
  interaction: {
    id: true,
    type: true,
    token: true,
    data: true,
    user: true,
    guildId: true,
    channelId: true,
  },
  user: { id: true, username: true, globalName: true },
});

/**
 * The shapes discordeno derives from `desiredProperties`. Anything we did not
 * ask for does not exist at runtime either, so the aliases keep that honest.
 */
type Props = typeof desiredProperties;
type DiscordBot = Bot<Props, DesiredPropertiesBehavior.RemoveKey>;
type DiscordInteraction = SetupDesiredProps<
  Interaction,
  Props,
  DesiredPropertiesBehavior.RemoveKey
>;

/** Commands that handle credentials — offered in DMs only, never in a server. */
const AUTH_ONLY = new Set(["login", "otp", "resend", "cancel", "shopee-login"]);

function option(
  name: string,
  description: string,
  required = false,
): { type: ApplicationCommandOptionTypes; name: string; description: string; required: boolean } {
  return { type: ApplicationCommandOptionTypes.String, name, description, required };
}

/**
 * The optional `<tên tài khoản>` argument shared by every per-account command.
 * Declared first so Discord sends it ahead of any other option — the router
 * reads arguments left to right (see `targetArgs()` in commands.ts).
 */
function accountOption() {
  return option("tai_khoan", "Tên tài khoản trong chat — bỏ trống để lấy tài khoản đang dùng");
}

/** The optional `<tên phiên>` argument, for the Shopee commands. */
function shopeeOption() {
  return option("phien", "Tên phiên Shopee — bỏ trống nếu chat chỉ có một");
}

/**
 * The slash-command list. Restarting the bot pushes it to Discord; global
 * commands can take up to an hour to appear.
 */
export const COMMANDS: CreateApplicationCommand[] = [
  { name: "start", description: "Bắt đầu với bot" },
  { name: "help", description: "Danh sách lệnh" },
  {
    name: "status",
    description: "Tổng quan điểm danh hôm nay",
    options: [accountOption()],
  },
  {
    name: "wallet",
    description: "Xèng, tiền chờ và hoa hồng",
    options: [accountOption()],
  },
  {
    name: "info",
    description: "Hồ sơ, xếp hạng và tiến độ",
    options: [accountOption()],
  },
  {
    name: "rewards",
    description: "Bảng điểm thưởng và danh mục quà",
    options: [accountOption()],
  },
  {
    name: "history",
    description: "Lịch sử điểm danh",
    options: [accountOption()],
  },
  { name: "top", description: "10 người điểm danh sớm nhất hôm nay" },
  {
    name: "checkin",
    description: "Điểm danh ngay",
    options: [accountOption()],
  },
  {
    name: "all",
    description: "Tổng hợp mọi tài khoản của chat này (chỉ đọc)",
  },
  {
    name: "orders",
    description: "Đơn hàng và hoa hồng (chỉ đọc)",
    options: [accountOption(), option("ma_don", "Mã đơn — bỏ trống để xem danh sách")],
  },
  {
    name: "balance",
    description: "Dòng tiền và lịch sử rút (chỉ đọc)",
    options: [accountOption()],
  },
  { name: "rank", description: "Bảng xếp hạng hoa hồng (chỉ đọc)" },
  {
    name: "notify",
    description: "Thông báo của bạn (chỉ đọc)",
    options: [accountOption()],
  },
  { name: "news", description: "Thông báo hệ thống (chỉ đọc)" },
  {
    name: "security",
    description: "Bảo mật và tài khoản nhận tiền (chỉ đọc)",
    options: [accountOption()],
  },
  {
    name: "invite",
    description: "Bạn đã mời và hoa hồng chia sẻ (chỉ đọc)",
    options: [accountOption()],
  },
  {
    name: "deals",
    description: "Deals cộng đồng (chỉ đọc)",
    options: [accountOption(), option("id", "ID deal — bỏ trống để xem danh sách")],
  },
  {
    name: "saved",
    description: "Sản phẩm đã lưu và nhắc mua (chỉ đọc)",
    options: [accountOption()],
  },
  { name: "shops", description: "Các sàn hoàn tiền được hỗ trợ (chỉ đọc)" },
  { name: "accounts", description: "Danh sách tài khoản đã liên kết" },
  {
    name: "auto",
    description: "Bật/tắt điểm danh tự động",
    options: [option("trang_thai", "on hoặc off"), accountOption()],
  },
  {
    name: "use",
    description: "Chọn tài khoản đang dùng",
    options: [option("ten", "Tên tài khoản", true)],
  },
  {
    name: "logout",
    description: "Xoá tài khoản khỏi bot",
    options: [option("ten", "Tên tài khoản")],
  },
  {
    name: "login",
    description: "Đăng nhập tài khoản Caffi (chỉ dùng trong tin nhắn riêng)",
    contexts: [DiscordInteractionContextType.BotDm],
    options: [
      option("ten_dang_nhap", "Tên đăng nhập app", true),
      option("mat_khau", "Mật khẩu", true),
    ],
  },
  {
    name: "otp",
    description: "Nhập mã OTP (chỉ dùng trong tin nhắn riêng)",
    contexts: [DiscordInteractionContextType.BotDm],
    options: [option("ma", "Mã 6 số", true)],
  },
  {
    name: "resend",
    description: "Gửi lại mã OTP (chỉ dùng trong tin nhắn riêng)",
    contexts: [DiscordInteractionContextType.BotDm],
  },
  {
    name: "cancel",
    description: "Huỷ phiên đăng nhập đang chờ (chỉ dùng trong tin nhắn riêng)",
    contexts: [DiscordInteractionContextType.BotDm],
  },

  // ── Shopee ──
  {
    name: "shopee",
    description: "Trạng thái điểm danh Shopee (chỉ đọc)",
    options: [shopeeOption()],
  },
  {
    name: "shopee-checkin",
    description: "Điểm danh Shopee ngay",
    options: [shopeeOption()],
  },
  {
    name: "shopee-auto",
    description: "Bật/tắt tự động điểm danh Shopee",
    options: [option("trang_thai", "on hoặc off"), shopeeOption()],
  },
  {
    name: "shopee-del",
    description: "Xoá phiên Shopee khỏi bot",
    options: [shopeeOption()],
  },
  {
    name: "shopee-login",
    description: "Dán cookie Shopee từ trình duyệt (chỉ dùng trong tin nhắn riêng)",
    contexts: [DiscordInteractionContextType.BotDm],
    options: [
      option("ten", "Tên phiên Shopee", true),
      option("cookie", "Cookie shopee.vn đã đăng nhập", true),
    ],
  },
];

export interface DiscordRuntime {
  /** Lets the scheduler DM check-in results to Discord users. */
  sender: Sender;
  /**
   * Deno Deploy path: Discord POSTs each interaction to the app's "Interactions
   * Endpoint URL" instead of pushing it down a gateway.
   */
  handleInteractions: (req: Request) => Promise<Response>;
  stop(): Promise<void>;
}

/** Start the Discord bot, or return undefined when DISCORD_TOKEN is not set. */
export async function startDiscord(): Promise<DiscordRuntime | undefined> {
  const bot = await setupBot();
  if (!bot) return undefined;
  await bot.start();
  console.log("🎮 Discord: connected (gateway)");
  return {
    sender: dmSender(bot),
    handleInteractions: interactionHandler(bot),
    stop: () => bot.shutdown(),
  };
}

/**
 * The Deno Deploy shape: no gateway at all.
 *
 * Deno Deploy runs several isolated instances of the app at once — two bots
 * would identify with the same token and invalidate each other's sessions.
 * Everything Discord sends arrives over HTTP instead, and everything we send
 * goes through the REST API, which never needed the gateway in the first place.
 */
export async function startDiscordRest(): Promise<DiscordRuntime | undefined> {
  const bot = await setupBot();
  if (!bot) return undefined;
  return {
    sender: dmSender(bot),
    handleInteractions: interactionHandler(bot),
    stop: async () => {},
  };
}

/**
 * Build the discordeno instance and wire its gateway handler — no network at
 * all. `scripts/deploycheck.ts` hands the result to `interactionHandler`, which
 * would otherwise need a live application to exist.
 */
export function createDiscordBot(): DiscordBot | undefined {
  if (!config.discordToken) return undefined;

  const bot = createBot({
    token: config.discordToken,
    ...(config.discordApplicationId ? { applicationId: config.discordApplicationId } : {}),
    desiredProperties,
    intents: Intents.Guilds | Intents.DirectMessages,
  });

  bot.events.interactionCreate = (interaction) => {
    // discordeno does not await this handler, so it has to swallow its own errors.
    void onInteraction(interaction);
  };

  return bot;
}

async function setupBot(): Promise<DiscordBot | undefined> {
  const bot = createDiscordBot();
  if (!bot) return undefined;
  await syncCommands(bot);
  return bot;
}

/** FNV-1a over the command list — changes whenever a command or option does. */
function commandVersion(): string {
  const json = JSON.stringify(COMMANDS);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${COMMANDS.length}:${hash.toString(16)}`;
}

/**
 * Push the slash-command list, but remember that we did.
 *
 * Locally that is a nicety; on Deno Deploy every cold start would otherwise
 * re-upload 28 global commands, which Discord rate-limits.
 */
async function syncCommands(bot: DiscordBot): Promise<void> {
  const version = commandVersion();
  if (!config.forceDiscordCommands && (await store.meta<string>("discordCommands")) === version) {
    return;
  }
  await bot.rest.upsertGlobalApplicationCommands(COMMANDS);
  await store.setMeta("discordCommands", version);
  console.log(`🎮 Discord: registered ${COMMANDS.length} slash commands`);
}

// ── HTTP interactions endpoint ─────────────────────────────────────────────

/** The raw body Discord posts to the interactions endpoint. */
interface RawInteraction {
  id: string;
  token: string;
  type: number;
  data?: { name?: string; custom_id?: string; options?: Array<{ name: string; value?: unknown }> };
  /** Only present on type 1 (PING) — Discord hands it out to whoever answers first. */
  challenge?: string;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  // `new ArrayBuffer` (not `new Uint8Array(n)`) keeps the buffer type concrete —
  // `crypto.subtle` refuses a `SharedArrayBuffer`-backed view.
  const out = new Uint8Array(new ArrayBuffer(hex.length >> 1));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Discord signs `timestamp + body` with the application's Ed25519 public key.
 * `crypto.subtle` supports Ed25519 in Deno, so no dependency is needed.
 */
async function verifyEd25519(
  publicKey: Uint8Array<ArrayBuffer>,
  signature: string,
  message: string,
) {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * Turns one HTTP POST from Discord into the same `interactionCreate` event the
 * gateway would have delivered — discordeno then talks REST as usual, which is
 * why the rest of this file does not know or care which transport it is on.
 *
 * The response waits for the handler: the interaction is deferred on arrival
 * (well inside Discord's three-second window) and keeping the request open is
 * what stops Deno Deploy from suspending the isolate halfway through.
 */
export function interactionHandler(bot: DiscordBot): (req: Request) => Promise<Response> {
  const publicKey = config.discordPublicKey ? hexToBytes(config.discordPublicKey) : undefined;

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response("caffi bot", { status: 200 });
    const body = await req.text();

    if (!publicKey) {
      return new Response("DISCORD_PUBLIC_KEY is not set", { status: 503 });
    }
    const signature = req.headers.get("x-signature-ed25519") ?? "";
    const timestamp = req.headers.get("x-signature-timestamp") ?? "";
    if (!(await verifyEd25519(publicKey, signature, timestamp + body))) {
      // Only worth shouting about when a signature was actually offered — an
      // empty one is a port scanner, not Discord.
      if (signature) console.error("[discord] signature rejected (DISCORD_PUBLIC_KEY mismatch?)");
      return new Response(null, { status: 401 });
    }

    let payload: RawInteraction;
    try {
      payload = JSON.parse(body) as RawInteraction;
    } catch {
      return new Response(null, { status: 400 });
    }

    // Type 1 is the PING Discord sends when the endpoint URL is saved (and now
    // and then afterwards). The challenge must come back verbatim: without it
    // Discord refuses to verify the endpoint and interactions never arrive.
    if (payload.type === 1) {
      const challenge = payload.challenge ?? "";
      console.log(`[discord] ping from Discord — challenge ${challenge ? "echoed" : "missing"}`);
      return jsonResponse({ type: 1, challenge });
    }

    // The endpoint always answers: a 5xx would only make Discord redeliver the
    // same interaction, and there is nothing to retry. Whatever went wrong has
    // already been logged.
    //
    // discordeno builds the user out of `member.user ?? user`, so a payload
    // carrying neither throws before any handler can run.
    let interaction: DiscordInteraction;
    try {
      interaction = bot.transformers.interaction(
        bot,
        {
          interaction: payload,
          shardId: 0,
        } as unknown as Parameters<typeof bot.transformers.interaction>[1],
      );
    } catch (e) {
      console.error("[discord] payload could not be transformed:", e);
      return new Response(null, { status: 204 });
    }

    try {
      await onInteraction(interaction);
    } catch (e) {
      console.error("[discord] interaction failed:", e);
    }
    return new Response(null, { status: 204 });
  };
}

async function onInteraction(interaction: DiscordInteraction): Promise<void> {
  try {
    await route(interaction);
  } catch (e) {
    console.error("[discord] interaction failed:", e);
    await interaction
      .respond({ content: "❌ Có lỗi xảy ra. Thử lại sau ít phút." }, { isPrivate: true })
      .catch(() => {});
  } finally {
    await store.flush();
  }
}

async function route(interaction: DiscordInteraction): Promise<void> {
  // Not transformed when the payload had no user — nothing we can do with it.
  if (!interaction.user) return;
  const userId = interaction.user.id;
  const chatId = `ds:${userId}`;
  const tg = interactionSender(interaction);
  const ctx: Ctx = { tg, chatId, userId: String(userId), raw: "" };

  // Remember the DM channel so the scheduler can reach this user later.
  if (interaction.guildId === undefined && interaction.channelId !== undefined) {
    const chat = store.chat(chatId);
    const channelId = String(interaction.channelId);
    if (chat.discordDmChannelId !== channelId) {
      chat.discordDmChannelId = channelId;
      store.touch();
    }
  }

  if (interaction.type === InteractionTypes.ApplicationCommand) {
    // Acknowledge immediately — the handlers talk to the Caffi API and Discord
    // only grants three seconds for the first response.
    await interaction.defer(true);

    const name = interaction.data?.name ?? "";
    // Belt and braces: `contexts` already hides these outside DMs.
    if (AUTH_ONLY.has(name) && interaction.guildId !== undefined) {
      await tg.send(chatId, dmOnlyCard());
      return;
    }
    const args = (interaction.data?.options ?? []).map((o) => String(o.value ?? ""));
    ctx.raw = args.length ? `/${name} ${args.join(" ")}` : `/${name}`;
    await handleText(ctx);
    return;
  }

  if (interaction.type === InteractionTypes.MessageComponent) {
    const customId = interaction.data?.customId ?? "";
    if (customId.startsWith("nav:")) {
      await handleNav(ctx, customId);
      return;
    }
    await tg.send(chatId, dmOnlyCard());
  }
}

function dmOnlyCard(): Card {
  return {
    icon: "🔒",
    title: "Chỉ dùng trong tin nhắn riêng",
    subtitle: "Mở chat với bot rồi gõ lại lệnh này.",
    tone: "warn",
    blocks: [{ text: "Thông tin tài khoản không được phép xuất hiện trong server." }],
  };
}

// ── Delivery ───────────────────────────────────────────────────────────────

/** Turn a card plus its buttons into a Discord interaction callback payload. */
function payload(card: Card, keys?: KeyRows): InteractionCallbackData {
  return {
    embeds: [toEmbed(card)],
    ...(keys?.length ? { components: toComponents(keys) } : {}),
  };
}

/** Buttons become one action row each — Discord caps both at five. */
function toComponents(keys: KeyRows): MessageComponent[] {
  const rows: MessageComponent[] = [];
  for (const row of keys.slice(0, 5)) {
    const buttons = row.slice(0, 5).map((k) => ({
      type: MessageComponentTypes.Button,
      style: ButtonStyles.Secondary,
      label: k.label.slice(0, 80),
      customId: k.data.slice(0, 100),
    }));
    if (!buttons.length) continue;
    rows.push({
      type: MessageComponentTypes.ActionRow,
      // The slices above guarantee the 1–5 button tuple Discord requires.
      components: buttons as unknown as ActionRow["components"],
    });
  }
  return rows;
}

/**
 * A `Sender` bound to one interaction.
 *
 * First card: edit the deferred response (or, for a menu button, the message
 * the button lives on). Anything after that becomes an ephemeral follow-up.
 */
function interactionSender(interaction: DiscordInteraction): Sender {
  const isComponent = interaction.type === InteractionTypes.MessageComponent;
  let delivered = false;

  return {
    async send(_chatId, card, opts?: SendOptions) {
      const body = payload(card, opts?.keys);

      if (card.progress && !delivered && !isComponent) {
        // Discord already shows a loading state — no need to flash a message.
        return;
      }

      if (!delivered) {
        delivered = true;
        if (isComponent) await interaction.edit(body);
        else if (!interaction.acknowledged) await interaction.respond(body, { isPrivate: true });
        else await interaction.edit(body); // deferred slash command
        return;
      }

      // Follow-ups keep the ephemeral flag set by the first response.
      await interaction.respond(body, { isPrivate: true });
    },
  };
}

/**
 * Delivery to a user who is not interacting right now (the midnight check-in).
 * Resolves their DM channel: remembered from the last DM, otherwise created.
 */
function dmSender(bot: DiscordBot): Sender {
  const cache = new Map<string, string>();

  return {
    async send(chatId, card, opts?: SendOptions) {
      const userId = String(chatId).replace(/^ds:/, "");
      const remembered = store.chat(chatId).discordDmChannelId;
      const channelId = cache.get(userId) ?? remembered ?? await createDm(bot, userId);
      cache.set(userId, channelId);

      await bot.helpers.sendMessage(channelId, {
        embeds: [toEmbed(card)],
        ...(opts?.keys?.length ? { components: toComponents(opts.keys) } : {}),
      });
    },
  };
}

async function createDm(bot: DiscordBot, userId: string): Promise<string> {
  const channel = await bot.rest.post<{ id: string }>("/users/@me/channels", {
    body: { recipient_id: userId },
  });
  return String(channel.id);
}
