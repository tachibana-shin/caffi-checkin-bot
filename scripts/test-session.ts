/**
 * Exercise a logged-in session: status / wallet / user / check-in.
 *   deno run -A scripts/test-session.ts           # read-only
 *   deno run -A scripts/test-session.ts checkin   # read + check in
 */
const CHALLENGE_FILE = "/tmp/opencode/caffi-challenge.json";

const { CaffiApi } = await import("../src/caffi.ts");

const saved = JSON.parse(await Deno.readTextFile(CHALLENGE_FILE));
if (!saved.tokens) {
  console.error("No tokens yet — run test-login.ts first");
  Deno.exit(1);
}

const live = { accessToken: saved.tokens.accessToken, refreshToken: saved.tokens.refreshToken };
let refreshed = false;

const api = new CaffiApi({
  getTokens: () => live,
  saveTokens: (t) => {
    live.accessToken = t.accessToken;
    live.refreshToken = t.refreshToken;
    refreshed = true;
  },
  clearSession: () => {},
});

const doCheckIn = Deno.args[0] === "checkin";

function time<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = performance.now();
  return fn()
    .then((v) => {
      console.log(`✓ ${label} (${Math.round(performance.now() - t0)}ms)`);
      return v;
    })
    .catch((e: Error & { code?: string }) => {
      console.log(`✗ ${label}: ${e.message}${e.code ? ` [${e.code}]` : ""}`);
      return undefined;
    });
}

const status0 = await time("GET /xeng/check-in/status", () => api.getCheckInStatus());
console.log("  →", JSON.stringify(status0));

const wallet = await time("GET /xeng/wallet", () => api.getWallet());
console.log("  →", JSON.stringify(wallet));

const info = await time("GET /user/info", () => api.getUserInfo());
const u = (info?.user ?? info ?? {}) as Record<string, unknown>;
console.log("  →", {
  displayName: u.displayName ?? u.name,
  email: u.email,
  rank: u.rank,
  keys: Object.keys(u).slice(0, 14).join(","),
});

if (!doCheckIn) {
  console.log(`\n(refresh token was rotated: ${refreshed})`);
  console.log("Run `checkin` to perform the check-in.");
  Deno.exit(0);
}

if (status0?.todayCheckedIn) {
  console.log("\n✅ Already checked in today — skipping.");
  Deno.exit(0);
}

console.log("\n→ POST /xeng/check-in ...");
const t0 = performance.now();
try {
  const r = await api.postCheckIn();
  console.log(`✓ ${Math.round(performance.now() - t0)}ms`);
  console.log("  →", JSON.stringify(r));
} catch (e) {
  const err = e as Error & { code?: string };
  console.log(`✗ ${err.message}${err.code ? ` [${err.code}]` : ""}`);
  Deno.exit(1);
}

const [status1, wallet1] = await Promise.all([
  api.getCheckInStatus().catch(() => null),
  api.getWallet().catch(() => null),
]);
console.log("\nafter check-in:");
console.log("  status →", JSON.stringify(status1));
console.log("  wallet →", JSON.stringify(wallet1));
console.log(`\n(refresh token was rotated: ${refreshed})`);
