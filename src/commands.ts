import type { CaffiError, LoginResult } from "./caffi.ts";
import { apiFor, runCheckIn, vnDate } from "./checkin.ts";
import { store } from "./store.ts";
import type { Sender } from "./telegram.ts";
import type {
  Account,
  AnnouncementList,
  BalanceTimeline,
  BookmarkList,
  CashbackAverage,
  ChatState,
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
  OrderRow,
  Page,
  PaymentMethod,
  PendingLogin,
  Provider,
  RedeemRecord,
  ReminderList,
  SecurityStatus,
  ShareOther,
  UserRank,
  UserStats,
  Wallet,
  WithdrawalList,
  XengConfig,
} from "./types.ts";
import {
  bar,
  type Card,
  grid,
  type KeyRows,
  MENU,
  num,
  SCREEN,
  shortDate,
  vnClock,
  vnClockMs,
  vnd,
} from "./view.ts";

/**
 * The router. Every entry point — a typed command, a menu button on Telegram
 * and a slash command on Discord — lands in `dispatch`, so the three surfaces
 * can never drift apart.
 *
 * Replies are Vietnamese because that is what the user reads; everything below
 * this file (and the card renderers) is platform-neutral.
 */
export interface Ctx {
  tg: Sender;
  /** Where to answer. Telegram chat id, or Discord user id — the store keys on it. */
  chatId: number | string;
  userId: number | string;
  raw: string;
  /** Set when the user pressed a button: redraw that message instead of sending. */
  editMessageId?: number;
}

export async function handleText(ctx: Ctx): Promise<void> {
  const text = ctx.raw.trim();
  if (!text) return;

  const isCommand = text.startsWith("/");
  const [cmdRaw, ...args] = text.split(/\s+/);
  // "/status@caffivn_bot" -> "status"
  const cmd = (cmdRaw ?? "").toLowerCase().replace(/^\/+/, "").split("@")[0] ?? "";

  // Not a command, waiting for OTP, and the user typed 6 digits => it is the OTP.
  if (!isCommand && store.chat(ctx.chatId).pending && /^\d{6}$/.test(text)) {
    await finishOtp(ctx, text);
    return;
  }

  if (!isCommand) {
    await reply(ctx, {
      icon: "👋",
      title: "Gõ /help để xem danh sách lệnh",
      tone: "info",
    }, MENU);
    return;
  }

  await dispatch(ctx, cmd, args);
}

/** A menu button was pressed: `data` looks like `nav:wallet` or `nav:use ten@dang.nhap`. */
export async function handleNav(ctx: Ctx, data: string): Promise<void> {
  const chat = store.chat(ctx.chatId);
  const raw = data.startsWith("nav:") ? data.slice(4) : data;
  const [head, ...rest] = raw.trim().split(/\s+/);
  const cmd = head === "refresh" ? chat.lastNav ?? "status" : head || "status";
  await dispatch(ctx, cmd, rest);
}

function dispatch(ctx: Ctx, cmd: string, args: string[]): Promise<void> {
  switch (cmd) {
    case "start":
    case "help":
      return reply(ctx, helpCard(), MENU);

    case "login":
      return doLogin(ctx, args);
    case "otp": {
      const otp = args[0];
      if (!otp) return reply(ctx, hint("Nhập mã OTP", "/otp 123456"));
      return finishOtp(ctx, otp);
    }
    case "resend":
      return doResend(ctx);
    case "cancel":
      return doCancel(ctx);

    case "status":
      return doStatus(ctx);
    case "wallet":
      return doWallet(ctx);
    case "info":
      return doInfo(ctx);
    case "rewards":
      return doRewards(ctx);
    case "history":
      return doHistory(ctx);
    case "top":
      return doTop(ctx);
    case "checkin":
      return doManualCheckIn(ctx);

    // Read-only screens. Every one of these issues GET requests only. Each may
    // take an optional `<tên tài khoản>` first argument — see targetArgs().
    case "orders":
      return doOrders(ctx);
    case "balance":
      return doBalance(ctx);
    case "rank":
      return doRank(ctx);
    case "notify":
      return doNotify(ctx);
    case "news":
      return doNews(ctx);
    case "security":
      return doSecurity(ctx);
    case "invite":
      return doInvite(ctx);
    case "deals":
      return doDeals(ctx);
    case "saved":
      return doSaved(ctx);
    case "shops":
      return doShops(ctx);
    case "all":
      return doAll(ctx);

    case "accounts":
      return doAccounts(ctx);
    case "use":
      return doUse(ctx, args[0]);
    case "auto":
      return doAuto(ctx);
    case "logout":
      return doLogout(ctx, args[0]);

    default:
      return reply(ctx, {
        icon: "🤔",
        title: "Lệnh không rõ",
        subtitle: `Không có lệnh "/${cmd}".`,
        tone: "warn",
        blocks: [{ text: "Gõ /help để xem danh sách lệnh." }],
      }, MENU);
  }
}

async function reply(ctx: Ctx, card: Card, keys?: KeyRows): Promise<void> {
  // Remember the screen so the "Làm mới" button knows what to redraw.
  const nav = NAV_SCREENS.get(card.title);
  if (nav) {
    const chat = store.chat(ctx.chatId);
    if (chat.lastNav !== nav) {
      chat.lastNav = nav;
      store.touch();
    }
  }
  await ctx.tg.send(ctx.chatId, card, { keys, editMessageId: ctx.editMessageId });
}

/** Screen titles that map back to a command — used by the refresh button. */
const NAV_SCREENS = new Map<string, string>([
  ["Tổng quan hôm nay", "status"],
  ["Ví & tiền", "wallet"],
  ["Hồ sơ", "info"],
  ["Điểm thưởng", "rewards"],
  ["Lịch sử điểm danh", "history"],
  ["Top điểm danh sớm", "top"],
  ["Tài khoản", "accounts"],
  ["Tất cả tài khoản", "all"],
  ["Caffi Auto Check-in Bot", "help"],
  ["Đơn hàng", "orders"],
  ["Chi tiết đơn hàng", "orders"],
  ["Dòng tiền", "balance"],
  ["Xếp hạng", "rank"],
  ["Thông báo", "notify"],
  ["Tin hệ thống", "news"],
  ["Bảo mật & nhận tiền", "security"],
  ["Mời bạn", "invite"],
  ["Deals nổi bật", "deals"],
  ["Chi tiết deal", "deals"],
  ["Đã lưu & nhắc mua", "saved"],
  ["Sàn hoàn tiền", "shops"],
]);

function hint(title: string, body: string): Card {
  return { icon: "ℹ️", title, blocks: [{ text: body }], tone: "info" };
}

// ── Help ───────────────────────────────────────────────────────────────────

export function helpCard(): Card {
  return {
    icon: "🤖",
    title: "Caffi Auto Check-in Bot",
    subtitle: "Điểm danh tự động 00:00 hằng ngày · giờ Việt Nam",
    tone: "info",
    blocks: [
      {
        heading: "📊 Thông tin",
        text: [
          "/status — tổng quan hôm nay",
          "/wallet — Xèng, tiền chờ, hoa hồng",
          "/orders [mã] — đơn hàng & hoa hồng",
          "/balance — dòng tiền, lịch sử rút",
          "/info — hồ sơ, hạng, tiến độ",
          "/rewards — điểm thưởng & danh mục quà",
          "/history — lịch sử điểm danh",
          "/rank — bảng xếp hạng hoa hồng",
        ].join("\n"),
      },
      {
        heading: "📰 Cộng đồng",
        text: [
          "/notify — thông báo của bạn",
          "/news — thông báo hệ thống",
          "/deals [id] — deals nổi bật",
          "/saved — đã lưu & nhắc mua",
          "/shops — sàn hoàn tiền hỗ trợ",
          "/invite — bạn đã mời & hoa hồng chia sẻ",
          "/security — bảo mật & tài khoản nhận tiền",
          "/top — 10 người điểm danh sớm nhất",
        ].join("\n"),
      },
      {
        heading: "🔐 Tài khoản",
        text: [
          "/login <tên đăng nhập> <mật khẩu> — đăng nhập app",
          "/otp 123456 — nhập mã OTP (hoặc gửi thẳng 6 số)",
          "/resend — gửi lại mã OTP · /cancel — huỷ phiên",
          "/accounts · /all — danh sách và tổng hợp mọi tài khoản",
          "/use <tên> · /auto on|off [tên] · /logout [tên]",
          "Mọi lệnh đọc nhận thêm <tên tài khoản>, ví dụ /status ten@dang.nhap",
          "Bỏ trống thì dùng tài khoản đang chọn (▶ trong /accounts)",
        ].join("\n"),
      },
      {
        heading: "⏰ Hành động",
        text: "/checkin — điểm danh mọi tài khoản ngay (không cần chờ 00:00)",
      },
    ],
    footer: "🔒 Phiên bị server đá → bot nhắn báo bạn đăng nhập lại.",
  };
}

// ── Login ──────────────────────────────────────────────────────────────────

/** Per-chat cooldown so a flood of /login cannot burn the server's 20/900s budget. */
const loginAt = new Map<string, number>();
const LOGIN_COOLDOWN_MS = 20_000;

async function doLogin(ctx: Ctx, args: string[]) {
  const username = args[0];
  const password = args.slice(1).join(" ");
  if (!username || !password) {
    return reply(ctx, {
      icon: "🔐",
      title: "Thiếu thông tin",
      tone: "warn",
      blocks: [{
        text: "/login email@congty.com matkhau\n\n" +
          "Mật khẩu chứa khoảng trắng thì cứ để nguyên, bot lấy phần còn lại.",
        mono: true,
      }],
    });
  }

  const key = String(ctx.chatId);
  const last = loginAt.get(key) ?? 0;
  if (Date.now() - last < LOGIN_COOLDOWN_MS) {
    const wait = Math.ceil((LOGIN_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return reply(ctx, {
      icon: "⏳",
      title: "Chờ một chút",
      subtitle: `Thử lại sau ${wait} giây.`,
      tone: "warn",
      blocks: [{ text: "Server chỉ cho phép 20 lần đăng nhập / 15 phút." }],
    });
  }
  loginAt.set(key, Date.now());

  const chat = store.chat(ctx.chatId);
  const existing = chat.accounts[username];
  // No stored account yet — build a temporary one; only auth endpoints are used, so no token needed.
  const api = apiFor(existing ?? placeholderAccount(username, password));

  await reply(ctx, { icon: "⏳", title: "Đang đăng nhập…", tone: "info", progress: true });

  let result: LoginResult;
  try {
    result = await api.passwordLogin(username, password);
  } catch (e) {
    return reply(ctx, loginErrorCard(e));
  }

  if (result.kind === "success") {
    saveSession(ctx, username, password, result.tokens, result.displayName);
    return reply(ctx, {
      icon: "✅",
      title: "Đăng nhập thành công",
      tone: "success",
      stats: [{ label: "Tài khoản", value: username }],
      blocks: [{ text: "Bot sẽ tự điểm danh lúc 00:00 hằng ngày (giờ VN)." }],
    });
  }

  const pending: PendingLogin = {
    username,
    password,
    challengeId: result.challengeId,
    sentTo: result.sentTo,
    retryAfterSeconds: result.retryAfterSeconds,
    expiresAt: Date.now() + 10 * 60_000,
  };
  chat.pending = pending;
  store.touch();

  return reply(ctx, {
    icon: "🔐",
    title: "Cần xác minh OTP",
    subtitle: pending.sentTo ? `Mã đã gửi tới ${pending.sentTo}` : "Mã OTP đã được gửi đi.",
    tone: "warn",
    blocks: [{
      text: "Nhập mã 6 số, hoặc gõ /otp 123456\n" +
        "Mã có hạn ~10 phút. Gõ /resend nếu chưa nhận được.",
    }],
  });
}

async function finishOtp(ctx: Ctx, otp: string) {
  const chat = store.chat(ctx.chatId);
  const pending = chat.pending;
  if (!pending) return reply(ctx, hint("Không có phiên OTP nào đang chờ", "Gõ /login trước."));

  if (!/^\d{6}$/.test(otp)) {
    return reply(ctx, { icon: "❌", title: "Mã OTP phải gồm đúng 6 chữ số.", tone: "error" });
  }
  if (Date.now() > pending.expiresAt) {
    delete chat.pending;
    store.touch();
    return reply(ctx, {
      icon: "⏳",
      title: "Phiên OTP đã hết hạn",
      subtitle: "Gõ /login để làm lại.",
      tone: "warn",
    });
  }

  const api = apiFor(placeholderAccount(pending.username, pending.password));
  try {
    const { tokens, displayName } = await api.verifyOtp(pending.challengeId, otp);
    delete chat.pending;
    saveSession(ctx, pending.username, pending.password, tokens, displayName);
    return reply(ctx, {
      icon: "✅",
      title: "Đăng nhập thành công",
      tone: "success",
      stats: [{ label: "Tài khoản", value: pending.username }],
      blocks: [{ text: "Bot sẽ tự điểm danh lúc 00:00 hằng ngày (giờ VN)." }],
    });
  } catch (e) {
    const err = e as CaffiError;
    if (err.code === "SESSION_EXPIRED" || err.status === 400) {
      // bad/expired challengeId -> restart the login flow
      delete chat.pending;
      store.touch();
      return reply(ctx, {
        icon: "❌",
        title: "Mã OTP không hợp lệ",
        subtitle: err.message,
        tone: "error",
        blocks: [{ text: "Gõ /login để thử lại." }],
      });
    }
    return reply(ctx, {
      icon: "❌",
      title: "Xác minh thất bại",
      subtitle: err.message,
      tone: "error",
    });
  }
}

async function doResend(ctx: Ctx) {
  const chat = store.chat(ctx.chatId);
  const pending = chat.pending;
  if (!pending) return reply(ctx, hint("Không có phiên OTP nào đang chờ", "Gõ /login trước."));
  const api = apiFor(placeholderAccount(pending.username, pending.password));
  try {
    await api.resendOtp(pending.challengeId, pending.username, pending.password);
    return reply(ctx, { icon: "📨", title: "Đã gửi lại mã OTP", tone: "success" });
  } catch (e) {
    return reply(ctx, {
      icon: "❌",
      title: "Gửi lại thất bại",
      subtitle: (e as Error).message,
      tone: "error",
    });
  }
}

function doCancel(ctx: Ctx): Promise<void> {
  const chat = store.chat(ctx.chatId);
  if (!chat.pending) {
    return reply(ctx, hint("Không có phiên đăng nhập nào đang chờ", ""));
  }
  delete chat.pending;
  store.touch();
  return reply(ctx, { icon: "🚫", title: "Đã huỷ phiên đăng nhập", tone: "info" });
}

function saveSession(
  ctx: Ctx,
  username: string,
  password: string,
  tokens: { accessToken: string; refreshToken: string },
  displayName?: string,
) {
  const chat = store.chat(ctx.chatId);
  const prev = chat.accounts[username];
  chat.accounts[username] = {
    username,
    password,
    tokens,
    displayName: displayName ?? prev?.displayName,
    autoCheckIn: prev?.autoCheckIn ?? true,
    sessionInvalid: false,
    invalidReason: undefined,
    lastCheckInDay: prev?.lastCheckInDay,
    lastCheckInResult: prev?.lastCheckInResult,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  chat.activeAccount = username;
  delete chat.pending;
  store.touch();
}

function loginErrorCard(e: unknown): Card {
  const err = e as CaffiError;
  const code = err.code ? ` (${err.code})` : "";
  if (err.code === "PASSWORD_INVALID") {
    return {
      icon: "❌",
      title: "Tên đăng nhập hoặc mật khẩu không chính xác",
      subtitle: err.code + code,
      tone: "error",
    };
  }
  if (err.code === "RATE_LIMITED" || /rate|too many/i.test(err.message)) {
    return {
      icon: "⏳",
      title: "Bị giới hạn đăng nhập",
      subtitle: "Server cho phép 20 lần / 15 phút.",
      tone: "warn",
      blocks: [{ text: "Thử lại sau ít phút." }],
    };
  }
  return { icon: "❌", title: "Đăng nhập thất bại", subtitle: err.message + code, tone: "error" };
}

function placeholderAccount(username: string, password: string): Account {
  return {
    username,
    password,
    tokens: { accessToken: "", refreshToken: "" },
    autoCheckIn: true,
    sessionInvalid: false,
    createdAt: new Date().toISOString(),
  };
}

// ── Screens ────────────────────────────────────────────────────────────────

async function doStatus(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [status, wallet, cfg] = await Promise.all([
      api.getCheckInStatus(),
      api.getWallet(),
      api.getXengConfig().catch(() => null),
    ]);
    return reply(ctx, statusCard(account, status, wallet, cfg), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

/** Pure so it can be rendered in tests without touching the network. */
export function statusCard(
  account: Account,
  status: CheckInStatus,
  wallet: Wallet,
  cfg: XengConfig | null,
): Card {
  const balance = wallet.wallet?.balance;
  return {
    icon: "📊",
    title: "Tổng quan hôm nay",
    subtitle: account.displayName
      ? `${account.displayName} · ${account.username}`
      : account.username,
    tone: status.todayCheckedIn ? "success" : "warn",
    stats: [
      { label: "Điểm danh hôm nay", value: status.todayCheckedIn ? "✅ Rồi" : "❌ Chưa" },
      { label: "Chuỗi", value: `${num(status.currentStreak)} ngày` },
      { label: "Hạng hôm nay", value: `${num(status.todayCheckInPosition)}` },
      { label: "Xèng", value: `${num(balance)}${xengVnd(balance, cfg)}` },
      { label: "Tự động 00:00", value: account.autoCheckIn ? "Bật" : "Tắt" },
    ],
    blocks: [weekBlock(status)].filter((b): b is NonNullable<typeof b> => !!b),
    footer: `Lần bot điểm danh: ${account.lastCheckInDay ?? "chưa có"}`,
  };
}

/** The next seven days, straight from `weeklyPreview`. */
function weekBlock(status: CheckInStatus): { heading: string; text: string; mono: boolean } | null {
  const p = status.weeklyPreview ?? [];
  if (!p.length) return null;
  const start = Date.parse(`${vnDate()}T00:00:00+07:00`);
  const rows: string[][] = [["Ngày", "Thưởng"]];
  p.forEach((reward, i) => {
    rows.push([shortDate(new Date(start + i * 86_400_000).toISOString()), `${num(reward)} Xèng`]);
  });
  return { heading: "7 ngày tới", text: grid(rows), mono: true };
}

async function doWallet(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [wallet, cfg, hist, stats] = await Promise.all([
      api.getWallet(),
      api.getXengConfig(),
      api.getRedeemHistory(),
      api.getUserStats().catch(() => null),
    ]);
    return reply(ctx, walletCard(wallet, cfg, hist.items ?? [], stats), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function walletCard(
  wallet: Wallet,
  cfg: XengConfig | null,
  redemptions: RedeemRecord[],
  stats: UserStats | null,
): Card {
  const balance = wallet.wallet?.balance;
  const rate = cfg?.cashExchangeRate;
  const per = rate?.xeng && rate?.vnd ? rate.vnd / rate.xeng : undefined;
  const fin = stats?.financialSummary;

  const blocks: NonNullable<Card["blocks"]> = [];

  const recent = redemptions.slice(0, 5);
  if (recent.length) {
    blocks.push({
      heading: "Đổi thưởng (chỉ xem)",
      mono: true,
      text: grid([
        ["Xèng", "Tiền", "Trạng thái", "Lúc"],
        ...recent.map((r) => [
          `${num(r.xengAmount)}`,
          vnd(r.cashValue),
          statusLabel(r.status),
          vnClock(r.createdAt),
        ]),
      ]),
    });
  }

  if (fin) {
    blocks.push({
      heading: "Hoa hồng (₫)",
      mono: true,
      text: grid([
        ["Khả dụng", vnd(fin.availableBalance)],
        ["Chờ duyệt", vnd(fin.pendingCommission)],
        ["Tổng ước tính", vnd(fin.estimatedCommission)],
        ["Đã rút", vnd(fin.totalWithdrawn)],
      ]),
    });
  }

  return {
    icon: "💳",
    title: "Ví & tiền",
    tone: "success",
    stats: [
      {
        label: "Xèng khả dụng",
        value: `${num(balance)}${
          per !== undefined && balance !== undefined ? ` · ≈ ${vnd(balance * per)}` : ""
        }`,
      },
      { label: "Tổng đã kiếm", value: `${num(wallet.wallet?.totalEarned)} Xèng` },
      { label: "Tổng đã đổi", value: `${num(wallet.wallet?.totalRedeemed)} Xèng` },
      {
        label: "Tỉ giá",
        value: rate?.xeng && rate?.vnd ? `${num(rate.xeng)} Xèng = ${vnd(rate.vnd)}` : "—",
      },
      { label: "Có thể đổi", value: wallet.canRedeemAll ? "Được phép" : "Chưa đủ điều kiện" },
    ],
    blocks,
    footer: "Bot chỉ đọc — không bao giờ tự đổi thưởng.",
  };
}

function statusLabel(status?: string): string {
  switch (status) {
    case "PENDING":
      return "CHỜ DUYỆT";
    case "APPROVED":
      return "ĐÃ DUYỆT";
    case "REJECTED":
      return "TỪ CHỐI";
    default:
      return status ?? "—";
  }
}

async function doInfo(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [info, stats, wallet] = await Promise.all([
      api.getUserInfo(),
      api.getUserStats().catch(() => null),
      api.getWallet().catch(() => null),
    ]);
    return reply(ctx, infoCard(account, info, stats, wallet), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

interface SystemStatus {
  commissionRates?: Record<string, { normal?: number; special?: number }>;
  specialDays?: string;
  nextRank?: { label?: string; minValidOrders?: number } | null;
  isHighestRank?: boolean;
}

interface Profile {
  name?: string;
  email?: string;
  phone?: string;
  isPhoneVerified?: boolean;
  rank?: string;
  inviteCode?: string;
  createdAt?: string;
  lastLoginAt?: string;
  systemStatus?: SystemStatus;
}

export function infoCard(
  account: Account,
  info: unknown,
  stats: UserStats | null,
  wallet: Wallet | null,
): Card {
  const p = (info ?? {}) as Profile;
  const name = p.name ?? account.displayName ?? account.username;
  const orders = stats?.orderStats;
  const sys = p.systemStatus;
  const next = sys?.nextRank;
  const rate = sys?.commissionRates?.[p.rank ?? "DONG"];
  const valid = orders?.totalSuccessfulOrders ?? 0;
  const need = next?.minValidOrders ?? 0;

  const blocks: NonNullable<Card["blocks"]> = [];

  if (next?.label) {
    blocks.push({
      heading: `Tiến độ lên ${next.label}`,
      mono: true,
      text: [
        `Cần ${num(need)} đơn hợp lệ · hiện ${num(valid)} đơn thành công`,
        need > 0 ? bar(valid, need, 16) : "",
        `${num(valid)}/${num(need)}`,
      ].filter(Boolean).join("\n"),
    });
  }

  if (rate) {
    blocks.push({
      heading: "Hoa hồng",
      text:
        `${rankLabel(p.rank)}: ${num(rate.normal)}% thường · ${num(rate.special)}% ngày đặc biệt` +
        (sys?.specialDays ? ` (ngày ${sys.specialDays.split(",").join(", ")})` : ""),
    });
  }

  if (orders) {
    blocks.push({
      heading: "Đơn hàng",
      mono: true,
      text: grid([
        ["Tổng", `${num(orders.totalOrders)}`],
        ["Thành công", `${num(orders.totalSuccessfulOrders)}`],
        ["Chờ xử lý", `${num(orders.totalPendingOrders)}`],
        ["Từ chối", `${num(orders.totalRejectedOrders)}`],
        ["Tỷ lệ thành công", `${num(orders.orderSuccessRate)}%`],
        ["Hoa hồng", vnd(orders.totalOrderCommission)],
      ]),
    });
  }

  blocks.push({
    heading: "Khác",
    text: [
      `Rút tiền: ${num(stats?.withdrawalStats?.totalWithdrawals)} giao dịch · ${
        vnd(stats?.withdrawalStats?.totalWithdrawnAmount)
      }`,
      `Mời được: ${num(stats?.invitationStats?.totalInvitedUsers)} người`,
      `Xèng trong ví: ${num(wallet?.wallet?.balance)}`,
    ].join("\n"),
  });

  return {
    icon: "👤",
    title: "Hồ sơ",
    subtitle: name,
    tone: "info",
    stats: [
      { label: "Tài khoản", value: account.username },
      { label: "Email", value: p.email ?? "—" },
      {
        label: "Số điện thoại",
        value: p.phone ? `${p.phone}${p.isPhoneVerified ? " ✅" : " (chưa xác minh)"}` : "—",
      },
      { label: "Xếp hạng", value: rankLabel(p.rank) },
      { label: "Mã mời", value: p.inviteCode ?? "—" },
    ],
    blocks,
    footer: [
      p.createdAt ? `Thành viên từ ${shortDate(p.createdAt)}` : "",
      p.lastLoginAt ? `Đăng nhập gần nhất ${vnClock(p.lastLoginAt)}` : "",
    ].filter(Boolean).join(" · "),
  };
}

const RANKS: Record<string, string> = { DONG: "Đồng", VANG: "Vàng", KIM_CUONG: "Kim Cương" };
const rankLabel = (rank?: string) => (rank ? RANKS[rank] ?? rank : "—");

/** Append the đồng equivalent of a Xèng amount when the official rate is known. */
function xengVnd(xeng: number | undefined, cfg: XengConfig | null): string {
  const rate = cfg?.cashExchangeRate;
  if (xeng === undefined || !rate?.xeng || !rate?.vnd) return "";
  return ` · ≈ ${vnd((xeng * rate.vnd) / rate.xeng)}`;
}

async function doRewards(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [status, cfg] = await Promise.all([
      api.getCheckInStatus(),
      api.getXengConfig(),
    ]);
    return reply(ctx, rewardsCard(status, cfg), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function rewardsCard(status: CheckInStatus, cfg: XengConfig | null): Card {
  const rewards = cfg?.checkInRewards ?? status.rewardsConfig;
  const items = (cfg?.items ?? []).filter((i) => i.isActive !== false);

  const blocks: NonNullable<Card["blocks"]> = [];
  const week = weekBlock(status);
  if (week) blocks.push(week);

  if (items.length) {
    blocks.push({
      heading: "Danh mục quà",
      mono: true,
      text: grid([
        ["Quà", "Giá", "Hạng", "Còn"],
        ...items.map((i) => [
          (i.name ?? "—").trim(),
          `${num(i.costXeng)} Xèng`,
          rankLabel(i.minRank),
          i.quantity && i.quantity > 0 ? String(i.quantity) : "hết",
        ]),
      ]),
    });
  }

  return {
    icon: "🏆",
    title: "Điểm thưởng",
    subtitle: "Xèng kiếm được từ điểm danh hằng ngày",
    tone: "gold",
    stats: [
      { label: "Thưởng thường", value: `${num(rewards?.normal)} Xèng` },
      { label: "Thưởng bonus", value: `${num(rewards?.bonus)} Xèng` },
      { label: "Chuỗi hiện tại", value: `${num(status.currentStreak)} ngày` },
      {
        label: "Thưởng kế tiếp",
        value: `${num(status.nextReward)} Xèng (ngày ${num(status.nextCheckInDay)})`,
      },
      {
        label: "Tỉ giá",
        value: cfg?.cashExchangeRate?.xeng && cfg?.cashExchangeRate?.vnd
          ? `${num(cfg.cashExchangeRate.xeng)} Xèng = ${vnd(cfg.cashExchangeRate.vnd)}`
          : "—",
      },
    ],
    blocks,
    footer: "Bot không tự đổi quà — mình chỉ hiển thị thông tin.",
  };
}

async function doHistory(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  try {
    return reply(ctx, historyCard(await apiFor(account).getCheckInStatus()), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function historyCard(status: CheckInStatus): Card {
  const rows = (status.history ?? []).slice(0, 10);
  return {
    icon: "📅",
    title: "Lịch sử điểm danh",
    subtitle: `${num(status.currentStreak)} ngày liên tiếp · mới nhất trước`,
    tone: "info",
    blocks: rows.length
      ? [{
        mono: true,
        text: grid([
          ["Ngày", "Chuỗi", "Thưởng"],
          ...rows.map((h) => [
            shortDate(h.checkInDate),
            `#${num(h.streakDay)}`,
            `${num(h.rewardValue)} Xèng`,
          ]),
        ]),
      }]
      : [{ text: "Chưa có lịch sử điểm danh." }],
    footer: `Hạng hôm nay: ${num(status.todayCheckInPosition)}`,
  };
}

async function doTop(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  try {
    return reply(ctx, topCard(await apiFor(account).getCheckInEarliest()), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function topCard(entries: EarlyEntry[]): Card {
  const rows = entries.slice(0, 10);
  return {
    icon: "🥇",
    title: "Top điểm danh sớm",
    subtitle: "Ai vào sớm nhất trong ngày — server ghi nhận tới mili giây",
    tone: "gold",
    blocks: rows.length
      ? [{
        mono: true,
        text: grid([
          ["#", "Tên", "Chuỗi", "Giờ"],
          ...rows.map((e, i) => [
            String(i + 1),
            (e.name ?? "—").slice(0, 18),
            `${num(e.streak)}`,
            vnClockMs(e.time),
          ]),
        ]),
      }]
      : [{ text: "Chưa ai điểm danh hôm nay — bạn có thể là người đầu tiên." }],
    footer: "Ngày mới mở đúng 00:00:00.000 giờ Việt Nam.",
  };
}

// ── Read-only screens ──────────────────────────────────────────────────────
// Everything below talks to GET endpoints only. No redemption, no withdrawal,
// no profile edit, no mark-as-read: the bot observes, it never acts.

/** Collapse the CMS's HTML into one readable line. */
function stripHtml(html: string | undefined, max = 200): string {
  if (!html) return "";
  const text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Shorten any value so it fits a table cell. */
function trunc(value: unknown, max: number): string {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const ORDER_STATUS: Record<string, string> = {
  pending: "CHỜ DUYỆT",
  approved: "ĐÃ DUYỆT",
  completed: "HOÀN TẤT",
  processed: "ĐÃ DUYỆT",
  rejected: "TỪ CHỐI",
  cancelled: "ĐÃ HUỶ",
  canceled: "ĐÃ HUỶ",
};

function orderStatus(status?: string): string {
  if (!status) return "—";
  return ORDER_STATUS[status.toLowerCase()] ?? status.toUpperCase();
}

/** Best-effort label for rows whose exact schema the bot has not seen yet. */
function rowLabel(row: Record<string, unknown>): string {
  for (const key of ["title", "name", "productName", "productInfo", "label", "subject"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return row.id !== undefined ? `#${row.id}` : "(không rõ)";
}

function pageLine(p?: Page): string {
  if (!p || p.totalItems === undefined) return "";
  return `Tổng ${num(p.totalItems)} mục · trang ${num(p.currentPage)}/${num(p.totalPages)}`;
}

// ── /orders ────────────────────────────────────────────────────────────────

async function doOrders(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  const { args } = targetArgs(ctx);
  try {
    const code = args[0];
    if (code) {
      const detail = await api.getOrderDetail(code);
      return reply(ctx, orderDetailCard(detail), SCREEN);
    }
    const [list, stats] = await Promise.all([
      api.getOrders(1, 10),
      api.getUserStats().catch(() => null),
    ]);
    return reply(ctx, ordersCard(list.orders ?? [], list.pagination, stats), SCREEN);
  } catch (e) {
    if (args[0] && (e as CaffiError).status === 404) {
      return reply(ctx, {
        icon: "🤔",
        title: "Không tìm thấy đơn hàng",
        subtitle: (e as CaffiError).message,
        tone: "warn",
        blocks: [{ text: "Mã đơn không tồn tại, hoặc không thuộc tài khoản này." }],
        footer: "Gõ /orders để xem lại danh sách.",
      }, SCREEN);
    }
    return handleProtectedError(ctx, account, e);
  }
}

export function ordersCard(
  orders: OrderRow[],
  page: Page | undefined,
  stats: UserStats | null,
): Card {
  const o = stats?.orderStats;
  const blocks: NonNullable<Card["blocks"]> = orders.length
    ? [{
      heading: "10 đơn gần nhất",
      mono: true,
      text: grid([
        ["Mã đơn", "Ngày", "Hoa hồng", "Trạng thái", "Sản phẩm"],
        ...orders.map((r) => [
          r.orderId ?? "—",
          shortDate(r.createdAt),
          vnd(r.bupMangCommission),
          orderStatus(r.status),
          trunc(r.productInfo, 22),
        ]),
      ]),
    }]
    : [{ text: "Chưa có đơn hàng nào được ghi nhận." }];

  return {
    icon: "🧾",
    title: "Đơn hàng",
    tone: "info",
    stats: [
      { label: "Tổng đơn", value: num(o?.totalOrders) },
      { label: "Thành công", value: num(o?.totalSuccessfulOrders) },
      { label: "Chờ xử lý", value: num(o?.totalPendingOrders) },
      { label: "Từ chối", value: num(o?.totalRejectedOrders) },
      { label: "Hoa hồng", value: vnd(o?.totalOrderCommission) },
    ],
    blocks,
    footer: [pageLine(page), "Chỉ đọc — gõ /orders <mã đơn> để xem chi tiết."]
      .filter(Boolean)
      .join(" · "),
  };
}

export function orderDetailCard(d: OrderDetail): Card {
  const items = d.items ?? [];
  const blocks: NonNullable<Card["blocks"]> = [{
    heading: "Đơn hàng",
    mono: true,
    text: grid([
      ["Mã đơn", d.orderId ?? "—"],
      ["Sản phẩm", trunc(d.productInfo, 58)],
      // `grand_total` is the app's own gross-commission field (its normaliser
      // falls back from it to `estimatedTotalCommission`/`grossCommission`),
      // not the shelf price — the shelf price only lives in `items[]`.
      ["Hoa hồng gộp", vnd(d.grand_total)],
      ["Bạn nhận", vnd(d.bupMangCommission)],
      ["Tỷ lệ chia", `${num(d.share_percentage)}%`],
      ["Trạng thái", orderStatus(d.status)],
      ["Mua lúc", vnClock(d.purchaseTimeAt ?? d.createdAt)],
    ]),
  }];

  if (items.length) {
    blocks.push({
      heading: `Sản phẩm (${items.length})`,
      mono: true,
      text: grid([
        ["SL", "Gian hàng", "Tên"],
        ...items.map((i) => [String(i.qty ?? 1), trunc(i.shopName, 14), trunc(i.itemName, 34)]),
      ]),
    });
  }
  if (d.cancelReason) blocks.push({ heading: "Lý do huỷ", text: d.cancelReason });

  return {
    icon: "🧾",
    title: "Chi tiết đơn hàng",
    subtitle: d.orderId,
    tone: "info",
    blocks,
    footer: `Trạng thái đơn: ${d.orderStatus ?? "—"} · bot chỉ đọc.`,
  };
}

// ── /balance ───────────────────────────────────────────────────────────────

async function doBalance(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [timeline, withdrawals] = await Promise.all([
      api.getBalanceTimeline(1, 10),
      api.getWithdrawals(1, 5).catch(() => ({ withdrawals: [] })),
    ]);
    return reply(ctx, balanceCard(timeline, withdrawals), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function balanceCard(t: BalanceTimeline, w: WithdrawalList): Card {
  const s = t.summary;
  const blocks: NonNullable<Card["blocks"]> = [];

  const rows = (t.timeline ?? []).slice(0, 8);
  if (rows.length) {
    blocks.push({
      heading: "Biến động gần đây",
      mono: true,
      text: grid([
        ["Ngày", " ", "Số tiền", "Nội dung"],
        ...rows.map((e) => [
          shortDate(e.timelineAt),
          e.direction === "out" ? "−" : "+",
          vnd(Math.abs(e.amount ?? 0)),
          trunc(e.title, 26),
        ]),
      ]),
    });
  } else {
    blocks.push({ text: "Chưa có biến động số dư nào." });
  }

  const list = w.withdrawals ?? [];
  blocks.push(
    list.length
      ? {
        heading: "Lịch sử rút tiền",
        mono: true,
        text: grid([
          ["Ngày", "Số tiền", "Trạng thái"],
          ...list.map((r) => [shortDate(r.createdAt), vnd(r.amount), statusLabel(r.status)]),
        ]),
      }
      : { heading: "Lịch sử rút tiền", text: "Chưa rút tiền lần nào." },
  );

  return {
    icon: "💰",
    title: "Dòng tiền",
    tone: "success",
    stats: [
      { label: "Tổng thu", value: vnd(s?.totalIncome) },
      { label: "Tổng chi", value: vnd(s?.totalExpense) },
      { label: "Biến động ròng", value: vnd(s?.netChange) },
      { label: "Đã duyệt đơn", value: num(s?.counts?.processedOrders) },
      { label: "Lần đổi điểm", value: num(s?.counts?.pointExchanges) },
    ],
    blocks,
    footer: "Chỉ đọc — bot không bao giờ tự rút tiền.",
  };
}

// ── /rank ──────────────────────────────────────────────────────────────────

async function doRank(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [rank, avg] = await Promise.all([
      api.getUserRank(),
      api.getCashbackAverages(30).catch(() => null),
    ]);
    return reply(ctx, rankCard(rank, avg), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function rankCard(rank: UserRank, avg: CashbackAverage | null): Card {
  const monthly = rank.rankings?.monthly;
  const invited = rank.rankings?.invited;
  const top = (rank.topLists?.monthly ?? []).slice(0, 10);
  const blocks: NonNullable<Card["blocks"]> = [];

  if (top.length) {
    blocks.push({
      heading: `Top hoa hồng · ${rank.currentMonth ?? "tháng này"}`,
      mono: true,
      text: grid([
        ["#", "Tên", "Đơn", "Hoa hồng"],
        ...top.map((e, i) => [
          String(i + 1),
          trunc(e.name, 18),
          num(e.orderCount),
          e.formattedCommission ?? vnd(e.commission),
        ]),
      ]),
    });
  } else {
    blocks.push({ text: "Chưa có bảng xếp hạng tháng này." });
  }

  const p = avg?.periods?.[0];
  if (p) {
    blocks.push({
      heading: `Trung bình cả nền tảng (${num(p.days)} ngày)`,
      text: [
        `Trung bình mỗi người: ${vnd(p.averageCashbackPerUser)}`,
        `Tổng hoa hồng: ${vnd(p.totalCashback)} · ${num(p.totalUsersWithOrders)} người có đơn`,
        `Tổng đơn: ${num(p.totalOrders)}`,
      ].join("\n"),
    });
  }

  return {
    icon: "🥇",
    title: "Xếp hạng",
    subtitle: rank.currentMonth,
    tone: "gold",
    stats: [
      {
        label: "Hạng tháng",
        value: monthly?.inTop ? `#${num(monthly.rank)}` : "Chưa vào top",
      },
      { label: "Tổng người", value: num(monthly?.totalUsers) },
      { label: "Mời được", value: `${num(invited?.inviteCount)} người` },
      { label: "Hạng mời", value: invited?.inTop ? `#${num(invited.rank)}` : "—" },
    ],
    blocks,
    footer: "Bảng xếp hạng do server tính — bot chỉ đọc.",
  };
}

// ── /notify ────────────────────────────────────────────────────────────────

async function doNotify(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [summary, list] = await Promise.all([
      api.getNotificationSummary(),
      api.getUserNotifications(1, 10),
    ]);
    return reply(ctx, notifyCard(summary, list), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function notifyCard(summary: NotificationSummary, list: NotificationList): Card {
  const rows = (list.notifications ?? []).slice(0, 8);
  const blocks: NonNullable<Card["blocks"]> = rows.length
    ? [{
      heading: "Mới nhất",
      mono: true,
      text: grid([
        ["Ngày", "Nội dung"],
        ...rows.map((n) => [shortDate(n.createdAt), trunc(n.content ?? n.title, 46)]),
      ]),
    }]
    : [{ text: "Chưa có thông báo nào." }];

  return {
    icon: "🔔",
    title: "Thông báo",
    tone: summary.totalUnreadCount ? "warn" : "info",
    stats: [
      { label: "Chưa đọc", value: num(summary.totalUnreadCount) },
      { label: "Chung", value: num(summary.announcementsUnreadCount) },
      { label: "Của bạn", value: num(summary.userNotificationsUnreadCount) },
      { label: "Tổng", value: num(list.pagination?.totalItems) },
    ],
    blocks,
    footer: "Bot chỉ đọc — không đánh dấu đã đọc giúp bạn.",
  };
}

// ── /news ──────────────────────────────────────────────────────────────────

async function doNews(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  try {
    const list = await apiFor(account).getAnnouncements(1, 5);
    return reply(ctx, newsCard(list), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function newsCard(list: AnnouncementList): Card {
  const rows = (list.announcements ?? []).slice(0, 4);
  const blocks: NonNullable<Card["blocks"]> = rows.length
    ? rows.map((a) => ({
      heading: `${shortDate(a.createdAt)} · ${trunc(a.subject, 54)}`,
      text: stripHtml(a.content, 220),
    }))
    : [{ text: "Chưa có thông báo hệ thống nào." }];

  return {
    icon: "📰",
    title: "Tin hệ thống",
    tone: "info",
    blocks,
    footer: `${num(list.pagination?.totalItems)} thông báo đang hiển thị · chỉ đọc.`,
  };
}

// ── /security ──────────────────────────────────────────────────────────────

async function doSecurity(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [sec, pay] = await Promise.all([
      api.getSecurityStatus(),
      api.getPaymentMethod(),
    ]);
    return reply(ctx, securityCard(account, sec, pay), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function securityCard(
  account: Account,
  sec: SecurityStatus,
  pay: PaymentMethod | null,
): Card {
  const blocks: NonNullable<Card["blocks"]> = [];

  blocks.push({
    heading: "Tài khoản nhận tiền",
    text: pay
      ? [
        `${pay.bankName ?? "—"} · ${pay.accountNumberMasked ?? "—"}`,
        `Chủ tài khoản: ${pay.accountName ?? "—"}`,
        pay.isDefault ? "Đang là tài khoản mặc định" : "Không phải tài khoản mặc định",
      ].join("\n")
      : "Chưa thêm tài khoản nhận tiền trong app.",
  });

  return {
    icon: "🛡",
    title: "Bảo mật & nhận tiền",
    subtitle: account.displayName
      ? `${account.displayName} · ${account.username}`
      : account.username,
    tone: sec.enableOtp ? "success" : "warn",
    stats: [
      { label: "Xác thực 2 bước", value: sec.enableOtp ? "✅ Đang bật" : "❌ Đang tắt" },
      { label: "Mật khẩu", value: sec.hasPassword ? "Đã đặt" : "Chưa đặt" },
      {
        label: "Đổi mật khẩu",
        value: sec.passwordUpdatedAt ? shortDate(sec.passwordUpdatedAt) : "—",
      },
      { label: "Ngân hàng", value: pay?.bankName ?? "Chưa thêm" },
    ],
    blocks,
    footer: "Chỉ đọc — bot không đổi mật khẩu, OTP hay tài khoản ngân hàng.",
  };
}

// ── /invite ────────────────────────────────────────────────────────────────

async function doInvite(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [invited, share] = await Promise.all([
      api.getInvitedUsers(1, 10),
      api.getShareOthers().catch(() => ({ shareothers: [] })),
    ]);
    return reply(ctx, inviteCard(invited, share), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function inviteCard(invited: InvitedList, share: ShareOther): Card {
  const users = invited.users ?? [];
  const blocks: NonNullable<Card["blocks"]> = users.length
    ? [{
      heading: "Bạn đã mời",
      mono: true,
      text: grid([
        ["Ngày", "Tên", "Email"],
        ...users.map((u) => [shortDate(u.createdAt), trunc(u.name, 18), trunc(u.email, 26)]),
      ]),
    }]
    : [{ text: "Bạn chưa mời được ai." }];

  return {
    icon: "🤝",
    title: "Mời bạn",
    tone: "info",
    stats: [
      { label: "Đã mời", value: `${num(invited.pagination?.totalItems)} người` },
      { label: "Hoa hồng chia sẻ", value: vnd(share.totalShareCommission) },
      { label: "Bài chia sẻ", value: num(share.shareothers?.length) },
    ],
    blocks,
    footer: "Chỉ đọc — bot không gửi lời mời giúp bạn.",
  };
}

// ── /deals ─────────────────────────────────────────────────────────────────

async function doDeals(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  const { args } = targetArgs(ctx);
  try {
    const id = Number(args[0]);
    if (args[0] && Number.isFinite(id) && id > 0) {
      const [detail, comments] = await Promise.all([
        api.getDealDetail(id),
        api.getDealComments(id, 1, 5).catch(() => ({ comments: [] })),
      ]);
      return reply(ctx, dealDetailCard(detail, comments), SCREEN);
    }
    const [list, community, mine] = await Promise.all([
      api.getDeals(1, 5),
      api.getCommunityStatus().catch(() => null),
      api.getMyDeals(1, 1).catch(() => null),
    ]);
    return reply(ctx, dealsCard(list, community, mine), SCREEN);
  } catch (e) {
    if (args[0] && Number.isFinite(Number(args[0])) && (e as CaffiError).status === 404) {
      return reply(ctx, {
        icon: "🤔",
        title: "Không tìm thấy deal",
        subtitle: (e as CaffiError).message,
        tone: "warn",
        blocks: [{ text: "ID deal không tồn tại." }],
        footer: "Gõ /deals để xem lại danh sách.",
      }, SCREEN);
    }
    return handleProtectedError(ctx, account, e);
  }
}

export function dealsCard(
  list: DealList,
  community: CommunityStatus | null,
  mine: DealList | null,
): Card {
  const deals = (list.deals ?? []).slice(0, 5);
  const blocks: NonNullable<Card["blocks"]> = deals.length
    ? [{
      heading: "Mới đăng",
      mono: true,
      text: grid([
        ["ID", "Ngày", "Tác giả", "Tiêu đề"],
        ...deals.map((d) => [
          String(d.id ?? "—"),
          shortDate(d.publishedAt ?? d.createdAt),
          trunc(d.userName, 12),
          trunc(d.title, 34),
        ]),
      ]),
    }]
    : [{ text: "Chưa có deal nào." }];

  if (community) {
    blocks.push({
      heading: "Quyền cộng đồng",
      text: [
        `Đã đồng ý điều khoản: ${community.communityDealsTosAgreed ? "có" : "chưa"}`,
        `Đăng bài: ${community.canPostDeals ? "được" : "không"} · Bình luận: ${
          community.canCommentDeals ? "được" : "không"
        }`,
        community.postLockedUntil ? `Khóa đăng tới ${vnClock(community.postLockedUntil)}` : "",
      ].filter(Boolean).join("\n"),
    });
  }

  return {
    icon: "🎁",
    title: "Deals nổi bật",
    tone: "gold",
    stats: [
      { label: "Tổng deal", value: num(list.pagination?.totalItems) },
      { label: "Bài của bạn", value: num(mine?.pagination?.totalItems) },
    ],
    blocks,
    footer: "Gõ /deals <id> để xem chi tiết một deal.",
  };
}

export function dealDetailCard(detail: DealDetail, comments: DealCommentList): Card {
  const d = detail.deal ?? {};
  const list = (comments.comments ?? []).slice(0, 4);
  const blocks: NonNullable<Card["blocks"]> = [
    {
      heading: trunc(d.title, 60),
      text: stripHtml(d.description, 300),
    },
  ];

  if (list.length) {
    blocks.push({
      heading: "Bình luận",
      mono: true,
      text: grid([
        ["Ngày", "Người", "Nội dung"],
        ...list.map((c) => [
          shortDate(c.createdAt),
          trunc(c.userName, 12),
          trunc(c.content, 40),
        ]),
      ]),
    });
  }

  return {
    icon: "🎁",
    title: "Chi tiết deal",
    subtitle: `ID ${d.id ?? "—"} · ${d.userRankLabel ?? d.userName ?? ""}`.trim(),
    tone: "gold",
    blocks,
    footer: `${num(comments.pagination?.totalItems)} bình luận · bot chỉ đọc.`,
  };
}

// ── /saved ─────────────────────────────────────────────────────────────────

async function doSaved(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  const api = apiFor(account);
  try {
    const [bookmarks, count, reminders] = await Promise.all([
      api.getBookmarks(1, 10),
      api.getBookmarkCount().catch(() => ({ count: undefined })),
      api.getPurchaseReminders(1, 5).catch(() => ({ reminders: [] })),
    ]);
    return reply(ctx, savedCard(bookmarks, count.count, reminders), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function savedCard(
  bookmarks: BookmarkList,
  count: number | undefined,
  reminders: ReminderList,
): Card {
  const saved = bookmarks.bookmarks ?? [];
  const upcoming = reminders.reminders ?? [];
  const blocks: NonNullable<Card["blocks"]> = [];

  blocks.push(
    saved.length
      ? {
        heading: "Đã lưu",
        mono: true,
        text: grid([
          ["#", "Mục"],
          ...saved.slice(0, 8).map((b, i) => [String(i + 1), trunc(rowLabel(b), 50)]),
        ]),
      }
      : { heading: "Đã lưu", text: "Chưa lưu sản phẩm nào." },
  );

  blocks.push(
    upcoming.length
      ? {
        heading: "Nhắc mua",
        mono: true,
        text: grid([
          ["#", "Mục"],
          ...upcoming.slice(0, 5).map((r, i) => [String(i + 1), trunc(rowLabel(r), 50)]),
        ]),
      }
      : { heading: "Nhắc mua", text: "Chưa có lời nhắc mua nào." },
  );

  return {
    icon: "🔖",
    title: "Đã lưu & nhắc mua",
    tone: "info",
    stats: [
      { label: "Sản phẩm đã lưu", value: num(count ?? bookmarks.pagination?.totalItems) },
      { label: "Lời nhắc", value: num(reminders.pagination?.totalItems) },
    ],
    blocks,
    footer: "Chỉ đọc — bot không lưu hay huỷ nhắc mua giúp bạn.",
  };
}

// ── /shops ─────────────────────────────────────────────────────────────────

async function doShops(ctx: Ctx) {
  const account = await requireAccount(ctx);
  if (!account) return;
  try {
    const providers = await apiFor(account).getProviders();
    return reply(ctx, shopsCard(providers), SCREEN);
  } catch (e) {
    return handleProtectedError(ctx, account, e);
  }
}

export function shopsCard(providers: Provider[]): Card {
  const list = [...providers]
    .filter((p) => p.name || p.code)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .slice(0, 20);

  return {
    icon: "🏪",
    title: "Sàn hoàn tiền",
    subtitle: "Các sàn mà Caffi nhận đơn hàng",
    tone: "info",
    blocks: list.length
      ? [{
        mono: true,
        text: grid([
          ["Mã", "Tên sàn", "Ghi chú"],
          ...list.map((p) => [p.code ?? "—", trunc(p.name, 16), trunc(p.description, 24)]),
        ]),
      }]
      : [{ text: "Không lấy được danh sách sàn." }],
    footer: `Tổng ${providers.length} sàn · chỉ đọc.`,
  };
}

async function doManualCheckIn(ctx: Ctx) {
  const chat = store.chat(ctx.chatId);
  const { name } = targetArgs(ctx);

  // No login named and the chat holds more than one: check in **all** of them.
  // Naming one (`/checkin ten@x.com`) still targets just that login.
  if (!name && Object.keys(chat.accounts).length > 1) {
    return checkInAll(ctx, chat);
  }

  const account = await requireAccount(ctx);
  if (!account) return;
  await reply(ctx, { icon: "⏳", title: "Đang điểm danh…", tone: "info", progress: true });
  const r = await runCheckIn(account);
  if (r.outcome === "session_expired") {
    return notifyRelogin(ctx, account, r.card);
  }
  // Keep the login visible: one chat may hold several Caffi accounts, and the
  // card itself never names one (the nightly run does the same).
  const many = Object.keys(chat.accounts).length > 1;
  return reply(ctx, {
    ...r.card,
    subtitle: many ? account.username : r.card.subtitle,
  }, SCREEN);
}

/** A stat value by the start of its label — the two cards spell "Chuỗi" differently. */
function statOf(card: Card, prefix: string): string {
  return card.stats?.find((s) => s.label.startsWith(prefix))?.value ?? "—";
}

/**
 * `/checkin` with no account name: one run per login in the chat, all at once.
 *
 * The midnight run already does this, and a chat holding several logins should
 * not have to type the same command once per account. Sessions the server
 * dropped are skipped rather than attempted — asking would only fail.
 */
async function checkInAll(ctx: Ctx, chat: ChatState): Promise<void> {
  const all = Object.values(chat.accounts);
  const list = all.filter((a) => !a.sessionInvalid);
  if (!list.length) {
    return reply(ctx, {
      icon: "🔒",
      title: "Không có tài khoản nào điểm danh được",
      subtitle: `${all.length} phiên đã bị đăng xuất.`,
      tone: "error",
      blocks: [{ text: "Gõ /login để đăng nhập lại từng tài khoản." }],
    });
  }

  await reply(ctx, {
    icon: "⏳",
    title: `Đang điểm danh ${num(list.length)} tài khoản…`,
    tone: "info",
    progress: true,
  });

  const results = await Promise.all(
    list.map(async (a) => ({ account: a, result: await runCheckIn(a) })),
  );

  const ICON: Record<string, string> = {
    checked_in: "✅",
    already_done: "✅",
    pending_day: "⏳",
    session_expired: "🔒",
    failed: "⚠️",
  };

  const table = grid([
    ["", "Tài khoản", "Chuỗi", "Hạng", "Giờ"],
    ...results.map(({ account, result }) => [
      ICON[result.outcome] ?? "•",
      trunc(account.username, 26),
      statOf(result.card, "Chuỗi"),
      statOf(result.card, "Hạng"),
      statOf(result.card, "Điểm danh lúc"),
    ]),
  ]);

  const done =
    results.filter(({ result }) =>
      result.outcome === "checked_in" || result.outcome === "already_done"
    ).length;
  const broken = results.filter(({ result }) =>
    result.outcome === "failed" || result.outcome === "session_expired" ||
    result.outcome === "pending_day"
  );
  const skipped = all.length - list.length;

  const blocks: NonNullable<Card["blocks"]> = [{ mono: true, text: table }];
  if (broken.length) {
    blocks.push({
      heading: "Chưa xong",
      text: broken.map(({ account, result }) =>
        `${trunc(account.username, 30)} — ${
          trunc(
            statOf(result.card, "Điểm danh lúc") && result.outcome === "pending_day"
              ? "Server chưa mở ngày mới"
              : result.card.subtitle ?? result.outcome,
            60,
          )
        }`
      ).join("\n"),
    });
  }

  return reply(ctx, {
    icon: done === list.length ? "🎉" : "⚠️",
    title: `Điểm danh ${num(done)}/${num(list.length)} tài khoản`,
    tone: done === list.length ? "success" : "warn",
    stats: [
      { label: "Đã điểm danh", value: num(done) },
      { label: "Còn lại", value: num(list.length - done) },
      ...(skipped ? [{ label: "Hết phiên", value: num(skipped) }] : []),
    ],
    blocks,
    footer: "Gõ /checkin <tên> để chỉ chạy một tài khoản.",
  }, SCREEN);
}

async function notifyRelogin(ctx: Ctx, account: Account, card: Card) {
  await reply(ctx, {
    ...card,
    footer:
      `Tài khoản ${account.username} · Bot sẽ KHÔNG tự điểm danh cho tới khi bạn đăng nhập lại.`,
  });
}

function handleProtectedError(ctx: Ctx, account: Account, e: unknown): Promise<void> {
  const err = e as CaffiError;
  if (err.code && ["TOKEN_INVALID", "TOKEN_EXPIRED", "NOT_AUTHENTICATED"].includes(err.code)) {
    account.sessionInvalid = true;
    account.invalidReason = err.message;
    store.touch();
    return reply(ctx, {
      icon: "🔒",
      title: "Phiên đã bị đăng xuất",
      subtitle: err.message,
      tone: "error",
      blocks: [{ text: `Tài khoản: ${account.username}` }, { text: "Gõ /login để đăng nhập lại." }],
      footer: "Bot sẽ KHÔNG tự điểm danh cho tới khi bạn đăng nhập lại.",
    });
  }
  return reply(ctx, { icon: "❌", title: "Có lỗi xảy ra", subtitle: err.message, tone: "error" });
}

// ── Account management ─────────────────────────────────────────────────────

/** The active account, or a card explaining what to do next. */
/**
 * One chat may hold several Caffi logins, so a command can name the one it
 * should act on: `/status ten@dang.nhap`. The first argument is taken as that
 * name when it matches a stored login or merely looks like an email — which
 * keeps `/orders 261004Q1NBB3DT`, `/deals 128` and `/auto on` untouched.
 * Button presses carry no text at all (`ctx.raw === ""`), so they always fall
 * through to the active account.
 */
interface TargetArgs {
  /** The login named as the first argument, when it exists in this chat. */
  name?: string;
  /** Arguments left after the command word and that optional name. */
  args: string[];
}

function targetArgs(ctx: Ctx): TargetArgs {
  const rest = ctx.raw.trim().split(/\s+/).slice(1);
  const head = rest[0];
  if (!head) return { args: rest };
  if (store.chat(ctx.chatId).accounts[head]) return { name: head, args: rest.slice(1) };
  // An email-shaped word can only be a login — never an order code or a deal id
  // — so a typo still reports "no such account" instead of silently falling
  // back to the active one.
  if (head.includes("@")) return { name: head, args: rest.slice(1) };
  return { args: rest };
}

/** The card shown when the requested login is not in this chat. */
function noAccountReply(ctx: Ctx, name?: string): Promise<void> {
  if (name) {
    return reply(ctx, {
      icon: "❌",
      title: "Không có tài khoản này",
      subtitle: name,
      tone: "error",
      blocks: [{ text: "Gõ /accounts để xem chat này đang giữ những tài khoản nào." }],
    });
  }
  if (Object.keys(store.chat(ctx.chatId).accounts).length) {
    return reply(ctx, {
      icon: "🔐",
      title: "Chưa chọn tài khoản",
      subtitle: "Chat này có nhiều tài khoản.",
      tone: "warn",
      blocks: [{ text: "Gõ /accounts rồi /use <tên> để chọn tài khoản đang dùng." }],
    });
  }
  return reply(ctx, {
    icon: "🔐",
    title: "Chưa có tài khoản",
    subtitle: "Gõ /login để liên kết tài khoản Caffi của bạn.",
    tone: "warn",
  });
}

async function requireAccount(ctx: Ctx): Promise<Account | null> {
  const { name } = targetArgs(ctx);
  const account = store.resolve(ctx.chatId, name);
  if (!account) {
    await noAccountReply(ctx, name);
    return null;
  }
  if (account.sessionInvalid) {
    await reply(ctx, {
      icon: "🔒",
      title: "Phiên đã bị đăng xuất",
      subtitle: account.invalidReason,
      tone: "error",
      blocks: [{ text: `Tài khoản: ${account.username}` }, { text: "Gõ /login để đăng nhập lại." }],
    });
    return null;
  }
  return account;
}

// ── /all ───────────────────────────────────────────────────────────────────
// The multi-account roll-up: one row per login held by this chat.

/** One line of the roll-up. Every number is optional so failures show as "—". */
export interface AccountSummary {
  username: string;
  /** True for the login `/status` and friends use when no name is given. */
  active: boolean;
  auto: boolean;
  sessionInvalid: boolean;
  checkedIn?: boolean;
  streak?: number;
  position?: number;
  balance?: number;
  /** Set only when the API could not be read — the session itself is fine. */
  error?: string;
}

export function allCard(rows: AccountSummary[]): Card {
  const table = grid([
    ["", "Tài khoản", "Nay", "Chuỗi", "Hạng", "Xèng", "Auto"],
    ...rows.map((r) => [
      r.active ? "▶" : "",
      trunc(r.username, 26),
      r.error ? "❌" : r.checkedIn ? "✅" : r.sessionInvalid ? "🔒" : "—",
      r.streak !== undefined ? num(r.streak) : "—",
      r.position !== undefined ? num(r.position) : "—",
      r.balance !== undefined ? num(r.balance) : "—",
      r.auto ? "on" : "off",
    ]),
  ]);

  const broken = rows.filter((r) => r.error);
  const blocks: NonNullable<Card["blocks"]> = [{ mono: true, text: table }];
  if (broken.length) {
    blocks.push({
      heading: "Chưa đọc được",
      text: broken.map((r) => `${trunc(r.username, 30)} — ${trunc(r.error, 70)}`).join("\n"),
    });
  }

  return {
    icon: "👥",
    title: "Tất cả tài khoản",
    subtitle: "Mỗi dòng là một login trong chat này",
    tone: broken.length ? "warn" : "success",
    stats: [
      { label: "Tài khoản", value: num(rows.length) },
      { label: "Điểm danh hôm nay", value: num(rows.filter((r) => r.checkedIn).length) },
      { label: "Tự bật", value: num(rows.filter((r) => r.auto).length) },
      { label: "Hết phiên", value: num(rows.filter((r) => r.sessionInvalid).length) },
    ],
    blocks,
    footer: "Chỉ đọc · /use <tên> để đổi · /auto on|off [tên] để bật/tắt.",
  };
}

async function doAll(ctx: Ctx): Promise<void> {
  const chat = store.chat(ctx.chatId);
  const list = Object.values(chat.accounts);
  if (!list.length) return noAccountReply(ctx);

  const rows = await Promise.all(
    list.map(async (a): Promise<AccountSummary> => {
      const base = {
        username: a.username,
        active: chat.activeAccount === a.username,
        auto: a.autoCheckIn,
        sessionInvalid: a.sessionInvalid,
      };
      // Token is dead: asking would only fail, and /accounts already says why.
      if (a.sessionInvalid) return base;
      try {
        const api = apiFor(a);
        const [s, w] = await Promise.all([
          api.getCheckInStatus().catch(() => null),
          api.getWallet().catch(() => null),
        ]);
        if (!s && !w) return { ...base, error: "Không đọc được" };
        return {
          ...base,
          checkedIn: s?.todayCheckedIn,
          streak: s?.currentStreak,
          position: s?.todayCheckInPosition,
          balance: w?.wallet?.balance,
        };
      } catch (e) {
        return { ...base, error: (e as Error).message };
      }
    }),
  );

  return reply(ctx, allCard(rows), accountKeys(chat));
}

/** Pure, so `/accounts` can be rendered (and tested) without touching the network. */
export function accountsCard(chat: ChatState): Card {
  const list = Object.values(chat.accounts);
  if (!list.length) {
    return {
      icon: "📋",
      title: "Tài khoản",
      subtitle: "Chưa có tài khoản nào.",
      tone: "warn",
      blocks: [{ text: "Gõ /login để thêm." }],
    };
  }

  const rows: string[][] = [["", "Tài khoản", "Tên hiển thị", "Trạng thái"]];
  for (const a of list) {
    rows.push([
      a.username === chat.activeAccount ? "▶" : "",
      a.username,
      a.displayName ?? "—",
      a.sessionInvalid ? "🔒 hết phiên" : a.autoCheckIn ? "⏰ auto" : "⏸ auto tắt",
    ]);
  }
  return {
    icon: "📋",
    title: "Tài khoản",
    subtitle: `${list.length} tài khoản · ▶ = đang dùng`,
    tone: "info",
    blocks: [{ mono: true, text: grid(rows) }],
  };
}

/**
 * One button per login, three per row, capped at nine accounts so the grid
 * stays inside Discord's five action rows once `SCREEN` is appended. The rest
 * remain reachable with `/use <tên>`.
 */
export function accountKeys(chat: ChatState): KeyRows {
  const users = Object.keys(chat.accounts).slice(0, 9);
  if (users.length < 2) return SCREEN;
  const rows: KeyRows = [];
  for (let i = 0; i < users.length; i += 3) {
    rows.push(
      users.slice(i, i + 3).map((u) => ({
        label: u === chat.activeAccount ? `▶ ${u}` : `👤 ${u}`,
        data: `nav:use ${u}`,
      })),
    );
  }
  return [...rows, ...SCREEN];
}

function doAccounts(ctx: Ctx): Promise<void> {
  const chat = store.chat(ctx.chatId);
  return reply(ctx, accountsCard(chat), accountKeys(chat));
}

function doUse(ctx: Ctx, username?: string): Promise<void> {
  if (!username) return reply(ctx, hint("Thiếu tên tài khoản", "/use ten@dang.nhap"));
  const chat = store.chat(ctx.chatId);
  if (!chat.accounts[username]) {
    return reply(ctx, {
      icon: "❌",
      title: "Không có tài khoản này",
      subtitle: username,
      tone: "error",
      blocks: [{ text: "Gõ /accounts để xem danh sách tài khoản của chat này." }],
    });
  }
  chat.activeAccount = username;
  store.touch();
  // Redraw the list so the ▶ marker follows the switch.
  return reply(ctx, accountsCard(chat), accountKeys(chat));
}

function doAuto(ctx: Ctx): Promise<void> {
  // Accepts every sensible order: `/auto`, `/auto on`, `/auto on ten@dang.nhap`
  // and `/auto ten@dang.nhap on` (Discord sends its options in the order they
  // were declared, Telegram in the order the user typed them).
  const { name, args } = targetArgs(ctx);
  const words = name ? [name, ...args] : args;
  const action = words.find((w) => w === "on" || w === "off");
  const named = words.find((w) => w !== "on" && w !== "off");

  const account = store.resolve(ctx.chatId, named);
  if (!account) return noAccountReply(ctx, named);

  if (action === undefined) {
    return reply(ctx, {
      icon: "⏰",
      title: "Tự động điểm danh",
      subtitle: `${account.username} · hiện: ${account.autoCheckIn ? "BẬT" : "TẮT"}`,
      tone: "info",
      blocks: [{ text: "Đổi bằng /auto on hoặc /auto off — thêm tên tài khoản nếu cần." }],
    });
  }

  account.autoCheckIn = action === "on";
  store.touch();
  return reply(ctx, {
    icon: account.autoCheckIn ? "⏰" : "⏸",
    title: account.autoCheckIn ? "Đã bật điểm danh tự động" : "Đã tắt điểm danh tự động",
    subtitle: `${account.username} · 00:00 giờ VN`,
    tone: account.autoCheckIn ? "success" : "warn",
  });
}

function doLogout(ctx: Ctx, username?: string): Promise<void> {
  const chat = store.chat(ctx.chatId);
  const target = username ?? chat.activeAccount ?? Object.keys(chat.accounts)[0];
  if (!target || !chat.accounts[target]) {
    return reply(ctx, hint("Không có tài khoản nào để xoá", ""));
  }
  delete chat.accounts[target];
  if (chat.activeAccount === target) {
    chat.activeAccount = Object.keys(chat.accounts)[0];
  }
  store.touch();
  return reply(ctx, {
    icon: "🗑",
    title: "Đã xoá tài khoản khỏi bot",
    subtitle: target,
    tone: "info",
    footer: "Token và mật khẩu đã bị xoá khỏi bộ nhớ của bot.",
  });
}

export { vnDate };
