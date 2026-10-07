function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(
      `\n❌ Missing environment variable: ${name}.\n   Copy .env.example -> .env and fill in the values.\n`,
    );
    Deno.exit(1);
  }
  return v;
}

function str(name: string, fallback: string): string {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `webhook` is the Deno Deploy shape: an HTTP endpoint receives updates and
 * `Deno.cron` fires the check-in. `polling` is the local shape: grammY long
 * polling plus the Discord gateway, driven by an interval. Deno Deploy runs
 * several isolated instances at once, so two long-polling or two gateway
 * sessions would fight each other — hence the split.
 */
type RuntimeMode = "webhook" | "polling";

const DEFAULT_MODE: RuntimeMode = Deno.env.get("DENO_DEPLOY") === "true" ? "webhook" : "polling";
const requested = str("RUNTIME_MODE", DEFAULT_MODE);
if (requested !== "webhook" && requested !== "polling") {
  console.error(`❌ RUNTIME_MODE must be "webhook" or "polling", got "${requested}".`);
  Deno.exit(1);
}

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  secret: Deno.env.get("BOT_SECRET") ?? "",
  /** The bot also runs on Discord when this is set; it is optional. */
  discordToken: Deno.env.get("DISCORD_TOKEN") ?? "",
  discordApplicationId: Deno.env.get("DISCORD_APPLICATION_ID") ?? "",
  /** Discord's "Interactions Endpoint URL" verification key (hex). */
  discordPublicKey: Deno.env.get("DISCORD_PUBLIC_KEY") ?? "",
  /** Push the slash-command list again even when nothing changed (Discord caches it). */
  forceDiscordCommands: str("FORCE_DISCORD_COMMANDS", "") === "true",
  checkInHour: int("CHECKIN_HOUR", 0),
  checkInMinute: int("CHECKIN_MINUTE", 0),
  /** Wake up this many seconds BEFORE the scheduled time — the fastest check-in pays more. */
  checkInEarlySeconds: int("CHECKIN_EARLY_SECONDS", 5),
  /** Keep retrying for this long after the scheduled time while the day has not rolled yet. */
  checkInMaxWaitSeconds: int("CHECKIN_MAX_WAIT_SECONDS", 600),
  /** Optional stagger between accounts. Keep 0 if you want to be first. */
  checkInJitterMax: int("CHECKIN_JITTER_MAX", 0),
  dataDir: Deno.env.get("DATA_DIR") ?? "data",
  /**
   * One-shot seed for an empty Deno KV: the exact contents of a legacy
   * `store.json`. Deno Deploy has no filesystem to migrate from, so the file
   * arrives as an env var — still sealed with `BOT_SECRET`. Remove the
   * variable once the bot reports its accounts.
   */
  storeImport: Deno.env.get("STORE_IMPORT") ?? "",
  timeZone: "Asia/Ho_Chi_Minh",

  /** Deno Deploy sets this to "true"; local runs leave it unset. */
  deploy: Deno.env.get("DENO_DEPLOY") === "true",
  runtimeMode: requested as RuntimeMode,
  /** Public origin of the app, e.g. https://my-app.deno.dev — no trailing slash. */
  publicUrl: str("PUBLIC_URL", "").replace(/\/+$/, ""),
  /** Guards Telegram's webhook endpoint (`X-Telegram-Bot-Api-Secret-Token`). */
  webhookSecret: str("WEBHOOK_SECRET", str("BOT_SECRET", "")),
  port: int("PORT", 8000),
};
