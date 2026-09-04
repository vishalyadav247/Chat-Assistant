// Shared types + helpers for the Inbox workspace (spec 10, design inbox.html).
// Types mirror the serialized shapes returned by app/lib/inbox/inbox.server.ts.

import type { ChatProductCard } from "./ChatProductCards";

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
  /** Team member who sent an agent reply (null = AI / admin / legacy). */
  authorMemberId?: string | null;
  content: string;
  /** Products the AI recommended on this turn (Message.productCards). */
  productCards?: ChatProductCard[] | null;
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
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    type: string;
    /** Presence only — used to tell "no orders yet" from "anonymous visitor". */
    shopifyCustomerId: string | null;
  } | null;
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

/** Exact totals for every rail tab, computed server-side over ALL conversations. */
export type InboxCounts = Record<FilterKey, number> & { unreadOpen: number };

// These predicates mirror FILTER_WHERE in app/lib/inbox/inbox.server.ts, which
// is the authority — filtering and counting both happen in the database now.
// They survive for the labels and for client-side reasoning about a single row
// (e.g. picking the right tab for a ?c= deep link). features.test.ts asserts the
// two definitions agree row-for-row so they cannot drift apart.
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

// Per-filter glyphs. A rail of seven text rows reads as a list of words; the
// same rail with a coloured mark per tab reads as a control you can scan.
const FILTER_ICON_PATHS: Record<FilterKey, string[]> = {
  all: ["M3 12h5l1.6 2.6h4.8L16 12h5", "M5.6 4.6h12.8l2.6 7.4v5.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V12z"],
  open: [
    "M20.5 11.6a7.9 7.9 0 0 1-8.5 7.9 9 9 0 0 1-3.4-.7L3.5 20.5l1.7-4.2a7.9 7.9 0 0 1-1.2-4.7A7.9 7.9 0 0 1 12 3.7a7.9 7.9 0 0 1 8.5 7.9z",
  ],
  resolved: ["M21.5 11.1V12a9.5 9.5 0 1 1-5.6-8.7", "M21.5 4.5 12 14l-2.8-2.8"],
  unassigned: [
    "M15.5 20.5v-1.8a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v1.8",
    "M9.5 4.2a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z",
    "M18.5 8.2h4",
    "M20.5 6.2v4",
  ],
  handover: ["M6.5 8.5h12l-3-3", "M17.5 15.5h-12l3 3"],
  starred: ["M12 3.6l2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17.4l-5.38 2.85 1.03-6L3.3 10l6-.9L12 3.6z"],
  blocked: ["M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z", "M5.8 5.8l12.4 12.4"],
};

/** 15px stroke glyph for one filter tab; colour comes from CSS currentColor. */
export function FilterIcon({ filter }: { filter: FilterKey }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {FILTER_ICON_PATHS[filter].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

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

/** Author caption for thread bubbles. */
export function authorLabel(
  message: InboxMessage,
  contactName: string | null,
  /** id → display name for the shop's team (from the loader's assignees). */
  teamNames?: Map<string, string>,
  /** Shown for AI replies — the store branding name the shopper sees. */
  botName?: string,
): string {
  if (message.role === "in") return displayName(contactName);
  if (message.author === "agent") {
    // Name the human who replied, so a team can tell each other apart.
    const name = message.authorMemberId ? teamNames?.get(message.authorMemberId) : undefined;
    return name ?? "You";
  }
  if (message.author === "ai") return botName?.trim() || "AI";
  return "ChatConvert";
}
