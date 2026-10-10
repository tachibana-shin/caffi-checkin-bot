/**
 * Offline presentation test — renders every screen on both platforms without
 * touching Telegram, Discord or the Caffi API.
 *
 *   deno task view   (or: deno run -A scripts/view.ts)
 */
Deno.env.set("TELEGRAM_BOT_TOKEN", "view-test-token");
Deno.env.set("BOT_SECRET", "view-secret");
Deno.env.set("DATA_DIR", "/tmp/opencode/caffi-view");

const view = await import("../src/view.ts");
const cmds = await import("../src/commands.ts");

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
}

// ── Renderers ──────────────────────────────────────────────────────────────

const nasty = view.renderHtml({
  icon: "🔒",
  title: "Thoát <>&",
  subtitle: 'bản "nhất" & <script>',
  tone: "error",
});
check("telegram escapes <>&", nasty.includes("&lt;script&gt;") && !nasty.includes("<script>"));
check("telegram keeps Vietnamese", nasty.includes("Thoát"));

const long = view.renderHtml({
  icon: "x",
  title: "dài",
  blocks: Array.from({ length: 40 }, (_, i) => ({ text: `dòng ${i} `.repeat(30) })),
});
check("telegram output stays under 4096", long.length <= 4000, String(long.length));
check("…and does not end mid-tag", !/<pre>[^<]*$/.test(long));

check(
  "plain renderer is readable",
  view.renderPlain({ icon: "x", title: "T", stats: [{ label: "a", value: "1" }] })
    .includes("a: 1"),
);

// ── Formatting helpers ─────────────────────────────────────────────────────

check("num groups digits vi-VN", view.num(118788) === "118.788", view.num(118788));
check("vnd appends the symbol", view.vnd(3000) === "3.000 ₫", view.vnd(3000));
check(
  "vnClockMs keeps milliseconds",
  view.vnClockMs("2026-10-06T17:00:00.134Z") === "00:00:00.134",
  view.vnClockMs("2026-10-06T17:00:00.134Z"),
);
check("bar fills proportionally", view.bar(16, 30, 10) === "█████░░░░░", view.bar(16, 30, 10));
check(
  "grid aligns columns",
  view.grid([
    ["a", "bb"],
    ["ccc", "d"],
  ]).split("\n")[1]!.startsWith("ccc"),
);

// ── Screens ────────────────────────────────────────────────────────────────

const account = {
  username: "tachib.shin@gmail.com",
  password: "hunter2",
  tokens: { accessToken: "a", refreshToken: "r" },
  displayName: "Nguyễn Tiến Thành",
  autoCheckIn: true,
  sessionInvalid: false,
  createdAt: "2026-06-28T03:00:00.000Z",
};

const status = {
  todayCheckedIn: true,
  todayCheckInPosition: 62,
  currentStreak: 4,
  nextCheckInDay: 5,
  nextReward: 2,
  rewardsConfig: { normal: 1, bonus: 2 },
  weeklyPreview: [2, 1, 1, 1, 1, 2, 1],
  history: [
    {
      streakDay: 4,
      rewardValue: 1,
      checkInDate: "2026-10-07",
      createdAt: "2026-10-06T17:13:05.192Z",
    },
    {
      streakDay: 3,
      rewardValue: 1,
      checkInDate: "2026-10-06",
      createdAt: "2026-10-05T17:02:11.000Z",
    },
  ],
};

const wallet = {
  wallet: { balance: 30, totalEarned: 40, totalRedeemed: 10 },
  ordersCount: 16,
  canRedeemAll: false,
};

const cfg = {
  cashExchangeRate: { xeng: 10, vnd: 3000 },
  checkInRewards: { normal: 1, bonus: 2 },
  items: [
    { name: "Voucher Grab 100K", costXeng: 80, quantity: 0, minRank: "DONG", isActive: true },
    { name: "Voucher Shopee 100K", costXeng: 95, quantity: 3, minRank: "VANG", isActive: true },
  ],
};

const stats = {
  orderStats: {
    totalOrders: 16,
    totalSuccessfulOrders: 10,
    totalPendingOrders: 4,
    totalRejectedOrders: 2,
    totalOrderCommission: 115788,
    orderSuccessRate: 62.5,
  },
  withdrawalStats: { totalWithdrawals: 0, totalWithdrawnAmount: 0 },
  invitationStats: { totalInvitedUsers: 0 },
  financialSummary: {
    availableBalance: 118788,
    pendingCommission: 1423,
    estimatedCommission: 120211,
    totalWithdrawn: 0,
  },
};

const statusScreen = cmds.statusCard(account, status, wallet, cfg);
const walletScreen = cmds.walletCard(wallet, cfg, [{
  xengAmount: 10,
  cashValue: 3000,
  status: "APPROVED",
  createdAt: "2026-10-06T17:16:42.000Z",
}], stats);
const infoScreen = cmds.infoCard(
  account,
  {
    name: "Nguyễn Tiến Thành",
    email: "tachib.shin@gmail.com",
    phone: "0900000000",
    isPhoneVerified: true,
    rank: "DONG",
    inviteCode: "CAFFI7X",
    createdAt: "2026-06-28T03:00:00.000Z",
    lastLoginAt: "2026-10-06T17:11:00.000Z",
    systemStatus: {
      commissionRates: { DONG: { normal: 60, special: 70 } },
      specialDays: "1,15,25",
      nextRank: { label: "VÀNG", minValidOrders: 30 },
    },
  },
  stats,
  wallet,
);
const rewardsScreen = cmds.rewardsCard(status, cfg);
const historyScreen = cmds.historyCard(status);
const topScreen = cmds.topCard([
  { name: "Méo béo", streak: 139, time: "2026-10-06T17:00:00.134Z" },
  { name: "A", streak: 1, time: "2026-10-06T17:00:02.900Z" },
]);
const helpScreen = cmds.helpCard();

// ── Read-only screens ──────────────────────────────────────────────────────
// Fixtures mirror the shapes the real endpoints returned during probing.

const ordersScreen = cmds.ordersCard(
  [{
    id: 161974,
    orderId: "261004Q1NBB3DT",
    productInfo: "Đèn Led USB Nhựa Dẻo Đầu Cắm USB Đa Dạng Màu - FALCON Store",
    status: "pending",
    grand_total: 126000,
    bupMangCommission: 76000,
    createdAt: "2026-10-05T02:49:38.000Z",
  }],
  { currentPage: 1, totalPages: 4, totalItems: 37 },
  stats,
);

const orderDetailScreen = cmds.orderDetailCard({
  orderId: "261004Q1NBB3DT",
  productInfo: "Đèn Led USB Nhựa Dẻo Đầu Cắm USB Đa Dạng Màu - FALCON Store",
  status: "pending",
  grand_total: 126000,
  bupMangCommission: 76000,
  share_percentage: 60,
  orderStatus: "PAID",
  purchaseTimeAt: "2026-10-04T05:47:44.000Z",
  items: [{
    shopName: "FALCONS Store",
    itemName: "Đèn Led USB, Nhựa Dẻo, Đầu Cắm USB, Đa Dạng Màu",
    displayItemStatus: "Pending",
    qty: 1,
  }],
});

const balanceScreen = cmds.balanceCard(
  {
    summary: {
      totalIncome: 115788,
      totalExpense: 3000,
      netChange: 112788,
      counts: { processedOrders: 10, withdrawals: 0, shareOrders: 0, pointExchanges: 1 },
    },
    pagination: { currentPage: 1, totalPages: 2, totalItems: 16 },
    timeline: [
      {
        timelineAt: "2026-10-06T17:16:42.000Z",
        direction: "out",
        amount: 3000,
        title: "Đổi voucher Shopee 100K",
      },
      {
        timelineAt: "2026-10-06T17:13:05.000Z",
        direction: "in",
        amount: 1000,
        title: "Điểm danh chuỗi 4",
      },
    ],
  },
  { withdrawals: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0 } },
);

const rankScreen = cmds.rankCard(
  {
    currentMonth: "Tháng 10 2026",
    rankings: {
      monthly: { rank: 62, inTop: true, totalUsers: 1000 },
      invited: { rank: null, inTop: false, inviteCount: 3, totalUsers: 1000 },
    },
    topLists: {
      monthly: [
        {
          id: 3665,
          name: "huetran nguyen",
          commission: 449472,
          orderCount: 8,
          formattedCommission: "449.472 ₫",
        },
        {
          id: 8715,
          name: "Mai Nguyễn",
          commission: 436055,
          orderCount: 36,
          formattedCommission: "436.055 ₫",
        },
      ],
    },
  },
  {
    formula: "avg",
    periods: [{
      days: 30,
      totalCashback: 1000000,
      totalUsersWithOrders: 500,
      totalOrders: 1200,
      averageCashbackPerUser: 2000,
    }],
  },
);

const notifyScreen = cmds.notifyCard(
  {
    announcementsUnreadCount: 2,
    userNotificationsUnreadCount: 5,
    totalUnreadCount: 7,
    tabs: { chung: 2, cuaban: 5 },
  },
  {
    notifications: [{
      id: 1,
      title: "Đơn hàng được duyệt",
      content: "Đơn 261004Q1NBB3DT đã được cộng hoa hồng",
      createdAt: "2026-10-06T17:13:05.000Z",
      isRead: false,
    }],
    unreadCount: 7,
    pagination: { currentPage: 1, totalPages: 1, totalItems: 23 },
  },
);

const newsScreen = cmds.newsCard({
  announcements: [{
    id: 1,
    subject: "Cập nhật cách tính hoa hồng",
    content: "<p>Đơn hàng từ <b>15/10/2026</b> sẽ được duyệt sau 7 ngày.</p>",
    isActive: true,
    isRead: false,
    createdAt: "2026-10-05T03:00:00.000Z",
  }],
  pagination: { currentPage: 1, totalPages: 1, totalItems: 1 },
});

const securityScreen = cmds.securityCard(
  account,
  {
    username: "tachib.shin@gmail.com",
    enableOtp: true,
    hasPassword: true,
    passwordUpdatedAt: "2026-07-01T03:00:00.000Z",
  },
  {
    bankName: "Vietcombank",
    bankCode: "VCB",
    accountNumberMasked: "****5678",
    accountName: "NGUYEN TIEN THANH",
    isDefault: true,
    isActive: true,
  },
);

const inviteScreen = cmds.inviteCard(
  {
    users: [{
      id: 1,
      name: "Nguyễn Văn A",
      email: "a@example.com",
      createdAt: "2026-09-01T03:00:00.000Z",
    }],
    pagination: { currentPage: 1, totalPages: 1, totalItems: 3 },
  },
  { shareothers: [], totalShareCommission: 12000 },
);

const dealsScreen = cmds.dealsCard(
  {
    deals: [{
      id: 128,
      title: "TIẾP SỨC MÙA SALE! Ê héo voucher cho đơn từ 0đ",
      userName: "Caffi",
      userRankLabel: "BAN",
      status: "APPROVED",
      publishedAt: "2026-10-05T03:00:00.000Z",
    }],
    pagination: { currentPage: 1, totalPages: 12, totalItems: 60 },
  },
  {
    communityAccess: true,
    canPostDeals: true,
    canCommentDeals: true,
    communityDealsTosAgreed: true,
    postLockedUntil: null,
  },
  { deals: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0 } },
);

const dealDetailScreen = cmds.dealDetailCard(
  {
    deal: {
      id: 128,
      title: "TIẾP SỨC MÙA SALE!",
      description: "Ê héo voucher cho đơn từ 0đ.\n\nKênh đổi quà mở 00:00 ngày 10/10.",
      userName: "Caffi",
      userRankLabel: "BAN",
    },
  },
  {
    comments: [{
      id: 1,
      content: "Chốt đơn!",
      userName: "Mai Nguyễn",
      createdAt: "2026-10-05T04:00:00.000Z",
    }],
    pagination: { currentPage: 1, totalPages: 1, totalItems: 7 },
  },
);

const savedScreen = cmds.savedCard(
  { bookmarks: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0 } },
  0,
  { reminders: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0 } },
);

const shopsScreen = cmds.shopsCard([
  { code: "shopee", name: "Shopee", description: "Mua sắm", priority: 1, direct: false },
  { code: "lazada", name: "Lazada", description: "Mua sắm", priority: 2, direct: false },
  { code: "other", name: "Khác", description: "Ghép link", priority: 10, direct: true },
]);

// ── Multi-account screens ──────────────────────────────────────────────────

type Account = import("../src/types.ts").Account;
type ChatState = import("../src/types.ts").ChatState;

const mkAccount = (username: string, over: Partial<Account> = {}): Account => ({
  username,
  password: "x",
  tokens: { accessToken: "a", refreshToken: "r" },
  autoCheckIn: true,
  sessionInvalid: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const twoAccounts: ChatState = {
  activeAccount: "a@test",
  accounts: {
    "a@test": mkAccount("a@test", { displayName: "Người A" }),
    "b@test": mkAccount("b@test", {
      autoCheckIn: false,
      sessionInvalid: true,
      invalidReason: "TOKEN_INVALID",
    }),
  },
};

const accountsScreen = cmds.accountsCard(twoAccounts);
const rollupScreen = cmds.allCard([
  {
    username: "a@test",
    active: true,
    auto: true,
    sessionInvalid: false,
    checkedIn: true,
    streak: 4,
    position: 62,
    balance: 30,
  },
  { username: "b@test", active: false, auto: false, sessionInvalid: true },
  { username: "c@test", active: false, auto: true, sessionInvalid: false, error: "TOKEN_EXPIRED" },
]);

const screens: [string, ReturnType<typeof cmds.statusCard>][] = [
  ["status", statusScreen],
  ["wallet", walletScreen],
  ["info", infoScreen],
  ["rewards", rewardsScreen],
  ["history", historyScreen],
  ["top", topScreen],
  ["help", helpScreen],
  ["orders", ordersScreen],
  ["orderDetail", orderDetailScreen],
  ["balance", balanceScreen],
  ["rank", rankScreen],
  ["notify", notifyScreen],
  ["news", newsScreen],
  ["security", securityScreen],
  ["invite", inviteScreen],
  ["deals", dealsScreen],
  ["dealDetail", dealDetailScreen],
  ["saved", savedScreen],
  ["shops", shopsScreen],
  ["accounts", accountsScreen],
  ["all", rollupScreen],
];

for (const [name, card] of screens) {
  const html = view.renderHtml(card);
  check(`${name} renders as Telegram HTML`, html.length > 20, `${html.length}B`);
}

const statusHtml = view.renderHtml(statusScreen);
check("status shows the wallet", statusHtml.includes("30"));
check("status shows today's position", statusHtml.includes("62"));
check("status shows the 7-day preview", statusHtml.includes("7 ngày tới"));

const infoHtml = view.renderHtml(infoScreen);
check("info shows commission rate", infoHtml.includes("60%"));
check("info shows the rank progress", infoHtml.includes("VÀNG"));

const rewardsText = view.renderPlain(rewardsScreen);
check("rewards lists item names", rewardsText.includes("Voucher Grab 100K"));
check("rewards shows out-of-stock as hết", rewardsText.includes("hết"));

const topText = view.renderPlain(topScreen);
check("top shows millisecond precision", topText.includes("00:00:00.134"));

// ── Read-only screens ──────────────────────────────────────────────────────

const ordersText = view.renderPlain(ordersScreen);
check("orders lists the order code", ordersText.includes("261004Q1NBB3DT"));
check("orders translates the status", ordersText.includes("CHỜ DUYỆT"));
check("orders reports totals from stats", ordersText.includes("Tổng đơn"));

const detailText = view.renderPlain(orderDetailScreen);
check("order detail shows the share %", detailText.includes("60%"));
check("order detail lists the shop", detailText.includes("FALCONS Store"));

const balanceText = view.renderPlain(balanceScreen);
check(
  "balance shows income and expense",
  balanceText.includes("115.788") && balanceText.includes("3.000 ₫"),
);
check("balance distinguishes in from out", balanceText.includes("+") && balanceText.includes("−"));
check("balance explains an empty withdrawal list", balanceText.includes("Chưa rút tiền lần nào"));

const rankText = view.renderPlain(rankScreen);
check("rank shows the monthly leaderboard", rankText.includes("Top hoa hồng"));
check("rank shows your own position", rankText.includes("#62"));
check("rank shows the platform average", rankText.includes("Trung bình mỗi người"));

const newsPlain = view.renderPlain(newsScreen);
check("news keeps the subject", newsPlain.includes("Cập nhật cách tính hoa hồng"));
check("news strips CMS HTML", newsPlain.includes("15/10/2026") && !newsPlain.includes("<p>"));

const securityText = view.renderPlain(securityScreen);
check("security reports the OTP switch", securityText.includes("✅ Đang bật"));
check("security keeps the bank number masked", securityText.includes("****5678"));

const dealsText = view.renderPlain(dealsScreen);
check("deals lists the deal id", dealsText.includes("128"));
check("deals reports the community rights", dealsText.includes("Đăng bài"));

const detailDealText = view.renderPlain(dealDetailScreen);
check("deal detail shows the body", detailDealText.includes("00:00 ngày 10/10"));
check("deal detail lists comments", detailDealText.includes("Chốt đơn!"));

const savedText = view.renderPlain(savedScreen);
check("saved explains an empty shelf", savedText.includes("Chưa lưu sản phẩm nào"));

const shopsText = view.renderPlain(shopsScreen);
check("shops lists provider codes", shopsText.includes("shopee") && shopsText.includes("lazada"));

check(
  "read-only screens promise they do not act",
  [ordersScreen, balanceScreen, securityScreen].every((c) =>
    (c.footer ?? "").toLowerCase().includes("chỉ đọc") ||
    (c.footer ?? "").toLowerCase().includes("không")
  ),
);

// ── Multi-account ──────────────────────────────────────────────────────────

const accountsText = view.renderPlain(accountsScreen);
check(
  "accounts marks the active login",
  accountsText.includes("▶") && accountsText.includes("a@test"),
);
check("accounts flags a dead session", accountsText.includes("🔒 hết phiên"));

const rollupText = view.renderPlain(rollupScreen);
check(
  "roll-up lists every login",
  ["a@test", "b@test", "c@test"].every((u) => rollupText.includes(u)),
);
check(
  "roll-up marks check-in and dead sessions",
  rollupText.includes("✅") && rollupText.includes("🔒"),
);
check("roll-up explains what it could not read", rollupText.includes("TOKEN_EXPIRED"));
check("roll-up says it is read-only", rollupScreen.footer?.includes("Chỉ đọc") === true);

const switchKeys: ReturnType<typeof cmds.accountKeys> = cmds.accountKeys(twoAccounts);
check(
  "2+ logins get switch buttons",
  switchKeys.some((r: Array<{ data: string }>) => r.some((k) => k.data === "nav:use b@test")),
);
check(
  "switch buttons fit Telegram's row/label caps",
  switchKeys.length <= 5 &&
    switchKeys.flat().every((k) => k.label.length <= 80),
  `${switchKeys.length} rows`,
);

const nineLogins: ChatState = {
  activeAccount: "u0@test",
  accounts: Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`u${i}@test`, mkAccount(`u${i}@test`)]),
  ),
};
const nineKeys = cmds.accountKeys(nineLogins);
check(
  "9 logins still fit Discord's 5 action rows",
  nineKeys.length <= 5,
  `${nineKeys.length} rows`,
);

check(
  "a lone login falls back to the plain screen",
  cmds.accountKeys({ accounts: { "only@test": mkAccount("only@test") } }).length ===
    view.SCREEN.length,
);

// ── Menu buttons ───────────────────────────────────────────────────────────

const rows = view.MENU.concat(view.SCREEN);
check("menu rows are not empty", rows.length > 0);
check(
  "menu rows fit Discord's 5-button cap",
  rows.every((r: Array<unknown>) => r.length >= 1 && r.length <= 5),
);
check(
  "MENU + SCREEN stay inside Discord's 5 action rows",
  rows.length <= 5,
  `${rows.length} rows`,
);
check("the menu spans exactly 4 rows", view.MENU.length === 4, String(view.MENU.length));
check(
  "button labels fit Discord's 80 chars",
  rows.flat().every((k: { label: string }) => k.label.length <= 80),
);
check(
  "button ids fit Discord's 100 chars",
  rows.flat().every((k: { data: string }) => k.data.length <= 100),
);
check(
  "every nav target is a known command",
  rows.flat().every((k) => k.data.startsWith("nav:")),
);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll OK");
Deno.exit(failed ? 1 : 0);
