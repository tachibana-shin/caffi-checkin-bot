/**
 * Offline wiring test for the grammY side of the bot — no Telegram network calls.
 *
 * It builds a `Bot` with a fake `botInfo`, stubs `bot.api.sendMessage`, feeds
 * synthetic updates through `bot.handleUpdate`, and asserts that the router in
 * src/commands.ts answers with the expected Vietnamese message.
 *
 *   deno task wiring   (or: deno run -A scripts/wiring.ts)
 */
import type { Ctx } from "../src/commands.ts";

type Account = import("../src/types.ts").Account;

Deno.env.set("TELEGRAM_BOT_TOKEN", "123:dummy");
Deno.env.set("BOT_SECRET", "wiring-secret");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-tg");

const { escapeHtml, senderFor } = await import("../src/telegram.ts");
const { handleNav, handleText } = await import("../src/commands.ts");
const { store } = await import("../src/store.ts");
const { Bot } = await import("grammy");

await store.load();
// Keep the run idempotent: an earlier run may have left seeded logins on disk.
for (const key of Object.keys(store.data.chats)) delete store.data.chats[key];

const bot = new Bot("123:dummy", {
  botInfo: {
    id: 42,
    is_bot: true,
    first_name: "t",
    username: "caffi_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  },
});

const sent: { chatId: unknown; text: string }[] = [];
bot.api.sendMessage = ((chatId: unknown, text: string) => {
  sent.push({ chatId, text });
  return Promise.resolve({ message_id: 1, date: 0, chat: { id: 1, type: "private" } as never });
}) as never;

// Mirror the handler wiring from src/main.ts (minus the allowlist check).
const tg = senderFor(bot);
bot.on("message:text", async (ctx) => {
  const msg = ctx.message;
  if (msg.chat.type !== "private") return;
  const c: Ctx = { tg, chatId: msg.chat.id, userId: msg.from?.id ?? msg.chat.id, raw: msg.text };
  await handleText(c);
});

function update(text: string) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 999, type: "private" as const, first_name: "X" },
      from: { id: 999, is_bot: false, first_name: "X" },
      text,
    },
  };
}

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};

await bot.handleUpdate(update("/help") as never);
check("/help -> help card", sent[0]?.text.includes("Caffi Auto Check-in Bot") === true);
check("chat id passed through as number", sent[0]?.chatId === 999, String(sent[0]?.chatId));
check(
  "/help advertises the read-only commands",
  ["/orders", "/balance", "/rank", "/notify", "/deals", "/security", "/all", "/use"].every((c) =>
    sent[0]?.text.includes(c)
  ),
);

sent.length = 0;
await bot.handleUpdate(update("hello") as never);
check("plain text -> nudge to /help", sent[0]?.text.includes("/help") === true);

sent.length = 0;
await bot.handleUpdate(update("/nope") as never);
check("unknown command -> hint", sent[0]?.text.includes("không rõ") === true);

sent.length = 0;
await bot.handleUpdate(update("/status") as never);
check("/status without account -> asks for /login", sent[0]?.text.includes("/login") === true);

sent.length = 0;
await bot.handleUpdate(update("/accounts") as never);
check("/accounts empty -> asks for /login", sent[0]?.text.includes("/login") === true);

sent.length = 0;
await bot.handleUpdate(update("/all") as never);
check("/all empty -> asks for /login", sent[0]?.text.includes("/login") === true);

sent.length = 0;
await bot.handleUpdate(update("/orders") as never);
check("/orders without account -> asks for /login", sent[0]?.text.includes("/login") === true);

sent.length = 0;
await bot.handleUpdate(update("/deals") as never);
check("/deals without account -> asks for /login", sent[0]?.text.includes("/login") === true);

sent.length = 0;
await bot.handleUpdate(update("/cancel") as never);
check("/cancel without pending -> message", (sent[0]?.text.length ?? 0) > 0, sent[0]?.text);

// ── One chat, several logins ───────────────────────────────────────────────

const account = (username: string, over: Partial<Account> = {}): Account => ({
  username,
  password: "x",
  tokens: { accessToken: "a", refreshToken: "r" },
  autoCheckIn: true,
  sessionInvalid: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const chat = store.chat(999);
chat.activeAccount = "a@test";
chat.accounts = {
  "a@test": account("a@test", { displayName: "Người A" }),
  "b@test": account("b@test", { sessionInvalid: true, invalidReason: "TOKEN_INVALID" }),
};
store.touch();

sent.length = 0;
await bot.handleUpdate(update("/accounts") as never);
check(
  "/accounts lists every login",
  sent[0]?.text.includes("a@test") === true && sent[0]?.text.includes("b@test") === true,
);

// `b@test` is the dead session, so this answers straight from the store. Had
// the *active* login (a@test) been picked instead, the API would have been
// called and this assertion would fail.
sent.length = 0;
await bot.handleUpdate(update("/status b@test") as never);
check(
  "/status <tên> reads that login, not the active one",
  sent[0]?.text.includes("Phiên đã bị đăng xuất") === true &&
    sent[0]?.text.includes("b@test") === true,
  sent[0]?.text.slice(0, 60),
);

sent.length = 0;
await bot.handleUpdate(update("/status c@test") as never);
check(
  "/status <tên lạ> reports the unknown login",
  sent[0]?.text.includes("Không có tài khoản này") === true,
);

sent.length = 0;
await handleNav({ tg, chatId: 999, userId: 999, raw: "" }, "nav:use b@test");
check("nav:use <tên> switches the active login", store.chat(999).activeAccount === "b@test");
const redrawn = sent.map((s) => s.text).join("\n");
const bLine = redrawn.split("\n").find((l) => l.includes("b@test")) ?? "";
check("…and redraws the list with ▶ on the new one", bLine.includes("▶"), bLine.slice(0, 40));

// A chat whose logins are all expired can render the roll-up offline.
const dead = store.chat(888);
dead.accounts = {
  "x@test": account("x@test", { sessionInvalid: true, invalidReason: "TOKEN_INVALID" }),
  "y@test": account("y@test", { sessionInvalid: true, invalidReason: "TOKEN_INVALID" }),
};
dead.activeAccount = "x@test";
store.touch();

sent.length = 0;
await handleNav({ tg, chatId: 888, userId: 888, raw: "" }, "nav:all");
check(
  "nav:all renders the roll-up for every login",
  sent.some((s) => s.text.includes("Tất cả tài khoản") && s.text.includes("y@test")),
);

console.log("\nescapeHtml:", escapeHtml(`<&>"`));
console.log(failed ? `${failed} FAILED` : "all wiring OK");
Deno.exit(failed ? 1 : 0);
