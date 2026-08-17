// Shared bits for the Contacts CRM page (spec 11, design contacts.html):
// avatar with initials, type badge, channel labels, display-name fallbacks.
// Client-safe — also imported by app/lib/contacts/contacts.server.ts for the
// page-size constant and type unions (keeps the .server module out of the
// client bundle).

export const CONTACTS_PAGE_SIZE = 10;

export type ContactType = "customer" | "lead" | "anonymous";
export type ContactSort = "created" | "name" | "updated";
export type ContactSortDir = "asc" | "desc";

export interface ContactRowData {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  type: string;
  channel: string;
  location: string | null;
  marketingOptIn: boolean;
  createdAt: string | Date;
  /** Latest conversation activity — the "Last updated" sort key. */
  lastActivityAt: string | Date | null;
  conversationCount: number;
}

/** One comparator for the table AND the CSV export (listContacts) so the
 *  "current page" export always matches what the sorted table shows. */
export function compareContacts(
  a: Pick<ContactRowData, "name" | "createdAt" | "lastActivityAt">,
  b: Pick<ContactRowData, "name" | "createdAt" | "lastActivityAt">,
  sort: ContactSort,
  dir: ContactSortDir,
): number {
  const flip = dir === "asc" ? 1 : -1;
  if (sort === "name") {
    const an = a.name?.trim() ?? "";
    const bn = b.name?.trim() ?? "";
    // Unnamed contacts sink to the bottom in either direction.
    if (!an || !bn) return an ? -1 : bn ? 1 : 0;
    return an.localeCompare(bn, undefined, { sensitivity: "base" }) * flip;
  }
  const time = (c: Pick<ContactRowData, "createdAt" | "lastActivityAt">) =>
    new Date(sort === "updated" ? (c.lastActivityAt ?? c.createdAt) : c.createdAt).getTime();
  return (time(a) - time(b)) * flip;
}

export const CHANNEL_LABELS: Record<string, string> = {
  store: "Online store",
  email: "Email",
  msgr: "Messenger",
  wa: "WhatsApp",
  ig: "Instagram",
};

export const TYPE_LABELS: Record<string, string> = {
  customer: "Customer",
  lead: "Lead",
  anonymous: "Anonymous",
};

const TYPE_TONES: Record<string, "success" | "info" | "neutral"> = {
  customer: "success",
  lead: "info",
  anonymous: "neutral",
};

// Avatar gradients from the design prototype, picked deterministically per contact.
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#f472b6,#a78bfa)",
  "linear-gradient(135deg,#38bdf8,#22d3ee)",
  "linear-gradient(135deg,#34d399,#10b981)",
  "linear-gradient(135deg,#fbbf24,#f97316)",
  "linear-gradient(135deg,#a78bfa,#6366f1)",
  "linear-gradient(135deg,#fb7185,#f43f5e)",
  "linear-gradient(135deg,#2dd4bf,#0ea5e9)",
  "linear-gradient(135deg,#c084fc,#ec4899)",
];

export function contactDisplayName(contact: { name: string | null; email: string | null }) {
  return contact.name?.trim() || contact.email?.trim() || "Visitor";
}

/** Contacts store one name column; Shopify customers use first/last. Split on
 *  the first space for form prefills — forms join back on save. */
export function splitContactName(name: string | null): { firstName: string; lastName: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function contactInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (first + second).toUpperCase();
}

function gradientFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

export function ContactAvatar(props: {
  id: string;
  displayName: string;
  size?: number;
  /** Pass the contact type — anonymous contacts render a neutral person icon
   *  instead of gradient initials (their names are auto-generated). */
  type?: string;
}) {
  const size = props.size ?? 34;
  const anonymous = props.type === "anonymous";
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.max(10, Math.round(size * 0.32)),
        fontWeight: 700,
        color: anonymous ? "var(--s-color-text-secondary, #8a8a93)" : "#fff",
        background: anonymous
          ? "var(--s-color-bg-surface-secondary, #ededf0)"
          : gradientFor(props.id),
        boxShadow: anonymous ? "inset 0 0 0 1px var(--s-color-border, #e3e3e6)" : undefined,
      }}
    >
      {anonymous ? <s-icon type="person" size="small" /> : contactInitials(props.displayName)}
    </div>
  );
}

export function ContactTypeBadge(props: { type: string }) {
  return (
    <s-badge tone={TYPE_TONES[props.type] ?? "neutral"}>
      {TYPE_LABELS[props.type] ?? props.type}
    </s-badge>
  );
}

export function EmDash() {
  return <s-text tone="neutral">—</s-text>;
}
