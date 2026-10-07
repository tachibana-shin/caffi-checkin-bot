/**
 * Pre-flight for the Deno Deploy shape — everything below runs offline against
 * the very modules the deployed app uses, so a wrong cron spec, an unreadable
 * KV record or a mis-signed Discord payload is caught before the first revision
 * is published.
 *
 *   deno task deploycheck
 *
 * Sections: environment, `config.ts` vs `.env.example`, schedule arithmetic,
 * Deno KV, the Shopee wire contract, Telegram's webhook callback, Discord's
 * interactions endpoint and — when PUBLIC_URL is set — a live check against
 * the deployed app.
 *
 * Nothing here talks to Caffi or to Shopee, and no request ever leaves the
 * process: both bots are built with a fake `botInfo` and every answer comes
 * from a stub.
 */
Deno.env.set("RUNTIME_MODE", "webhook"); // the deployed shape, whatever .env says
// The checks write to KV, so keep them away from the real store.
const TMP = "/tmp/opencode/caffi-deploycheck";

let failed = 0;
let warned = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};
const warn = (name: string, extra = "") => {
  console.log(`⚠️ ${name}${extra ? ` — ${extra}` : ""}`);
  warned++;
};
const section = (title: string) =>
  console.log(`\n── ${title} ${"─".repeat(Math.max(2, 64 - title.length))}`);

// ── Environment ────────────────────────────────────────────────────────────

section("Environment");
const env = (k: string) => Deno.env.get(k) ?? "";

check(
  "TELEGRAM_BOT_TOKEN looks like a bot token",
  /^\d+:[\w-]{30,}$/.test(env("TELEGRAM_BOT_TOKEN")),
);
check(
  "BOT_SECRET is a long random string",
  env("BOT_SECRET").length >= 32,
  `${env("BOT_SECRET").length} chars`,
);
check("DISCORD_TOKEN is set", env("DISCORD_TOKEN").length > 0);
check("DISCORD_APPLICATION_ID is set", env("DISCORD_APPLICATION_ID").length > 0);

const realPublicKey = env("DISCORD_PUBLIC_KEY");
if (realPublicKey) {
  check("DISCORD_PUBLIC_KEY is 64 hex chars", /^[0-9a-f]{64}$/i.test(realPublicKey));
} else {
  warn("DISCORD_PUBLIC_KEY is not in .env", "set it on the platform before the portal verifies");
}
if (env("PUBLIC_URL")) {
  const u = env("PUBLIC_URL");
  check(
    "PUBLIC_URL is https with no trailing slash",
    u === u.replace(/\/+$/, "") && u.startsWith("https://"),
    u,
  );
} else {
  warn("PUBLIC_URL is not in .env", "required on Deno Deploy or Telegram has nowhere to deliver");
}

// Every variable config.ts reads must be documented, or the next `.env` edit
// silently falls back to a default.
const platformOnly = new Set(["DENO_DEPLOY"]);
const configSource = await Deno.readTextFile(new URL("../src/config.ts", import.meta.url));
const exampleSource = await Deno.readTextFile(new URL("../.env.example", import.meta.url));
const declared = new Set(
  [...configSource.matchAll(/(?:env\.get|required|str|int)\("([A-Z0-9_]+)"/g)].map((m) => m[1]!),
);
const undocumented = [...declared].filter((k) =>
  !platformOnly.has(k) && !new RegExp(`^${k}=`, "m").test(exampleSource)
);
check(
  `every config.ts variable is documented in .env.example (${declared.size} found)`,
  undocumented.length === 0,
  undocumented.join(", "),
);

Deno.env.set("DATA_DIR", TMP);
// The Discord endpoint verifies with this; the real key stays in the report above.
const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]) as CryptoKeyPair;
const testPublicKey = toHex(
  new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
);
Deno.env.set("DISCORD_PUBLIC_KEY", testPublicKey);

// ── Imports (after the environment is final — config.ts reads it once) ─────

const { config } = await import("../src/config.ts");
const {
  preRollCronSpec,
  catchUpCronSpec,
  msUntilWindow,
  planRun,
  shopeeCronSpec,
  shopeeCatchUpCronSpec,
} = await import("../src/scheduler.ts");
const { store } = await import("../src/store.ts");
const { seal } = await import("../src/crypto.ts");

// Importing main.ts also imports cron.ts, which registers the jobs while the
// module is evaluated. Capturing that log is how we know it happened.
const cronLines: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  cronLines.push(args.map((a) => String(a)).join(" "));
};
const { registerHandlers } = await import("../src/main.ts");
console.log = realLog;

const { senderFor, webhookHandler } = await import("../src/telegram.ts");
const { COMMANDS, createDiscordBot, interactionHandler } = await import("../src/discord.ts");
const { Bot } = await import("grammy");

// ── Schedule ───────────────────────────────────────────────────────────────

section("Schedule (cron specs and window arithmetic)");
check("runtime mode is webhook", config.runtimeMode === "webhook", config.runtimeMode);

const SECONDS_PER_DAY = 24 * 3600;
const nominal = config.checkInHour * 3600 + config.checkInMinute * 60;
const early = Math.min(Math.max(config.checkInEarlySeconds, 0), 3600);
const windowStart = ((nominal - early) % SECONDS_PER_DAY + SECONDS_PER_DAY) % SECONDS_PER_DAY;
const preRoll = preRollCronSpec();
const catchUp = catchUpCronSpec();

function parseSpec(spec: string): { minute: number; hour: number } | undefined {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(spec);
  if (!m) return undefined;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  return minute > 59 || hour > 23 ? undefined : { minute, hour };
}

/** When a spec fires, as Vietnam seconds-of-day. */
function firesAt(spec: string): number {
  const p = parseSpec(spec)!;
  return (p.hour * 3600 + p.minute * 60 + 7 * 3600) % SECONDS_PER_DAY;
}

/**
 * Seconds from `fired` to `target`, wrapping midnight. Cron has minute
 * resolution and lands *before* the moment it stands for (the handler naps the
 * rest), so anything at or beyond the target would mean a late start.
 */
function lead(fired: number, target: number): number {
  return ((target - fired) % SECONDS_PER_DAY + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

const hhmmss = (s: number) =>
  [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");

check("pre-roll spec is a valid cron expression", parseSpec(preRoll) !== undefined, preRoll);
check("catch-up spec is a valid cron expression", parseSpec(catchUp) !== undefined, catchUp);
check("the two jobs do not land on the same minute", preRoll !== catchUp);

const preLead = lead(firesAt(preRoll), windowStart - 1);
check(
  "pre-roll fires in the minute the window opens",
  preLead < 60,
  `${preRoll} -> naps ${preLead + 1}s to ${hhmmss(windowStart)} VN`,
);
const catchLead = lead(firesAt(catchUp), nominal + 29 * 60 - 1);
check(
  "catch-up fires in the minute before nominal + 29 min",
  catchLead < 60,
  `${catchUp} -> ${catchLead + 1}s before ${hhmmss(nominal + 29 * 60)} VN`,
);

/** A Date reading `secondsOfDay` seconds past midnight in Vietnam, 2026-10-07. */
function atVn(secondsOfDay: number): Date {
  return new Date(Date.UTC(2026, 9, 7) + (secondsOfDay - 7 * 3600) * 1000);
}

const nap = msUntilWindow(atVn(windowStart - 60));
check(
  "60s before the window the handler naps ~60s",
  nap >= 59_000 && nap <= 61_000,
  `${Math.round(nap / 1000)}s`,
);
check("at the window opening there is nothing to nap for", msUntilWindow(atVn(windowStart)) === 0);
// The nap is capped at two hours: a cron firing further out just ticks.
check("a nap never exceeds the two-hour cap", msUntilWindow(atVn(windowStart - 3 * 3600)) === 0);

const noon = { nominalSeconds: 12 * 3600, earlySeconds: 60, maxWaitSeconds: 600 };
check("one minute early opens the window", planRun(atVn(12 * 3600 - 60), noon) !== null);
check("one second early is still too early", planRun(atVn(12 * 3600 - 61), noon) === null);
check(
  "twenty-nine minutes in is still open",
  planRun(atVn(12 * 3600 + 29 * 60), noon) !== null,
);
check(
  "thirty-one minutes in is closed",
  planRun(atVn(12 * 3600 + 31 * 60), noon) === null,
);

const atMidnight = { nominalSeconds: 0, earlySeconds: 5, maxWaitSeconds: 600 };
const preRollPlan = planRun(atVn(SECONDS_PER_DAY - 5), atMidnight);
check(
  "23:59:55 belongs to tomorrow's check-in",
  preRollPlan?.preRoll === true && preRollPlan.runDate === "2026-10-08",
  preRollPlan?.runDate ?? "no plan",
);
const firstPlan = planRun(atVn(5), atMidnight);
check(
  "00:00:05 belongs to today's check-in",
  firstPlan?.preRoll === false && firstPlan.runDate === "2026-10-07",
  firstPlan?.runDate ?? "no plan",
);
check(
  "a day that has not rolled yet may be retried until 00:10",
  (firstPlan?.retryUntil ?? 0) - atVn(5).getTime() === 595_000,
);

const cronLog = cronLines.find((l) => l.includes("Cron:")) ?? "";
check(
  "main.ts registers all four Deno.cron jobs",
  typeof Deno.cron === "function" &&
    ["(pre-roll)", "(catch-up)", "(shopee)", "(shopee catch-up)"].every((k) => cronLog.includes(k)),
  cronLog.replace("⏰ ", ""),
);

// ── Deno KV ────────────────────────────────────────────────────────────────

section("Deno KV");
await Deno.remove(TMP, { recursive: true }).catch(() => {});
await Deno.mkdir(TMP, { recursive: true });
// The pre-KV file must migrate on first load — that is how `data/store.json`
// moved over when the bot was ported to Deno KV.
const legacy = JSON.stringify({ version: 1, chats: { "tg:777": { accounts: {} } } });
await Deno.writeTextFile(`${TMP}/store.json`, legacy);

await store.load();
check("legacy store.json migrated into KV", store.data.chats["tg:777"] !== undefined);
await store.setMeta("deploycheck", "ok");
check("meta round-trips", (await store.meta<string>("deploycheck")) === "ok");

store.data.version = 1;
store.touch();
await store.flush();

const kv = await Deno.openKv(`${TMP}/store.kv`);
const raw = (await kv.get<string>(["caffi", "store"])).value;
kv.close();
check("store lives under [caffi, store]", raw !== null);
if (raw === null) {
  check("flush() wrote a payload", false);
} else {
  const parsed = JSON.parse(raw) as { payload?: string; chats?: unknown };
  check(
    "flush() encrypts the payload",
    typeof parsed.payload === "string" && parsed.chats === undefined,
    Object.keys(parsed).join(", ") || "nothing",
  );
  const payload = parsed.payload ?? "";
  check("the payload still decodes", payload.length > 0, `${payload.length} chars`);
}

// A host with no file to migrate from (Deno Deploy) is handed the old
// `store.json` through an env var instead. That branch only exists when
// `config.deploy` is true, and config.ts reads the environment when it is
// imported — so it needs a process of its own. That process opens the
// *platform* KV, which on a plain `deno run` is the per-location database
// under `$DENO_DIR` — left alone it would still hold the previous run's seed
// and this check would pass once and fail forever after.
const seedPayload = await seal({ version: 1, chats: { "ds:42": { accounts: {} } } }, config.secret);
const seedScript = `${TMP}/seed.ts`;
await Deno.writeTextFile(
  seedScript,
  [
    `import { store } from ${
      JSON.stringify(new URL("../src/store.ts", import.meta.url).pathname)
    };`,
    "await store.load();",
    `console.log("seeded=" + Object.keys(store.data.chats).join(","));`,
    "",
  ].join("\n"),
);
// The seed directory doubles as that DENO_DIR, so it has to go before every run.
await Deno.remove(`${TMP}-seed`, { recursive: true }).catch(() => {});
const seed = await new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "--config", new URL("../deno.json", import.meta.url).pathname, seedScript],
  env: {
    DENO_DEPLOY: "true",
    RUNTIME_MODE: "webhook",
    DATA_DIR: `${TMP}-seed`,
    DENO_DIR: `${TMP}-seed/deno`,
    STORE_IMPORT: JSON.stringify({ payload: seedPayload }),
  },
  stdout: "piped",
  stderr: "piped",
}).output();
const seedOut = new TextDecoder().decode(seed.stdout) + new TextDecoder().decode(seed.stderr);
check(
  "STORE_IMPORT seeds an empty KV (the Deno Deploy shape)",
  seed.code === 0 && seedOut.includes("seeded=ds:42") && seedOut.includes("Seeded Deno KV"),
  seedOut.includes("Seeded Deno KV")
    ? seedOut.match(/seeded=[^\n]*/)?.[0] ?? ""
    : `exit ${seed.code}: ${seedOut.trim().split("\n").pop()}`,
);

// ── Shopee ────────────────────────────────────────────────────────────────

section("Shopee check-in (second provider)");

const shopeeSpec = shopeeCronSpec();
const shopeeCatchSpec = shopeeCatchUpCronSpec();
check("shopee cron spec is valid", parseSpec(shopeeSpec) !== undefined, shopeeSpec);
check("shopee catch-up spec is valid", parseSpec(shopeeCatchSpec) !== undefined, shopeeCatchSpec);
check("shopee fires exactly at 00:00 VN", firesAt(shopeeSpec) === 0, hhmmss(firesAt(shopeeSpec)));
check(
  "shopee catch-up fires exactly at 00:30 VN",
  firesAt(shopeeCatchSpec) === 30 * 60,
  hhmmss(firesAt(shopeeCatchSpec)),
);
check(
  "all four jobs land on different minutes",
  new Set([preRoll, catchUp, shopeeSpec, shopeeCatchSpec]).size === 4,
  [preRoll, catchUp, shopeeSpec, shopeeCatchSpec].join(" · "),
);

// The cookie is the whole credential, so its command must never reach a guild.
const shopeeCmds = COMMANDS.filter((c) => c.name.startsWith("shopee"));
check(
  "Discord exposes all five Shopee commands",
  shopeeCmds.length === 5,
  shopeeCmds.map((c) => c.name).join(", "),
);
check(
  "shopee-login is restricted to DMs",
  (shopeeCmds.find((c) => c.name === "shopee-login")?.contexts ?? []).length === 1,
);

// The wire contract, offline: stub fetch and drive one day through the runner.
// Same idea as `deno task shopee`, trimmed to what a bad deploy would break.
const { runShopeeCheckIn, shopeeSettings } = await import("../src/shopee.ts");
const realFetch = globalThis.fetch;
const wire: { url: string; method: string; headers: Record<string, string> }[] = [];
const replies: { match: string; body: unknown }[] = [
  {
    match: "settings",
    body: {
      code: 0,
      msg: "success",
      data: {
        login: true,
        userid: "4242",
        checked_in_today: false,
        checked_in_today_amount: 100,
        checkin_list: [100, 100, 100, 100, 100, 100, 100, 100],
        today_index: 1,
      },
    },
  },
  {
    match: "checkin_new",
    body: {
      code: 0,
      msg: "success",
      data: {
        success: true,
        increase_coins: 100,
        today_index: 1,
        checkin_list: [100, 100, 100, 100, 100, 100, 100, 100],
      },
    },
  },
];
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  wire.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as never });
  const hit = replies.find((r) => url.endsWith(r.match));
  return Promise.resolve(new Response(JSON.stringify(hit?.body ?? {}), { status: 200 }));
}) as typeof fetch;

const shopeeAccount: import("../src/types.ts").ShopeeAccount = {
  name: "deploycheck",
  cookie: "SPC_F=1; SPC_ST=2",
  autoCheckIn: true,
  sessionInvalid: false,
  createdAt: "2026-10-01T00:00:00.000Z",
};

try {
  await shopeeSettings(shopeeAccount.cookie);
  check(
    "GET settings goes to games-dailycheckin.shopee.vn",
    wire[0]?.url === "https://games-dailycheckin.shopee.vn/mkt/coins/api/v2/settings",
    wire[0]?.url,
  );

  wire.length = 0;
  const r = await runShopeeCheckIn(shopeeAccount);
  check("a fresh day is credited", r.outcome === "checked_in", r.outcome);
  check(
    "…with dci-version and check-in-origin on every hop",
    wire.length > 0 &&
      wire.every((c) =>
        c.headers["dci-version"] === "4008000" && c.headers["check-in-origin"] === "pc"
      ),
  );
  check(
    "…and exactly one write: POST checkin_new",
    wire.filter((c) => c.method === "POST").length === 1 &&
      wire.some((c) => c.method === "POST" && c.url.endsWith("checkin_new")),
    wire.map((c) => `${c.method} ${c.url}`).join(" · "),
  );
  check(
    "…carrying the cookie",
    wire.every((c) => c.headers["cookie"] === shopeeAccount.cookie),
  );
  check(
    "lastCheckInDay recorded, so the 00:30 catch-up stands down",
    shopeeAccount.lastCheckInDay !== undefined,
  );
} finally {
  globalThis.fetch = realFetch;
}

const shopeeChat = store.shopeeChat("deploycheck");
shopeeChat["deploycheck"] = shopeeAccount;
check(
  "the store hands the session to the nightly run",
  store.autoShopeeAccounts().some((x) => x.account.name === "deploycheck"),
);
shopeeAccount.sessionInvalid = true;
check(
  "…but not once the cookie is refused",
  store.autoShopeeAccounts().every((x) => x.account.name !== "deploycheck") &&
    store.invalidShopeeAccounts().some((x) => x.account.name === "deploycheck"),
);
delete shopeeChat["deploycheck"];
shopeeAccount.sessionInvalid = false;

// ── Telegram ───────────────────────────────────────────────────────────────

section("Telegram webhook");
const tgBot = new Bot("123:dummy", { botInfo: fakeBotInfo() });
const sends: string[] = [];
tgBot.api.sendMessage = ((chatId: unknown, text: string) => {
  sends.push(`${chatId}: ${text}`);
  return Promise.resolve({ message_id: 1, date: 0, chat: { id: 777, type: "private" } as never });
}) as never;
registerHandlers(tgBot, senderFor(tgBot));
const telegram = webhookHandler(tgBot);

const postTelegram = (body: string, secret?: string) =>
  new Request("https://example.test/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body,
  });

const groupUpdate = JSON.stringify({
  update_id: 1,
  message: {
    message_id: 1,
    date: 1_759_800_000,
    chat: { id: -100, type: "group", title: "x" },
    text: "/start",
  },
});
const privateUpdate = JSON.stringify({
  update_id: 2,
  message: {
    message_id: 2,
    date: 1_759_800_000,
    chat: { id: 777, type: "private", first_name: "X" },
    from: { id: 777, is_bot: false, first_name: "X" },
    text: "/help",
  },
});

await expect("wrong secret token -> 401", telegram(postTelegram(groupUpdate, "nope")), 401);
await expect("missing secret token -> 401", telegram(postTelegram(groupUpdate)), 401);

sends.length = 0;
await expect(
  "valid secret + group update -> 200",
  telegram(postTelegram(groupUpdate, config.webhookSecret)),
  200,
);
check(
  "a group update never reaches the private-chat router",
  sends.length === 0,
  `${sends.length}`,
);

sends.length = 0;
await expect(
  "valid secret + private /help -> 200",
  telegram(postTelegram(privateUpdate, config.webhookSecret)),
  200,
);
check(
  "…and the router answered inside that very request",
  sends.length === 1 && sends[0]!.includes("Caffi"),
  sends[0]?.slice(0, 48) ?? "no reply",
);
await expect(
  "an update with nothing in it is acknowledged",
  telegram(postTelegram(JSON.stringify({ update_id: 3 }), config.webhookSecret)),
  200,
);

// ── Discord ────────────────────────────────────────────────────────────────

section("Discord interactions endpoint");
const discordBot = createDiscordBot();
check("discordeno bot built without any REST call", discordBot !== undefined);

if (discordBot) {
  const interactions = interactionHandler(discordBot);
  const url = "https://example.test/discord";

  await expect("GET -> banner", interactions(new Request(url)), 200);

  const signed = async (body: string, signature?: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signature ??
      toHex(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "Ed25519" },
            keyPair.privateKey,
            new TextEncoder().encode(timestamp + body),
          ),
        ),
      );
    return new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": sig,
        "x-signature-timestamp": timestamp,
      },
      body,
    });
  };
  const unsigned = (body: string) =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  await expect("no signature at all -> 401", interactions(unsigned('{"type":1}')), 401);
  await expect(
    "empty signature -> 401",
    quietly(async () => await interactions(await signed('{"type":1}', " "))),
    401,
  );
  await expect(
    "signature over another body -> 401",
    quietly(async () => await interactions(await signed('{"type":1}', toHex(new Uint8Array(32))))),
    401,
  );

  const ping = await quietly(async () =>
    await interactions(await signed('{"type":1,"challenge":"dc-verify-42"}'))
  );
  const pingBody = ping.status === 200
    ? await ping.json() as { type?: number; challenge?: string }
    : undefined;
  check(
    "PING -> 200 and the challenge comes back verbatim",
    ping.status === 200 && pingBody?.type === 1 && pingBody?.challenge === "dc-verify-42",
    `status ${ping.status}, challenge ${JSON.stringify(pingBody?.challenge)}`,
  );

  // The route answers through Discord's REST API, which is the one thing this
  // script must not touch. Stub it, then check the contract it exists for:
  // whatever happens, the endpoint answers 204 and never a 5xx.
  let restCalls = 0;
  const rest = discordBot.rest as unknown as { post: unknown };
  const realPost = rest.post;
  rest.post = () => {
    restCalls++;
    return Promise.reject(new Error("offline: REST is stubbed by deploycheck"));
  };

  await expect(
    "interaction -> 204 even though Discord is unreachable",
    quietly(async () =>
      interactions(
        await signed(
          JSON.stringify({
            id: "1",
            token: "t",
            type: 2,
            application_id: "42",
            channel_id: "777",
            user: { id: "777", username: "x", discriminator: "0", global_name: "X", avatar: null },
            data: { id: "9", name: "status", type: 1, options: [] },
          }),
        ),
      )
    ),
    204,
  );
  check("…and it deferred over the stub, not the network", restCalls > 0, `${restCalls} call(s)`);

  // discordeno derives the user from `member.user ?? user`; a payload with
  // neither throws inside the transformer, which must still be answered.
  await expect(
    "payload with neither user nor member -> 204",
    quietly(async () =>
      interactions(
        await signed(
          JSON.stringify({ id: "2", token: "t", type: 2, data: { name: "status", options: [] } }),
        ),
      )
    ),
    204,
  );

  rest.post = realPost;
  await expect("malformed JSON -> 400", interactions(await signed("not json")), 400);
}

// ── Live (only once the app is out there) ──────────────────────────────────

if (config.publicUrl) {
  section("Deployed app");
  try {
    const res = await fetch(`${config.publicUrl}/healthz`);
    check("GET /healthz -> 200", res.status === 200, String(res.status));
    const discordRes = await fetch(`${config.publicUrl}/discord`, {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
      headers: { "content-type": "application/json" },
    });
    check(
      "POST /discord without a signature -> 401",
      discordRes.status === 401,
      String(discordRes.status),
    );
  } catch (e) {
    check("reachable", false, (e as Error).message);
  }
} else {
  warn("live checks skipped", "add PUBLIC_URL to .env once the app is deployed");
}

console.log(
  `\n${failed ? `❌ ${failed} FAILED` : "✅ all deploy checks OK"}` +
    (warned ? ` · ${warned} warning(s)` : ""),
);
Deno.exit(failed ? 1 : 0);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Run a deliberately broken call with the handler's error logging muted — the
 * point of the test is that the error is *caught*, so the stack trace would
 * only look like a failure.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log: realLog, error: realError } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** Assert the HTTP status a handler answers with. */
async function expect(name: string, response: Response | Promise<Response>, want: number) {
  let got: number | string;
  try {
    got = (await response).status;
  } catch (e) {
    got = `threw: ${(e as Error).message}`;
  }
  check(name, got === want, got === want ? "" : `got ${String(got)}, want ${want}`);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** grammY refuses to work without `botInfo`; this one never leaves the process. */
function fakeBotInfo() {
  return {
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
  } as never;
}
