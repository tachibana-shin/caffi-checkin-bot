/**
 * Smoke test, run by hand with `deno run -A scripts/smoke.ts` (or `deno task smoke`).
 * Verifies (1) store encryption round-trip, (2) the client can reach the real API,
 * (3) error branches are recognised.
 */
Deno.env.set("TELEGRAM_BOT_TOKEN", "smoke-test-token");
Deno.env.set("BOT_SECRET", "smoke-secret-do-not-use-in-prod");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-smoke");

const { Store, store } = await import("../src/store.ts");
const { CaffiApi, DEVICE_INFO } = await import("../src/caffi.ts");
const { vnDate, nowVn } = await import("../src/checkin.ts");

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
}

// ── 1. Store + encryption ────────────────────────────────────────────────
await store.load();
const chat = store.chat(12345);
chat.accounts["test-user"] = {
  username: "test-user",
  password: "mat-khau-bí-mật<>&",
  tokens: { accessToken: "at", refreshToken: "rt" },
  autoCheckIn: true,
  sessionInvalid: false,
  createdAt: new Date().toISOString(),
};
store.touch();
await store.flush();

const onDisk = await Deno.readTextFile("/tmp/opencode/caffi-smoke/store.json");
check("store encrypted on disk", !onDisk.includes("mat-khau") && onDisk.includes("payload"));

const fresh = new Store();
await fresh.load();
check(
  "decrypt round-trip matches",
  fresh.data.chats["12345"]?.accounts["test-user"]?.password === "mat-khau-bí-mật<>&",
);

// ── 2. Live API ─────────────────────────────────────────────────────────
check(
  "deviceInfo matches the app",
  DEVICE_INFO.deviceId === "caffiliate-mobile" &&
    DEVICE_INFO.appVersion === "1.4.2",
  JSON.stringify(DEVICE_INFO),
);

const noSession = new CaffiApi({
  getTokens: () => ({ accessToken: "", refreshToken: "" }),
  saveTokens: () => {},
  clearSession: () => {},
});

try {
  await noSession.getCheckInStatus();
  check("authed API without a token must fail", false);
} catch (e) {
  const err = e as Error & { code?: string };
  check("authed API without a token must fail", err.code === "NOT_AUTHENTICATED", err.code);
}

const badLogin = new CaffiApi({
  getTokens: () => ({ accessToken: "", refreshToken: "" }),
  saveTokens: () => {},
  clearSession: () => {},
});
try {
  await badLogin.passwordLogin("tai-khoan-khong-ton-tai-7q2x", "sai-mat-khau");
  check("passwordLogin with a wrong password must fail", false);
} catch (e) {
  const err = e as Error & { code?: string };
  check(
    "passwordLogin with a wrong password must fail",
    err.code === "PASSWORD_INVALID",
    err.code,
  );
}

try {
  await badLogin.getWallet();
  check("empty refresh token => SessionExpired", false);
} catch (e) {
  const name = (e as Error).name;
  check("empty refresh token => SessionExpired", name === "SessionExpiredError", name);
}

// ── 3. Time helpers ─────────────────────────────────────────────────────
const today = vnDate();
check("vnDate format is YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(today), today);
check("nowVn returns a string", typeof nowVn() === "string", nowVn());

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll OK");
Deno.exit(failed ? 1 : 0);
