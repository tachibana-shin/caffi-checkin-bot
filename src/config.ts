/**
 * Configuration, read from wherever the runtime keeps its environment.
 *
 * The bot runs in three shapes and they do not agree on how to read a variable:
 * `polling` (local) has `Deno.env`, the Deno Deploy shape has `Deno.env` plus
 * `DENO_DEPLOY=true`, and the Cloudflare Workers shape has a per-invocation
 * `env` binding and no `Deno` global at all. So the reader goes through one
 * indirection that either of them can fill: `useEnv()` before the first read,
 * and after that the config below is a plain frozen snapshot.
 *
 * **Nothing in this module may run before `useEnv`.** That is why it is only
 * ever imported dynamically from `src/worker.ts` (workerd evaluates the global
 * scope before the bindings exist), and why `useEnv` itself lives in its own
 * dependency-free module.
 */
import { envValue } from "./env.ts";

function required(name: string): string {
  const v = envValue(name);
  if (!v) {
    console.error(
      `\n❌ Missing environment variable: ${name}.\n   Copy .env.example -> .env and fill in the values.\n`,
    );
    if (typeof Deno !== "undefined") Deno.exit(1);
    throw new Error(`missing env: ${name}`);
  }
  return v;
}

function str(name: string, fallback: string): string {
  const v = envValue(name);
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = envValue(name);
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `webhook` is the Deno Deploy shape: an HTTP endpoint receives updates and
 * `Deno.cron` fires the check-in. `polling` is the local shape: grammY long
 * polling plus the Discord gateway, driven by an interval. `worker` is the
 * Cloudflare Workers shape: the same HTTP endpoints, a `scheduled` handler
 * instead of `Deno.cron`, and a D1-backed store. Deno Deploy runs several
 * isolated instances at once, so two long-polling or two gateway sessions would
 * fight each other — hence the split.
 */
type RuntimeMode = "webhook" | "polling" | "worker";

/**
 * workerd has a global `WebSocketPair` and no `Deno`; Deno and Node have
 * neither combination. It is only a fallback — wrangler sets `RUNTIME_MODE`
 * explicitly.
 */
const inWorker = typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined";

function mode(): RuntimeMode {
  const requested = str("RUNTIME_MODE", inWorker ? "worker" : "polling");
  if (requested !== "webhook" && requested !== "polling" && requested !== "worker") {
    console.error(`❌ RUNTIME_MODE must be "webhook", "polling" or "worker", got "${requested}".`);
    if (typeof Deno !== "undefined") Deno.exit(1);
    throw new Error(`bad RUNTIME_MODE: ${requested}`);
  }
  return requested;
}

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  secret: str("BOT_SECRET", ""),
  checkInHour: int("CHECKIN_HOUR", 0),
  checkInMinute: int("CHECKIN_MINUTE", 0),
  /** Wake up this many seconds BEFORE the scheduled time — the fastest check-in pays more. */
  checkInEarlySeconds: int("CHECKIN_EARLY_SECONDS", 5),
  /** Keep retrying for this long after the scheduled time while the day has not rolled yet. */
  checkInMaxWaitSeconds: int("CHECKIN_MAX_WAIT_SECONDS", 600),
  dataDir: str("DATA_DIR", "data"),
  /**
   * One-shot seed for an empty store: the exact contents of a legacy
   * `store.json`. No host the bot runs on has a filesystem to migrate from, so
   * the file arrives as an env var — still sealed with `BOT_SECRET`. Remove the
   * variable once the bot reports its accounts.
   */
  storeImport: str("STORE_IMPORT", ""),
  timeZone: "Asia/Ho_Chi_Minh",

  /** Deno Deploy sets this to "true"; the other shapes leave it unset. */
  deploy: str("DENO_DEPLOY", "") === "true",
  runtimeMode: mode(),
  /** Public origin of the app, e.g. https://my-app.workers.dev — no trailing slash. */
  publicUrl: str("PUBLIC_URL", "").replace(/\/+$/, ""),
  /** Guards Telegram's webhook endpoint (`X-Telegram-Bot-Api-Secret-Token`). */
  webhookSecret: str("WEBHOOK_SECRET", str("BOT_SECRET", "")),
  /** Port the local listener binds (ignored on every serverless host). */
  port: int("PORT", 8000),
  /**
   * Guards the `/race` route the cron handler calls on itself: it is the only
   * way to get the midnight check-in to run inside a fetch handler, where
   * Cloudflare's Smart Placement can hold the isolate next to the Caffi
   * servers instead of wherever the scheduler happened to wake up.
   */
  workerSecret: str("WORKER_SECRET", str("BOT_SECRET", "")),
  /**
   * PBKDF2 rounds for the store envelope. 150k was chosen when the store lived
   * on a full Deno runtime (~1s per key — fine there); a Cloudflare Worker's
   * free plan bills 10ms of CPU per invocation, so the same number would kill
   * every request. The round count travels inside the envelope, so an old
   * record still opens with its own cost.
   */
  kdfIterations: int("KDF_ITERATIONS", 1_000),
};
