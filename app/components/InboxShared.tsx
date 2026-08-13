// Shared types + helpers for the Inbox workspace (spec 10, design inbox.html).
// Types mirror the serialized shapes returned by app/lib/inbox/inbox.server.ts.

export interface InboxRow {
  id: string;
  name: string | null;
  status: string;
  mode: string;
  starred: boolean;
  blocked: boolean;
  unread: boolean;
  handover: boolean;
  assigneeId: string | null;
  lastMessageAt: string;
  preview: string;
}

export interface InboxMessage {
  id: string;
  role: string;
  author: string;
  content: string;
  createdAt: string;
  seenAt: string | null;
}

export interface InboxDetail {
  id: string;
  status: string;
  mode: string;
  starred: boolean;
  blocked: boolean;
  unread: boolean;
  handover: boolean;
  assigneeId: string | null;
  rating: number | null;
  pageContext: unknown;
  startedAt: string;
  contact: { name: string | null; email: string | null; phone: string | null; type: string } | null;
  messages: InboxMessage[];
}

// ── Filters map (design inbox.html FILTERS) ────────────────────────────────

export type FilterKey =
  | "all"
  | "open"
  | "resolved"
  | "unassigned"
  | "handover"
  | "starred"
  | "blocked";

export const FILTER_ORDER: FilterKey[] = [
  "all",
  "open",
  "resolved",
  "unassigned",
  "handover",
  "starred",
  "blocked",
];

export const FILTERS: Record<FilterKey, { label: string; test: (c: InboxRow) => boolean }> = {
  all: { label: "All", test: (c) => !c.blocked },
  open: { label: "Open", test: (c) => c.status === "open" && !c.blocked },
  resolved: { label: "Resolved", test: (c) => c.status === "resolved" && !c.blocked },
  unassigned: {
    label: "Unassigned",
    test: (c) => !c.assigneeId && c.status === "open" && !c.blocked,
  },
  handover: { label: "Handover", test: (c) => c.handover && !c.blocked },
  starred: { label: "Starred", test: (c) => c.starred && !c.blocked },
  blocked: { label: "Blocked", test: (c) => c.blocked },
};

/** Red badge on "All" = unread open conversations (design renderFilters). */
export function unreadOpenCount(rows: InboxRow[]): number {
  return rows.filter((c) => c.unread && c.status === "open" && !c.blocked).length;
}

/** Star glyph driven by CSS `color` (currentColor) — filled or outline. */
export function StarIcon({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.57l-5.9 3.1 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Display helpers ─────────────────────────────────────────────────────────

export function displayName(name: string | null | undefined): string {
  return name?.trim() || "Visitor";
}

export function initials(name: string | null | undefined): string {
  const n = displayName(name);
  const parts = n.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "V";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + second).toUpperCase();
}

const AV_GRADIENTS = [
  "linear-gradient(135deg,#f472b6,#a78bfa)",
  "linear-gradient(135deg,#38bdf8,#22d3ee)",
  "linear-gradient(135deg,#34d399,#10b981)",
  "linear-gradient(135deg,#fbbf24,#f97316)",
  "linear-gradient(135deg,#a78bfa,#6366f1)",
  "linear-gradient(135deg,#fb7185,#f43f5e)",
  "linear-gradient(135deg,#2dd4bf,#0ea5e9)",
  "linear-gradient(135deg,#c084fc,#ec4899)",
];

export function avatarGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AV_GRADIENTS[Math.abs(hash) % AV_GRADIENTS.length];
}

/** Relative time for list rows ("Just now", "5m", "2h", "Yesterday", "3d", date). */
export function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 172_800_000) return "Yesterday";
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(iso).toLocaleDateString();
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Day-divider label ("Today", "Yesterday", or the date). */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Author caption for thread bubbles. */
export function authorLabel(message: InboxMessage, contactName: string | null): string {
  if (message.role === "in") return displayName(contactName);
  if (message.author === "agent") return "You";
  if (message.author === "ai") return "AI";
  return "ChatConvert";
}
