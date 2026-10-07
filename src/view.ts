/**
 * Platform-agnostic presentation layer.
 *
 * Handlers build a `Card`; the Telegram renderer turns it into HTML and the
 * Discord renderer into an embed. Nothing here touches the network or the
 * store, so every screen can be tested offline and both bots stay visually in
 * step.
 *
 * Card content is always **plain text** — escaping is the renderer's job, so
 * callers never have to remember which platform needs what.
 */

/** Drives the accent colour (Discord) and nothing else. */
export type Tone = "success" | "info" | "warn" | "error" | "gold";

export interface Stat {
  label: string;
  value: string;
}

export interface Block {
  heading?: string;
  text: string;
  /** Render as a monospace box — tables and progress strips stay aligned. */
  mono?: boolean;
}

export interface Card {
  icon: string;
  title: string;
  subtitle?: string;
  stats?: Stat[];
  blocks?: Block[];
  footer?: string;
  tone?: Tone;
  /**
   * Transient "working on it…" screen. Telegram shows it as a normal message;
   * Discord defers instead, so the card is dropped there rather than flashed for
   * a second and replaced.
   */
  progress?: boolean;
}

/** One button. `data` is opaque to this module. */
export interface Key {
  label: string;
  data: string;
}

/** Buttons, row by row. */
export type KeyRows = Key[][];

const TONE_COLOR: Record<Tone, number> = {
  success: 0x22c55e,
  info: 0x3b82f6,
  warn: 0xf59e0b,
  error: 0xef4444,
  gold: 0xfacc15,
};

/** Telegram hard-caps a message at 4096 characters; Discord's embed at 4096 too. */
const MAX_LEN = 4000;

// ── Shared formatting ──────────────────────────────────────────────────────

/** Group digits the way the app does it (`118.788`). */
export function num(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("vi-VN") : "—";
}

/** Vietnamese đồng, rounded to whole units. */
export function vnd(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? `${num(Math.round(n))} ₫` : "—";
}

/** "2026-10-07" or an ISO instant -> "07/10" (Vietnam). */
export function shortDate(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00+07:00` : iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(t));
}

/** An ISO instant -> "HH:MM:SS" in Vietnam. */
export function vnClock(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(t));
}

/** An ISO instant -> "HH:MM:SS.mmm" in Vietnam. The midnight race needs the millis. */
export function vnClockMs(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 7 * 3600 * 1000); // Vietnam is UTC+7 with no DST.
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${
    p(
      d.getUTCMilliseconds(),
      3,
    )
  }`;
}

/** Turn rows of cells into an aligned monospace table. */
export function grid(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => widths[i] = Math.max(widths[i] ?? 0, c.length));
  return rows
    .map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("   ").trimEnd())
    .join("\n");
}

/** A filled/empty progress bar, e.g. 16/30 orders. */
export function bar(done: number, total: number, width = 10): string {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ── Escape helpers (used only by the renderers) ───────────────────────────

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Discord markdown: the characters below would otherwise start formatting.
 * Backslash must go first so later escapes are not re-escaped.
 */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_~|>])/g, "\\$1");
}

// ── Telegram ───────────────────────────────────────────────────────────────

/** Render a card as Telegram HTML (`parse_mode: "HTML"`). */
export function renderHtml(card: Card): string {
  const out: string[] = [];
  out.push(`${card.icon} <b>${escapeHtml(card.title)}</b>`);
  if (card.subtitle) out.push(`<i>${escapeHtml(card.subtitle)}</i>`);

  if (card.stats?.length) {
    out.push("");
    for (const s of card.stats) {
      out.push(`<b>${escapeHtml(s.label)}:</b> ${escapeHtml(s.value)}`);
    }
  }

  for (const b of card.blocks ?? []) {
    if (!b.text) continue;
    out.push("");
    if (b.heading) out.push(`<b>${escapeHtml(b.heading)}</b>`);
    if (b.mono) out.push(`<pre>${escapeHtml(b.text)}</pre>`);
    else out.push(escapeHtml(b.text));
  }

  if (card.footer) {
    out.push("");
    out.push(`<i>${escapeHtml(card.footer)}</i>`);
  }
  return trimHtml(out.join("\n"));
}

/** Cut an HTML string below Telegram's limit without breaking a tag. */
function trimHtml(html: string): string {
  if (html.length <= MAX_LEN) return html;
  // Drop whole blocks first: cutting mid-tag produces an unparseable message.
  let cut = html.slice(0, MAX_LEN - 40);
  const lastClose = cut.lastIndexOf("</pre>");
  if (lastClose > 0) cut = cut.slice(0, lastClose) + "</pre>";
  else if (cut.includes("<pre>")) cut = cut.replace(/<pre>[\s\S]*$/, "");
  return `${cut}\n…`;
}

// ── Discord ────────────────────────────────────────────────────────────────

/**
 * The subset of Discord's embed object we use. Kept local so this module has no
 * dependency on discordeno — `discord.ts` feeds it straight into `embeds`.
 */
export interface EmbedLike {
  title: string;
  description?: string;
  color: number;
  footer?: { text: string };
}

/** Render a card as a Discord embed. */
export function toEmbed(card: Card): EmbedLike {
  const out: string[] = [];
  if (card.subtitle) out.push(`*${escapeMarkdown(card.subtitle)}*`);

  if (card.stats?.length) {
    out.push("");
    for (const s of card.stats) {
      out.push(`**${escapeMarkdown(s.label)}:** ${escapeMarkdown(s.value)}`);
    }
  }

  for (const b of card.blocks ?? []) {
    if (!b.text) continue;
    out.push("");
    if (b.heading) out.push(`**${escapeMarkdown(b.heading)}**`);
    if (b.mono) {
      // A fence inside the text would close the block early.
      out.push(`\`\`\`\n${b.text.replace(/```/g, "'\"'\"'")}\n\`\`\``);
    } else {
      out.push(escapeMarkdown(b.text));
    }
  }

  const embed: EmbedLike = {
    title: `${card.icon} ${card.title}`,
    color: TONE_COLOR[card.tone ?? "info"],
    description: out.join("\n").slice(0, 4000) || undefined,
  };
  if (card.footer) embed.footer = { text: card.footer.slice(0, 2048) };
  return embed;
}

// ── Plain text (console output, tests) ─────────────────────────────────────

/** Render a card as plain text — used by scripts and test assertions. */
export function renderPlain(card: Card): string {
  const out: string[] = [`${card.icon} ${card.title}`];
  if (card.subtitle) out.push(card.subtitle);
  for (const s of card.stats ?? []) out.push(`${s.label}: ${s.value}`);
  for (const b of card.blocks ?? []) {
    if (b.heading) out.push(b.heading);
    if (b.text) out.push(b.text);
  }
  if (card.footer) out.push(card.footer);
  return out.join("\n");
}

// ── Shared navigation menu ─────────────────────────────────────────────────

/**
 * The button grid shown under `/help` and `/start`. Both platforms render it —
 * Telegram as an inline keyboard, Discord as an action row of buttons.
 *
 * Exactly **4 rows**: `SCREEN` adds a fifth, and Discord allows five action
 * rows per message and five buttons per row.
 */
export const MENU: KeyRows = [
  [
    { label: "📊 Tổng quan", data: "nav:status" },
    { label: "💳 Ví & tiền", data: "nav:wallet" },
    { label: "🧾 Đơn hàng", data: "nav:orders" },
  ],
  [
    { label: "💰 Dòng tiền", data: "nav:balance" },
    { label: "🥇 Xếp hạng", data: "nav:rank" },
    { label: "🏆 Điểm thưởng", data: "nav:rewards" },
  ],
  [
    { label: "👤 Hồ sơ", data: "nav:info" },
    { label: "📅 Lịch sử", data: "nav:history" },
    { label: "🔔 Thông báo", data: "nav:notify" },
  ],
  [
    { label: "🎁 Deals", data: "nav:deals" },
    { label: "👥 Tất cả", data: "nav:all" },
    { label: "📋 Tài khoản", data: "nav:accounts" },
    { label: "❓ Trợ giúp", data: "nav:help" },
  ],
];

/** Buttons appended to every info screen: refresh it, or go back to the menu. */
export const SCREEN: KeyRows = [
  [
    { label: "🔄 Làm mới", data: "nav:refresh" },
    { label: "🏠 Menu", data: "nav:help" },
  ],
];

/** Merge two keyboard grids, row by row. */
export function withKeys(...grids: KeyRows[]): KeyRows {
  const rows: KeyRows = [];
  for (const g of grids) for (const r of g) rows.push(r);
  return rows;
}
