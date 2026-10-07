/**
 * Client for the Caffi app API (vn.caffiliate.customer).
 * Reverse-engineered from assets/index.android.bundle (Hermes bytecode) in the APK.
 */
import type {
  AnnouncementList,
  BalanceTimeline,
  BookmarkList,
  CashbackAverage,
  CheckInStatus,
  CommunityStatus,
  DealCommentList,
  DealDetail,
  DealList,
  EarlyEntry,
  InvitedList,
  NotificationList,
  NotificationSummary,
  OrderDetail,
  OrderList,
  PaymentMethod,
  Provider,
  RedeemHistory,
  ReminderList,
  SecurityStatus,
  ShareOther,
  Tokens,
  UserInfo,
  UserRank,
  UserStats,
  Wallet,
  WithdrawalList,
  XengConfig,
} from "./types.ts";

// deno-lint-ignore no-explicit-any -- loosely typed JSON straight from the app's API.
type Json = any;

const BASE = "https://client-api.caffiliate.vn";

/** Exactly what getDeviceInfo() sends: slug + platform + versionName. */
export const DEVICE_INFO = {
  deviceId: "caffiliate-mobile",
  platform: "android",
  appVersion: "1.4.2",
};

const TIMEOUT_MS = 15_000;

/** Error codes that mean "session is gone, the user must log in again". */
const SESSION_DEAD_CODES = new Set([
  "TOKEN_INVALID",
  "TOKEN_EXPIRED",
  "NOT_AUTHENTICATED",
  "SESSION_EXPIRED",
  "UNAUTHORIZED",
]);

export class CaffiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CaffiError";
  }
}

/** The server dropped the session — the user must send /login again. */
export class SessionExpiredError extends CaffiError {
  constructor(message: string, code?: string) {
    super(message, code, 401);
    this.name = "SessionExpiredError";
  }
}

export type LoginResult =
  | { kind: "otp_required"; challengeId: string; sentTo?: string; retryAfterSeconds?: number }
  | { kind: "success"; tokens: Tokens; displayName?: string };

interface RawResponse {
  status: number;
  body: Json;
}

async function raw(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new CaffiError(`Không kết nối được máy chủ: ${(e as Error).message}`, "NETWORK");
  }

  let body: Json = null;
  try {
    body = await res.json();
  } catch {
    /* body is not JSON */
  }
  return { status: res.status, body };
}

function errorFrom(r: RawResponse): CaffiError {
  const code = r.body?.error?.code ??
    (r.status === 401 ? "NOT_AUTHENTICATED" : `HTTP_${r.status}`);
  const message = r.body?.error?.message ?? r.body?.message ?? `Lỗi HTTP ${r.status}`;
  return new CaffiError(message, code, r.status);
}

function unwrap<T>(r: RawResponse): T {
  if (r.status >= 400 || r.body?.success === false) throw errorFrom(r);
  return (r.body?.data !== undefined ? r.body.data : r.body) as T;
}

/** `qs({ page: 1, limit: 10 })` -> `"?page=1&limit=10"` (empty keys dropped). */
function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface SessionHandle {
  getTokens(): Tokens;
  saveTokens(tokens: Tokens): void;
  clearSession(reason: string): void;
}

/** Client that refreshes proactively — mirrors the app's axios interceptor. */
export class CaffiApi {
  constructor(private session: SessionHandle) {}

  /** Call an authed endpoint, refreshing once when the access token expires. */
  async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let tokens = this.session.getTokens();
    let r = await raw(path, { ...init, token: tokens.accessToken });

    if (r.status === 401 && SESSION_DEAD_CODES.has(r.body?.error?.code ?? "")) {
      if (!tokens.refreshToken) {
        this.#kill("Thiếu refresh token");
        throw new SessionExpiredError("Phiên đã hết hạn", r.body?.error?.code);
      }
      try {
        tokens = await this.refresh(tokens.refreshToken);
        this.session.saveTokens(tokens);
      } catch (e) {
        const code = (e as CaffiError).code;
        this.session.clearSession("Refresh token bị từ chối");
        throw new SessionExpiredError(
          `Không làm mới được phiên: ${(e as Error).message}`,
          code,
        );
      }
      r = await raw(path, { ...init, token: tokens.accessToken });
      if (r.status === 401) {
        const code = r.body?.error?.code;
        this.session.clearSession("Vẫn 401 sau khi refresh");
        throw new SessionExpiredError(
          r.body?.error?.message ?? "Phiên đã bị đăng xuất",
          code,
        );
      }
    }
    return unwrap<T>(r);
  }

  private async refresh(refreshToken: string): Promise<Tokens> {
    const r = await raw("/auth/mobile/refresh", { method: "POST", body: { refreshToken } });
    const data = unwrap<{ accessToken?: string; refreshToken?: string }>(r);
    if (!data?.accessToken) {
      throw new CaffiError("Phản hồi refresh thiếu accessToken", "BAD_REFRESH");
    }
    return { accessToken: data.accessToken, refreshToken: data.refreshToken ?? refreshToken };
  }

  #kill(reason: string) {
    this.session.clearSession(reason);
  }

  // ── Auth (bypasses the interceptor) ─────────────────────────────────────

  /** Step 1: password login. The server decides whether OTP is required. */
  async passwordLogin(username: string, password: string): Promise<LoginResult> {
    const r = await raw("/auth/mobile/password-login", {
      method: "POST",
      body: { username, password, deviceInfo: DEVICE_INFO },
    });
    if (r.status >= 400 || r.body?.success === false) throw errorFrom(r);

    const data = r.body?.data ?? {};
    if (r.body?.step === "otp_required") {
      const challengeId = data.challengeId;
      if (!challengeId) throw new CaffiError("Server không trả challengeId", "BAD_OTP_CHALLENGE");
      return {
        kind: "otp_required",
        challengeId,
        sentTo: data.sentTo,
        retryAfterSeconds: data.retryAfterSeconds ?? 60,
      };
    }
    if (!data?.accessToken) {
      throw new CaffiError(r.body?.message ?? "Đăng nhập không trả về token", "BAD_LOGIN");
    }
    return { kind: "success", tokens: toTokens(data), displayName: displayNameOf(data) };
  }

  /** Step 2: verify the 6-digit OTP. */
  async verifyOtp(
    challengeId: string,
    otp: string,
  ): Promise<{ tokens: Tokens; displayName?: string }> {
    const r = await raw("/auth/mobile/password-login/verify-otp", {
      method: "POST",
      body: { challengeId, otp, deviceInfo: DEVICE_INFO },
    });
    if (r.status >= 400 || r.body?.success === false) throw errorFrom(r);
    const data = r.body?.data ?? {};
    if (!data?.accessToken) throw new CaffiError("OTP không trả về token", "BAD_OTP");
    return { tokens: toTokens(data), displayName: displayNameOf(data) };
  }

  /** Resend the OTP. Careful: this endpoint shares the 20 req / 900s rate limit. */
  async resendOtp(challengeId: string, username: string, password: string): Promise<void> {
    const r = await raw("/auth/mobile/password-login/resend-otp", {
      method: "POST",
      body: { challengeId, username, password },
    });
    if (r.status >= 400 || r.body?.success === false) throw errorFrom(r);
  }

  // ── Info ───────────────────────────────────────────────────────────────

  getCheckInStatus(): Promise<CheckInStatus> {
    return this.call<CheckInStatus>("/api/v2/xeng/check-in/status");
  }

  /** The app's "earliest check-in" query — today's fastest 10, fastest first. */
  getCheckInEarliest(): Promise<EarlyEntry[]> {
    return this.call<EarlyEntry[]>("/api/v2/xeng/check-in/earliest");
  }

  /** Takes no body — identical to postCheckIn() in the app. */
  postCheckIn(): Promise<unknown> {
    return this.call("/api/v2/xeng/check-in", { method: "POST" });
  }

  getWallet(): Promise<Wallet> {
    return this.call<Wallet>("/api/v2/xeng/wallet");
  }

  getUserInfo(): Promise<UserInfo> {
    return this.call<UserInfo>("/api/v2/user/info");
  }

  getUserStats(): Promise<UserStats> {
    return this.call<UserStats>("/api/v2/user/stats");
  }

  /** Conversion rate and the reward catalogue. Read-only. */
  getXengConfig(): Promise<XengConfig> {
    return this.call<XengConfig>("/api/v2/xeng/config");
  }

  /** Past redemptions. Read-only — the bot never calls `redeem/cash` or `redeem/item`. */
  getRedeemHistory(): Promise<RedeemHistory> {
    return this.call<RedeemHistory>("/api/v2/xeng/redeem/history");
  }

  // ── Read-only surface beyond the check-in flow ──────────────────────────
  // Every method below issues GET. The bot never writes to any of these
  // endpoints: no redeem, no withdrawal, no profile edit, no mark-as-read.

  getOrders(page = 1, limit = 10): Promise<OrderList> {
    return this.call<OrderList>(`/api/v2/orders${qs({ page, limit })}`);
  }

  /** One order with its line items. `orderId` is the shop's code, e.g. 261004Q1NBB3DT. */
  getOrderDetail(orderId: string): Promise<OrderDetail> {
    return this.call<OrderDetail>(`/api/v2/orders/details${qs({ order_id: orderId })}`);
  }

  getBalanceTimeline(page = 1, limit = 10): Promise<BalanceTimeline> {
    return this.call<BalanceTimeline>(`/api/v2/balance-timeline${qs({ page, limit })}`);
  }

  getWithdrawals(page = 1, limit = 5): Promise<WithdrawalList> {
    return this.call<WithdrawalList>(`/api/v2/withdrawals${qs({ page, limit })}`);
  }

  getInvitedUsers(page = 1, limit = 10): Promise<InvitedList> {
    return this.call<InvitedList>(`/api/v2/invited-users${qs({ page, limit })}`);
  }

  getShareOthers(): Promise<ShareOther> {
    return this.call<ShareOther>("/api/v2/shareother");
  }

  getUserNotifications(page = 1, limit = 10): Promise<NotificationList> {
    return this.call<NotificationList>(`/api/v2/notifications/user${qs({ page, limit })}`);
  }

  getNotificationSummary(): Promise<NotificationSummary> {
    return this.call<NotificationSummary>("/api/v2/notifications/summary");
  }

  /** Site-wide announcements. Deliberately does not mark anything as read. */
  getAnnouncements(page = 1, limit = 5): Promise<AnnouncementList> {
    return this.call<AnnouncementList>(
      `/api/v2/announcements${qs({ page, limit, isActive: "true" })}`,
    );
  }

  getUserRank(): Promise<UserRank> {
    return this.call<UserRank>("/api/v2/user-rank");
  }

  /** Platform-wide average cashback — context, not your own numbers. */
  getCashbackAverages(days = 30): Promise<CashbackAverage> {
    return this.call<CashbackAverage>(`/api/v2/cashback-averages${qs({ days })}`);
  }

  getSecurityStatus(): Promise<SecurityStatus> {
    return this.call<SecurityStatus>("/api/v2/profile/security");
  }

  /** The saved payout account, or null when the user never added one. */
  async getPaymentMethod(): Promise<PaymentMethod | null> {
    try {
      return await this.call<PaymentMethod>("/api/v2/profile/payment-method");
    } catch (e) {
      const err = e as CaffiError;
      if (err.status === 404 || err.code === "NOT_FOUND") return null;
      throw e;
    }
  }

  getDeals(page = 1, limit = 5): Promise<DealList> {
    return this.call<DealList>(`/api/v2/deals${qs({ page, limit })}`);
  }

  getMyDeals(page = 1, limit = 5): Promise<DealList> {
    return this.call<DealList>(`/api/v2/deals/me${qs({ page, limit })}`);
  }

  getDealDetail(id: number): Promise<DealDetail> {
    return this.call<DealDetail>(`/api/v2/deals/${id}`);
  }

  getDealComments(id: number, page = 1, limit = 5): Promise<DealCommentList> {
    return this.call<DealCommentList>(`/api/v2/deals/${id}/comments${qs({ page, limit })}`);
  }

  getCommunityStatus(): Promise<CommunityStatus> {
    return this.call<CommunityStatus>("/api/v2/deals/community-status");
  }

  getBookmarks(page = 1, limit = 10): Promise<BookmarkList> {
    return this.call<BookmarkList>(`/api/v2/bookmarks${qs({ page, limit })}`);
  }

  getBookmarkCount(): Promise<{ count?: number }> {
    return this.call<{ count?: number }>("/api/v2/bookmarks/count");
  }

  getPurchaseReminders(page = 1, limit = 5): Promise<ReminderList> {
    return this.call<ReminderList>(`/api/v2/purchase-reminders${qs({ page, limit })}`);
  }

  getProviders(): Promise<Provider[]> {
    return this.call<Provider[]>("/api/v2/router/providers");
  }
}

function toTokens(data: Json): Tokens {
  return {
    accessToken: String(data.accessToken),
    refreshToken: String(data.refreshToken ?? ""),
  };
}

function displayNameOf(data: Json): string | undefined {
  const user = data?.user ?? {};
  const name = user.displayName ?? user.name ?? user.fullName ?? user.username ??
    data?.displayName ?? data?.name;
  return typeof name === "string" && name ? name : undefined;
}
