/**
 * Manual test for the real login flow (not part of the production bot).
 *
 *   CAFFI_USER=... CAFFI_PASS=... deno run -A scripts/test-login.ts start
 *   CAFFI_USER=... CAFFI_PASS=... deno run -A scripts/test-login.ts verify 123456
 *   CAFFI_USER=... CAFFI_PASS=... deno run -A scripts/test-login.ts resend
 *
 * The challengeId is written to /tmp so the two steps can be linked together.
 */
const CHALLENGE_FILE = "/tmp/opencode/caffi-challenge.json";

const { CaffiApi, DEVICE_INFO } = await import("../src/caffi.ts");

const user = Deno.env.get("CAFFI_USER") ?? "";
const pass = Deno.env.get("CAFFI_PASS") ?? "";
const mode = Deno.args[0] ?? "start";

if (!user || !pass) {
  console.error("Missing CAFFI_USER / CAFFI_PASS");
  Deno.exit(1);
}

// Throwaway client — these two auth endpoints need no token.
const noop = {
  getTokens: () => ({ accessToken: "", refreshToken: "" }),
  saveTokens: () => {},
  clearSession: () => {},
};
const api = new CaffiApi(noop);

function show(e: unknown) {
  const err = e as Error & { code?: string; status?: number };
  console.error(`❌ ${err.message}`);
  if (err.code) console.error(`   code=${err.code} status=${err.status ?? "?"}`);
}

try {
  if (mode === "start") {
    console.log("deviceInfo:", JSON.stringify(DEVICE_INFO));
    const t0 = performance.now();
    const r = await api.passwordLogin(user, pass);
    const ms = Math.round(performance.now() - t0);
    console.log(`→ ${ms}ms, kind=${r.kind}`);
    if (r.kind === "otp_required") {
      await Deno.writeTextFile(
        CHALLENGE_FILE,
        JSON.stringify({
          challengeId: r.challengeId,
          sentTo: r.sentTo,
          retryAfterSeconds: r.retryAfterSeconds,
          user,
          pass,
        }),
      );
      console.log("challengeId:", r.challengeId);
      console.log("sentTo     :", r.sentTo ?? "(none)");
      console.log("resend in  :", r.retryAfterSeconds, "seconds");
      console.log("\n→ now run: verify <otp-code>");
    } else {
      console.log("Logged in directly, NO OTP required!");
      console.log("accessToken:", r.tokens.accessToken.slice(0, 24) + "…");
      console.log("refreshToken:", r.tokens.refreshToken.slice(0, 24) + "…");
      await Deno.writeTextFile(
        CHALLENGE_FILE,
        JSON.stringify({ tokens: r.tokens, user, pass }),
      );
    }
  } else if (mode === "verify") {
    const otp = Deno.args[1];
    if (!otp) {
      console.error("Missing OTP code");
      Deno.exit(1);
    }
    const saved = JSON.parse(await Deno.readTextFile(CHALLENGE_FILE));
    if (!saved.challengeId) {
      console.error("No challengeId — run `start` first");
      Deno.exit(1);
    }
    const t0 = performance.now();
    const r = await api.verifyOtp(saved.challengeId, otp);
    console.log(`→ ${Math.round(performance.now() - t0)}ms`);
    console.log("accessToken :", r.tokens.accessToken.slice(0, 24) + "…");
    console.log("refreshToken:", r.tokens.refreshToken.slice(0, 24) + "…");
    console.log("displayName :", r.displayName ?? "(none)");
    await Deno.writeTextFile(
      CHALLENGE_FILE,
      JSON.stringify({ tokens: r.tokens, displayName: r.displayName, user, pass }),
    );
    console.log("Tokens written to", CHALLENGE_FILE);
  } else if (mode === "resend") {
    const saved = JSON.parse(await Deno.readTextFile(CHALLENGE_FILE));
    if (!saved.challengeId) {
      console.error("No challengeId");
      Deno.exit(1);
    }
    await api.resendOtp(saved.challengeId, saved.user, saved.pass);
    console.log("✓ OTP resent");
  } else {
    console.error("Unknown mode:", mode);
    Deno.exit(1);
  }
} catch (e) {
  show(e);
  Deno.exit(1);
}
