/**
 * Shopee's daily "Điểm Danh Nhận Xu" — the API taken apart from the web bundle
 * `dailycheckin/pcmall-dailycheckin.*.js` that https://shopee.vn/shopee-coins
 * lazy-loads, not from anything documented.
 *
 * Two things it does differently from Caffi:
 *
 *  - **Login is a cookie.** There is no token exchange to run: the page sends
 *    the browser's own SSO cookies, so a session is "the Cookie header of a
 *    browser that is already signed in". `/shopee-login` stores it verbatim.
 *  - **It lives on its own host.** The bundle builds its axios client from
 *    `https://games-dailycheckin.${locale}/mkt/coins/api/v2/`, not from
 *    shopee.vn — `locale` for Vietnam is `shopee.vn`, so everything below
 *    points at `games-dailycheckin.shopee.vn`.
 *
 * Endpoints (both confirmed against production 07-10-2026):
 *
 *   GET  settings            who you are + today's state — read-only
 *   POST checkin_new {dfp,s} the check-in itself
 *
 * Both need two hand-set headers, `dci-version: 4008000` and
 * `check-in-origin: pc`. The `dfp`/`s` body fields come from an anti-fraud
 * script the page injects; they are optional (`dfp` is `await …catch()`, so the
 * page itself sends `undefined` when the script does not load).
 *
 * The wire is **snake_case**. The bundle rewrites keys to camelCase in an axios
 * interceptor, which is why the names in the minified source never match a raw
 * response — every type here is spelled the way the server sends it.
 */
import { vnDate } from "./checkin.ts";
import { store } from "./store.ts";
import type { ShopeeAccount } from "./types.ts";
import { type Card, num } from "./view.ts";

const BASE = "https://games-dailycheckin.shopee.vn/mkt/coins/api/v2/";
/** The build the page sends. It is a gate, not a secret — no signature follows. */
const DCI_VERSION = "4008000";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

/** The cookie is gone (or never was one). The user must paste a fresh copy. */
export class ShopeeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopeeAuthError";
  }
}

/** Network, HTML instead of JSON, or a 5xx. Safe to retry. */
export class ShopeeApiError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "ShopeeApiError";
    this.code = code;
  }
}

/** Exactly what the server sends — no key is renamed on the way in. */
export interface Envelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

/** GET settings. */
export interface WireSettings {
  login?: boolean;
  userid?: string;
  /** Server clock, ISO with its own offset — the cluster runs at UTC+8. */
  "@timestamp"?: string;
  checked_in_today?: boolean;
  checked_in_today_amount?: number;
  today_index?: number;
  checkin_list?: number[];
  checkin_reward_list?: Array<{ type?: number; val?: number }>;
  fraud_detected?: boolean;
  activity_id?: number;
}

/** POST checkin_new. */
export interface WireCheckin {
  success?: boolean;
  increase_coins?: number;
  today_index?: number;
  reward_type?: number;
  checkin_list?: number[];
  checkin_reward_list?: Array<{ type?: number; val?: number }>;
}

function headers(cookie: string, method: string): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    cookie,
    "dci-version": DCI_VERSION,
    "check-in-origin": "pc",
    origin: "https://shopee.vn",
    referer: "https://shopee.vn/shopee-coins",
    "user-agent": UA,
    ...(method === "POST" ? { "content-type": "application/json" } : {}),
  };
}

async function request<T>(
  cookie: string,
  path: string,
  body?: unknown,
): Promise<Envelope<T>> {
  const method = body === undefined ? "GET" : "POST";
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: headers(cookie, method),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ShopeeApiError(`Không gọi được Shopee: ${e instanceof Error ? e.message : e}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ShopeeApiError(`Shopee trả về không phải JSON (HTTP ${res.status})`);
  }

  const env = parsed as Envelope<T> & { is_login?: boolean };
  // The SSO middleware answers 401/`is_login:false` before the handler runs.
  if (res.status === 401 || env.code === 401 || env.is_login === false) {
    throw new ShopeeAuthError(env.msg || "Hết phiên đăng nhập Shopee");
  }
  if (res.status >= 500) {
    throw new ShopeeApiError(`Shopee lỗi ${res.status}`, env.code);
  }
  return env;
}

/** GET settings — read-only: identity plus today's state. */
export function shopeeSettings(cookie: string): Promise<Envelope<WireSettings>> {
  return request<WireSettings>(cookie, "settings");
}

/**
 * POST checkin_new. The one write this module ever performs, and it is the
 * check-in itself — no redeem, no order, no profile call.
 *
 * A non-zero `code` is **returned**, not thrown: the server uses it for "already
 * checked in", which the caller has to see to report it properly.
 */
export function shopeeCheckin(cookie: string): Promise<Envelope<WireCheckin>> {
  // `dfp` (device fingerprint) and `s` come from an anti-fraud script that may
  // not be present — the page tolerates both being undefined, so we send none.
  return request<WireCheckin>(cookie, "checkin_new", {});
}

// ── Runner ────────────────────────────────────────────────────────────────

export type ShopeeOutcome =
  | "checked_in"
  /** The server (or our own ledger) says today is already covered. */
  | "already_done"
  /** The cookie expired — the user has to paste a new one. */
  | "session_expired"
  | "failed";

export interface ShopeeResult {
  outcome: ShopeeOutcome;
  card: Card;
}

/** "already" is what an unrolled day looks like too — the caller re-checks later. */
const ALREADY_RE = /already|exist|duplicate|checked/i;

function markInvalid(account: ShopeeAccount, reason: string): void {
  account.sessionInvalid = true;
  account.invalidReason = reason;
  store.touch();
}

function clearInvalid(account: ShopeeAccount): void {
  if (!account.sessionInvalid && account.invalidReason === undefined) return;
  account.sessionInvalid = false;
  account.invalidReason = undefined;
  store.touch();
}

function remember(account: ShopeeAccount, day: string, outcome: ShopeeOutcome): void {
  account.lastCheckInResult = outcome;
  account.lastResultDay = day;
  store.touch();
}

/**
 * One account, one attempt.
 *
 * `GET settings` first — it is read-only and answers both questions the POST
 * would otherwise have to ask: is the session still good, and has today already
 * been covered (by us earlier, by the user in the app, or because the server's
 * day has not rolled over yet).
 */
export async function runShopeeCheckIn(account: ShopeeAccount): Promise<ShopeeResult> {
  const day = vnDate(new Date());
  const sub = account.name;

  // Already credited by an earlier run today — no request at all.
  if (account.lastCheckInDay === day) {
    return {
      outcome: "already_done",
      card: {
        icon: "✅",
        title: "Hôm nay đã điểm danh Shopee",
        subtitle: sub,
        tone: "info",
        blocks: [{ text: `Đã ghi nhận điểm danh cho ${day}.` }],
      },
    };
  }

  let checkedIn: boolean;
  let userid: string | undefined;
  let todayList: number[] | undefined;
  let todayIndex: number | undefined;
  let amount: number | undefined;

  try {
    const s = await shopeeSettings(account.cookie);
    if (s.code !== 0 || !s.data) {
      const reason = s.msg ?? `settings code ${s.code ?? "?"}`;
      return failedCard(sub, reason, s.code);
    }
    if (s.data.login === false) {
      markInvalid(account, "Shopee báo chưa đăng nhập");
      return expiredCard(sub, account.invalidReason);
    }
    checkedIn = s.data.checked_in_today === true;
    userid = s.data.userid;
    todayList = s.data.checkin_list;
    todayIndex = s.data.today_index;
    amount = s.data.checked_in_today_amount;
    if (userid && userid !== "-") account.userid = userid;
    clearInvalid(account);
  } catch (e) {
    if (e instanceof ShopeeAuthError) {
      markInvalid(account, e.message);
      return expiredCard(sub, e.message);
    }
    return failedCard(sub, e instanceof Error ? e.message : String(e));
  }

  // Covered already: by an earlier run, by the user in the app, or because the
  // server still counts yesterday. The catch-up run re-reads this later, so a
  // day that simply has not rolled over yet is not lost.
  if (checkedIn) {
    remember(account, day, "already_done");
    return {
      outcome: "already_done",
      card: {
        icon: "✅",
        title: "Hôm nay đã điểm danh Shopee",
        subtitle: sub,
        tone: "info",
        stats: [
          { label: "Thưởng hôm nay", value: `${num(amount)} Xu` },
          { label: "Ngày", value: `${(todayIndex ?? 0) + 1}/${todayList?.length || 8}` },
        ],
        footer: userid && userid !== "-" ? `Shopee userid ${userid}` : undefined,
      },
    };
  }

  try {
    const r = await shopeeCheckin(account.cookie);
    if (r.code === 0 && r.data?.success === true) {
      account.lastCheckInDay = day;
      clearInvalid(account);
      remember(account, day, "checked_in");
      const gained = r.data.increase_coins ?? 0;
      const streakList = r.data.checkin_list ?? todayList;
      return {
        outcome: "checked_in",
        card: {
          icon: "🪙",
          title: "Đã điểm danh Shopee",
          subtitle: sub,
          tone: "success",
          stats: [
            { label: "Nhận", value: `+${num(gained)} Xu` },
            {
              label: "Ngày",
              value: `${(r.data.today_index ?? todayIndex ?? 0) + 1}/${streakList?.length || 8}`,
            },
          ],
        },
      };
    }

    // Nothing credited: find out whether today was actually covered after all.
    const why = r.msg ?? (r.code === 0 ? "data.success = false" : `code ${r.code}`);
    if (ALREADY_RE.test(why) || r.code !== 0) {
      const again = await shopeeSettings(account.cookie);
      if (again.code === 0 && again.data?.checked_in_today === true) {
        remember(account, day, "already_done");
        return alreadyCard(sub, again.data);
      }
    }
    remember(account, day, "failed");
    return failedCard(sub, why, r.code);
  } catch (e) {
    if (e instanceof ShopeeAuthError) {
      markInvalid(account, e.message);
      return expiredCard(sub, e.message);
    }
    remember(account, day, "failed");
    return failedCard(sub, e instanceof Error ? e.message : String(e));
  }
}

function alreadyCard(sub: string, s: WireSettings): ShopeeResult {
  const list = s.checkin_list;
  const idx = s.today_index ?? 0;
  return {
    outcome: "already_done",
    card: {
      icon: "✅",
      title: "Hôm nay đã điểm danh Shopee",
      subtitle: sub,
      tone: "info",
      stats: [
        { label: "Thưởng hôm nay", value: `${num(s.checked_in_today_amount)} Xu` },
        { label: "Ngày", value: `${idx + 1}/${list?.length || 8}` },
      ],
    },
  };
}

function expiredCard(sub: string, reason?: string): ShopeeResult {
  return {
    outcome: "session_expired",
    card: {
      icon: "🔒",
      title: "Phiên Shopee đã hết hạn",
      subtitle: sub,
      tone: "error",
      blocks: [{
        text: "Dán lại cookie bằng:\n/shopee-login " + sub + " SPC_...=...; SPC_...=...",
        mono: true,
      }, { text: reason ?? "Cookie không còn hiệu lực." }],
      footer: "Bot sẽ nhắc lại mỗi 24 giờ cho tới khi bạn dán cookie mới.",
    },
  };
}

function failedCard(sub: string, why: string, code?: number): ShopeeResult {
  return {
    outcome: "failed",
    card: {
      icon: "⚠️",
      title: "Điểm danh Shopee thất bại",
      subtitle: sub,
      tone: "error",
      blocks: [{ text: `${why}${code !== undefined ? ` (code ${code})` : ""}` }],
      footer: "Gõ /shopee-checkin để thử lại.",
    },
  };
}

// ── Status screen ─────────────────────────────────────────────────────────

/** `/shopee` — GET settings, nothing else. */
export async function shopeeStatusCard(account: ShopeeAccount): Promise<Card> {
  let s: Envelope<WireSettings>;
  try {
    s = await shopeeSettings(account.cookie);
  } catch (e) {
    if (e instanceof ShopeeAuthError) {
      markInvalid(account, e.message);
      return expiredCard(account.name, e.message).card;
    }
    return failedCard(account.name, e instanceof Error ? e.message : String(e)).card;
  }
  if (s.code !== 0 || !s.data) {
    return failedCard(account.name, s.msg ?? `settings code ${s.code ?? "?"}`, s.code).card;
  }
  if (s.data.login === false) {
    markInvalid(account, "Shopee báo chưa đăng nhập");
    return expiredCard(account.name, account.invalidReason).card;
  }
  clearInvalid(account);
  if (s.data.userid && s.data.userid !== "-") account.userid = s.data.userid;
  store.touch();

  const d = s.data;
  const idx = d.today_index ?? 0;
  const list = d.checkin_list ?? [];
  const total = list.length || 8;
  const rewards = d.checkin_reward_list ?? [];
  const schedule = (rewards.length ? rewards.map((r) => num(r.val)) : list.map((v) => num(v)))
    .join(" · ");

  return {
    icon: "🪙",
    title: "Shopee Xu — điểm danh",
    subtitle: account.name,
    tone: d.checked_in_today ? "success" : "info",
    stats: [
      { label: "Hôm nay", value: d.checked_in_today ? "✅ Đã điểm danh" : "⏳ Chưa" },
      { label: "Thưởng hôm nay", value: `${num(d.checked_in_today_amount)} Xu` },
      { label: "Ngày", value: `${idx + 1}/${total}` },
      { label: "Auto", value: account.autoCheckIn ? "Bật" : "Tắt" },
    ],
    blocks: [
      {
        heading: `Chuỗi ${total} ngày`,
        text: `Thưởng: ${schedule}`,
        mono: true,
      },
      {
        heading: "Mốc thời gian",
        text: `Server ${d["@timestamp"] ?? "—"} · hoạt động ${d.activity_id ?? "—"}\n` +
          "Múi giờ server +08:00, Việt Nam +07:00" +
          (d.fraud_detected ? "\n⚠️ fraud_detected" : ""),
      },
    ],
    footer: account.lastCheckInDay
      ? `Bot ghi nhận điểm danh gần nhất: ${account.lastCheckInDay}`
      : "Bot chưa ghi nhận điểm danh nào.",
  };
}
