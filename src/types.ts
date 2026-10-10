export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface Account {
  username: string;
  /** Kept so the bot can resend OTPs and re-login after the server drops the session. */
  password: string;
  tokens: Tokens;
  displayName?: string;
  /** Per-account auto check-in switch. Defaults to true. */
  autoCheckIn: boolean;
  /** true when the server invalidated the session; the user must /login again. */
  sessionInvalid: boolean;
  invalidReason?: string;
  /** "YYYY-MM-DD" in Asia/Ho_Chi_Minh — last day the bot processed a check-in for. */
  lastCheckInDay?: string;
  lastCheckInResult?: string;
  /** Epoch ms of the last "session dropped, please re-login" reminder (anti-spam). */
  lastInvalidRemindAt?: number;
  createdAt: string;
}

export interface PendingLogin {
  username: string;
  password: string;
  challengeId: string;
  sentTo?: string;
  retryAfterSeconds?: number;
  expiresAt: number;
}

export interface ChatState {
  activeAccount?: string;
  accounts: Record<string, Account>;
  pending?: PendingLogin;
  /** Which screen is open — lets the "Làm mới" button know what to redraw. */
  lastNav?: string;
}

export interface StoreData {
  version: 1;
  chats: Record<string, ChatState>;
  /** VN date the automatic run was last *started* — stops a double fire. */
  lastAutoRunDate?: string;
  /** VN date the automatic run last *finished* — lets a catch-up retry a crash. */
  lastAutoRunDoneDate?: string;
}

/**
 * The live shape of GET /api/v2/xeng/check-in/status — the server sends exactly
 * these 8 keys, nothing else (verified against production 07-10-2026). In
 * particular there is **no** `checkedInAt`: the time of the newest check-in is
 * `history[0].createdAt`, in UTC.
 */
export interface CheckInStatus {
  todayCheckedIn?: boolean;
  /** Where the account landed in today's order — 1 is first at midnight. */
  todayCheckInPosition?: number;
  currentStreak?: number;
  nextReward?: number;
  nextCheckInDay?: number;
  rewardsConfig?: { normal?: number; bonus?: number };
  weeklyPreview?: number[];
  history?: Array<{
    streakDay?: number;
    rewardValue?: number;
    checkInDate?: string;
    /** UTC instant the server wrote the row. */
    createdAt?: string;
  }>;
}

export interface Wallet {
  /** The server nests the balance one level deep: response.wallet.balance
   *  (the app reads it the same way: r45.wallet.balance). */
  wallet?: { balance?: number; totalEarned?: number; totalRedeemed?: number };
  ordersCount?: number;
  canRedeemAll?: boolean;
  maxRedeemLimit?: number | null;
  /** Newest first. One entry per check-in (`source: "DAILY_CHECKIN"`). */
  logs?: Array<{
    amount?: number;
    source?: string;
    note?: string;
    createdAt?: string;
  }>;
  redemptions?: RedeemRecord[];
}

export interface RedeemRecord {
  id?: number;
  type?: string;
  xengAmount?: number;
  /** What the app actually pays out for `xengAmount`, in đồng. */
  cashValue?: number;
  status?: string;
  adminNote?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** GET /api/v2/xeng/redeem/history */
export interface RedeemHistory {
  items?: RedeemRecord[];
  pagination?: { page?: number; limit?: number; total?: number; totalPages?: number };
}

/**
 * GET /api/v2/xeng/config — the official conversion rate plus the catalogue of
 * things Xèng can be traded for. The bot only ever READS this; it never calls
 * `redeem/cash` or `redeem/item`.
 */
export interface XengConfig {
  cashExchangeRate?: { xeng?: number; vnd?: number };
  checkInRewards?: { normal?: number; bonus?: number };
  items?: XengItem[];
  waitingAppleStoreVersion?: string;
}

export interface XengItem {
  name?: string;
  code?: string;
  costXeng?: number;
  /** Stock. 0 means the reward is currently out of stock. */
  quantity?: number;
  /** Lowest rank allowed to redeem it. */
  minRank?: string;
  isActive?: boolean;
  imgUrl?: string;
}

/** GET /api/v2/user/stats — commission and order figures, all in đồng. */
export interface UserStats {
  user?: {
    id?: number;
    name?: string;
    email?: string;
    rank?: string;
    joinedDate?: string;
  };
  orderStats?: {
    totalOrders?: number;
    totalSuccessfulOrders?: number;
    totalPendingOrders?: number;
    totalRejectedOrders?: number;
    totalOrderCommission?: number;
    totalPendingOderCommission?: number;
    orderSuccessRate?: number;
  };
  shareOrderStats?: {
    totalShareOrders?: number;
    totalShareCommission?: number;
    shareOrderSuccessRate?: number;
  };
  withdrawalStats?: {
    totalWithdrawals?: number;
    totalSuccessfulWithdrawals?: number;
    totalWithdrawnAmount?: number;
    totalPendingWithdrawals?: number;
  };
  invitationStats?: { totalInvitedUsers?: number };
  financialSummary?: {
    availableBalance?: number;
    totalEarned?: number;
    totalWithdrawn?: number;
    pendingCommission?: number;
    estimatedCommission?: number;
    checkInApprovedCommission?: number;
  };
}

export interface UserInfo {
  user?: Record<string, unknown>;
  displayName?: string;
  name?: string;
  email?: string;
  systemStatus?: unknown;
  [k: string]: unknown;
}

/** One row of GET /api/v2/xeng/check-in/earliest — the day's fastest check-ins. */
export interface EarlyEntry {
  name?: string;
  streak?: number;
  /** ISO instant the server recorded, UTC. */
  time?: string;
}

// ── Read-only surface beyond the check-in flow ─────────────────────────────
// Everything below is served by GET endpoints. The bot never writes to any of
// them — no redeem, no withdrawal, no profile edit, no mark-as-read.

/** The pagination block most list endpoints share (key names vary slightly). */
export interface Page {
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  itemsPerPage?: number;
  hasNextPage?: boolean;
}

export interface OrderRow {
  id?: number;
  orderId?: string;
  productInfo?: string;
  status?: string;
  /** Shelf price of the order in đồng. */
  grand_total?: number;
  /** Commission the shop pays out, in đồng. */
  bupMangCommission?: number;
  share_percentage?: number;
  isPreApproved?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrderList {
  orders?: OrderRow[];
  pagination?: Page;
}

export interface OrderItemRow {
  shopName?: string;
  itemName?: string;
  displayItemStatus?: string;
  qty?: number;
  /** Shopee reports money as a string of the amount in cents. */
  itemPrice?: string;
  actualAmount?: string;
  categoryLv1Name?: string;
}

/** GET /api/v2/orders/details?order_id=… — one list row plus its line items. */
export interface OrderDetail extends OrderRow {
  purchaseTimeAt?: string;
  completeTimeAt?: string | null;
  cancelReason?: string;
  orderStatus?: string;
  items?: OrderItemRow[];
}

export interface TimelineEntry {
  id?: string;
  type?: string;
  title?: string;
  direction?: "in" | "out";
  amount?: number;
  signedAmount?: number;
  status?: string;
  timelineAt?: string;
  metadata?: { orderId?: string; productInfo?: string; [k: string]: unknown };
}

/** GET /api/v2/balance-timeline — every movement of the commission balance. */
export interface BalanceTimeline {
  summary?: {
    totalIncome?: number;
    totalExpense?: number;
    netChange?: number;
    counts?: {
      processedOrders?: number;
      withdrawals?: number;
      shareOrders?: number;
      pointExchanges?: number;
    };
  };
  pagination?: Page;
  timeline?: TimelineEntry[];
}

export interface WithdrawalRow {
  id?: number;
  amount?: number;
  status?: string;
  bankName?: string;
  accountNumberMasked?: string;
  createdAt?: string;
}

export interface WithdrawalList {
  withdrawals?: WithdrawalRow[];
  pagination?: Page;
}

export interface InvitedUser {
  id?: number;
  name?: string;
  email?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface InvitedList {
  users?: InvitedUser[];
  pagination?: Page;
}

/** GET /api/v2/shareother — commission earned by sharing your own posts. */
export interface ShareOther {
  shareothers?: Array<{ [k: string]: unknown }>;
  totalShareCommission?: number;
}

export interface NotificationRow {
  id?: number;
  title?: string;
  content?: string;
  type?: string;
  isRead?: boolean;
  actionUrl?: string;
  createdAt?: string;
}

export interface NotificationList {
  notifications?: NotificationRow[];
  unreadCount?: number;
  pagination?: Page;
}

export interface NotificationSummary {
  announcementsUnreadCount?: number;
  userNotificationsUnreadCount?: number;
  totalUnreadCount?: number;
  tabs?: { chung?: number; cuaban?: number };
}

export interface AnnouncementRow {
  id?: number;
  subject?: string;
  /** Raw HTML from the CMS — always stripped before it reaches a message. */
  content?: string;
  isActive?: boolean;
  isRead?: boolean;
  createdAt?: string;
}

export interface AnnouncementList {
  announcements?: AnnouncementRow[];
  pagination?: Page;
}

export interface RankEntry {
  id?: number;
  name?: string;
  email?: string;
  commission?: number;
  orderCount?: number;
  formattedCommission?: string;
  lastUpdated?: string;
}

/** GET /api/v2/user-rank — where you stand plus the public leaderboards. */
export interface UserRank {
  currentMonth?: string;
  rankings?: {
    monthly?: { rank?: number | null; inTop?: boolean; totalUsers?: number };
    allTime?: { rank?: number | null; inTop?: boolean; totalUsers?: number };
    invited?: { rank?: number | null; inTop?: boolean; inviteCount?: number; totalUsers?: number };
  };
  topLists?: { monthly?: RankEntry[]; allTime?: RankEntry[]; invited?: RankEntry[] };
}

/** GET /api/v2/cashback-averages?days=… — platform-wide, not personal. */
export interface CashbackAverage {
  formula?: string;
  periods?: Array<{
    days?: number;
    totalCashback?: number;
    totalUsersWithOrders?: number;
    totalOrders?: number;
    averageCashbackPerUser?: number;
  }>;
  calculatedAt?: string;
}

export interface SecurityStatus {
  username?: string | null;
  enableOtp?: boolean;
  hasPassword?: boolean;
  passwordUpdatedAt?: string;
}

export interface PaymentMethod {
  bankName?: string;
  bankCode?: string;
  accountNumberMasked?: string;
  accountName?: string;
  isDefault?: boolean;
  isActive?: boolean;
  updatedAt?: string;
}

export interface DealRow {
  id?: number;
  title?: string;
  description?: string;
  postType?: string;
  status?: string;
  userName?: string;
  userRankLabel?: string;
  publishedAt?: string;
  createdAt?: string;
}

export interface DealList {
  deals?: DealRow[];
  pagination?: Page;
}

export interface DealComment {
  id?: number;
  dealId?: number;
  content?: string;
  status?: string;
  userName?: string;
  userRankLabel?: string;
  createdAt?: string;
}

export interface DealCommentList {
  comments?: DealComment[];
  pagination?: Page;
}

/** GET /api/v2/deals/{id} — wrapped in a `deal` key, unlike the list. */
export interface DealDetail {
  deal?: DealRow & { description?: string; productLink?: string; commentCount?: number };
  [k: string]: unknown;
}

export interface CommunityStatus {
  communityDealsTosAgreed?: boolean;
  communityAccess?: boolean;
  canPostDeals?: boolean;
  canCommentDeals?: boolean;
  postLockedUntil?: string | null;
}

export interface BookmarkList {
  bookmarks?: Array<{ [k: string]: unknown }>;
  pagination?: Page;
}

export interface ReminderList {
  reminders?: Array<{ [k: string]: unknown }>;
  pagination?: Page;
}

/** GET /api/v2/router/providers — the shops the link router understands. */
export interface Provider {
  code?: string;
  name?: string;
  description?: string;
  priority?: number;
  direct?: boolean;
}
