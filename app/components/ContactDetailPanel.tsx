import { useEffect } from "react";
import { Link } from "react-router";
import { SCROLLBAR_CSS } from "./ui/tokens";
import type { ContactRowData } from "./ContactsShared";
import { CHANNEL_LABELS, ContactTypeBadge, contactDisplayName } from "./ContactsShared";

// Contact detail side panel (spec 11 v1): overlay sliding panel with contact
// info + their conversation list. Conversation rows link to /app/inbox
// (deep-link selection is owned by the inbox route — see spec delta note).

export interface ContactConversation {
  id: string;
  preview: string;
  status: string;
  lastMessageAt: string | Date;
}

/** Serialized ContactActivity (contacts.server.ts) — dates arrive as strings. */
export interface ContactActivityItem {
  at: string | Date;
  kind: string;
  by?: string;
  rating?: number;
  products?: string[];
  to?: string;
  source?: string;
}

// Loading skeleton mirroring the panel's real layout (avatar + name, info box,
// conversation cards, activity lines) — Polaris web components ship no
// skeleton elements, so these are hand-rolled pulsing blocks.
const SKELETON_CSS = `
@keyframes ccdp-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
.ccdp-bone { background: var(--s-color-bg-surface-secondary, #e9e9ec); border-radius: 6px; animation: ccdp-pulse 1.4s ease-in-out infinite; }
/* Invisible for the first 150ms: loads faster than that never flash it. */
@keyframes ccdp-appear { to { opacity: 1; } }
.ccdp-skel { opacity: 0; animation: ccdp-appear .2s ease .15s forwards; }
`;

function Bone(props: { w: number | string; h: number; r?: number | string; style?: React.CSSProperties }) {
  return (
    <span
      className="ccdp-bone"
      style={{
        display: "block",
        width: props.w,
        height: props.h,
        borderRadius: props.r,
        flex: "none",
        ...props.style,
      }}
    />
  );
}

function PanelSkeleton() {
  return (
    <div className="ccdp-skel">
      <style>{SKELETON_CSS}</style>
      <s-stack gap="base">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Bone w={150} h={16} />
        <Bone w={64} h={12} r={10} />
      </div>
      <s-box padding="small" borderWidth="base" borderRadius="base">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}
          >
            <Bone w={80} h={12} />
            <Bone w={i % 2 ? 120 : 90} h={12} />
          </div>
        ))}
      </s-box>
      <Bone w={130} h={13} />
      {Array.from({ length: 2 }, (_, i) => (
        <Bone key={i} w="100%" h={84} r={10} />
      ))}
      <Bone w={110} h={13} />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <Bone w={i % 2 ? "55%" : "70%"} h={12} />
          <Bone w={48} h={12} />
        </div>
      ))}
      </s-stack>
    </div>
  );
}

function formatDate(value: string | Date) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(value: string | Date) {
  return `${formatDate(value)} ${new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

// Activity timeline (customer5.png): date group headers on a dotted vertical
// line, entry text left, time right.
function Chip(props: { label: string }) {
  return (
    <span
      style={{
        background: "var(--s-color-bg-surface-secondary, #ececef)",
        borderRadius: 6,
        padding: "1px 7px",
        fontSize: 12,
        whiteSpace: "nowrap",
        flex: "none",
      }}
    >
      {props.label}
    </span>
  );
}

/** Products one per line, full titles (no truncation) — the merchant needs
 *  to see every product a shopper was shown / added, not a clamped list. */
function ProductList(props: { products: string[] }) {
  return (
    <span
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        flex: "1 1 100%",
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      {props.products.map((title, i) => (
        <span key={`${title}-${i}`}>• {title}</span>
      ))}
    </span>
  );
}

function activityLabel(item: ContactActivityItem): React.ReactNode {
  switch (item.kind) {
    case "first_seen":
      return "First seen";
    case "conversation_started":
      return (
        <>
          <Chip label="A conversation" /> was started
        </>
      );
    case "conversation_resolved":
      return (
        <>
          <Chip label="A conversation" /> was resolved{item.by ? ` by ${item.by}` : ""}
        </>
      );
    case "handover":
      return (
        <>
          <Chip label="A conversation" /> was handed over to your team
        </>
      );
    case "rated":
      return (
        <>
          <Chip label="A conversation" /> was rated {item.rating} star
          {item.rating === 1 ? "" : "s"}
        </>
      );
    case "recommended":
      return (
        <>
          <Chip label="Recommended" />
          <ProductList products={item.products ?? []} />
        </>
      );
    case "added_to_cart":
      return (
        <>
          <Chip label="Added to cart" />
          <ProductList products={item.products?.length ? item.products : ["a product"]} />
        </>
      );
    case "converted":
      switch (item.source) {
        case "shopify_match":
        case "manual_link":
          return "Linked to an existing Shopify customer profile";
        case "manual_create":
          return "Converted to customer — Shopify profile created";
        case "storefront_id":
          return "Identified as a Shopify customer";
        case "prechat":
        case "handover_form":
          return "Shared contact details and became a lead";
        default:
          return item.to === "customer" ? "Converted to customer" : "Converted to lead";
      }
    default:
      return item.kind;
  }
}

function ActivityTimeline(props: { items: ContactActivityItem[] }) {
  // Group consecutive entries by calendar day (items arrive newest-first).
  const groups: { date: string; items: ContactActivityItem[] }[] = [];
  for (const item of props.items) {
    const date = new Date(item.at).toLocaleDateString(undefined, {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    });
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.items.push(item);
    else groups.push({ date, items: [item] });
  }
  return (
    <div
      style={{
        borderLeft: "2px solid var(--s-color-border, #e6e6e9)",
        marginLeft: 4,
      }}
    >
      {groups.map((group) => (
        <div key={group.date}>
          <div
            style={{
              padding: "8px 0 4px 14px",
              fontSize: 12.5,
              fontWeight: 650,
              color: "var(--s-color-text-secondary, #78787f)",
            }}
          >
            {group.date}
          </div>
          {group.items.map((item, i) => (
            <div
              key={`${item.kind}-${String(item.at)}-${i}`}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "6px 0 6px 14px",
                fontSize: 13,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: -5,
                  top: 11,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--s-color-icon, #616161)",
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                {activityLabel(item)}
              </span>
              <span style={{ flex: "none", fontWeight: 650, fontSize: 12.5 }}>
                {new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function InfoRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0" }}>
      <s-text tone="neutral">{props.label}</s-text>
      <span style={{ textAlign: "right", fontSize: 13 }}>{props.children}</span>
    </div>
  );
}

const DELETE_LABELS: Record<string, string> = {
  customer: "Delete customer",
  lead: "Delete lead",
  anonymous: "Delete anonymous",
};

export function ContactDetailPanel(props: {
  open: boolean;
  loading: boolean;
  contact: ContactRowData | null;
  conversations: ContactConversation[];
  activities: ContactActivityItem[];
  onClose: () => void;
  /** Header actions (design contact3/contact4.png): delete for every type;
   *  convert for lead (→ customer, creates the Shopify profile) and anonymous
   *  (→ lead). The parent opens the matching modal. */
  onDelete: (contact: ContactRowData) => void;
  onConvert: (contact: ContactRowData) => void;
}) {
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // The overlay owns scrolling while open — hide the page's own scrollbar.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  const contact = props.contact;
  const displayName = contact ? contactDisplayName(contact) : "";

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 400,
        background: "rgba(20,20,25,.5)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Contact details"
        style={{
          background: "var(--s-color-bg, #fff)",
          width: "100%",
          maxWidth: 420,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "-6px 0 20px rgba(20,20,25,.2)",
        }}
      >
        {/* No heading — the two action buttons need the width (left-aligned,
            close X pinned right); the dialog keeps its aria-label. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 20px",
            borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
          }}
        >
          {/* !loading too: while a new contact is being fetched, `contact`
              still holds the PREVIOUS one — showing its buttons and then
              swapping them is confusing. Render actions only for loaded data. */}
          {contact && !props.loading ? (
            <>
              <s-button tone="critical" onClick={() => props.onDelete(contact)}>
                {DELETE_LABELS[contact.type] ?? "Delete contact"}
              </s-button>
              {contact.type === "lead" || contact.type === "anonymous" ? (
                <s-button variant="primary" onClick={() => props.onConvert(contact)}>
                  {contact.type === "lead" ? "Convert to customer" : "Convert to lead"}
                </s-button>
              ) : null}
            </>
          ) : null}
          <div style={{ marginLeft: "auto" }}>
            <s-button icon="x" variant="tertiary" accessibilityLabel="Close" onClick={onClose} />
          </div>
        </div>

        <style>{SCROLLBAR_CSS}</style>
        <div className="cc-scroll" style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {props.loading || !contact ? (
            <PanelSkeleton />
          ) : (
            <s-stack gap="base">
              {/* Name + type only (no avatar — merchant request 2026-08-17). */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 4,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    // Capitalize real names only — emails ("Visitor" fallback
                    // aside, displayName may be one) should stay as typed.
                    textTransform: contact.name?.trim() ? "capitalize" : undefined,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                  }}
                >
                  {displayName}
                </span>
                <ContactTypeBadge type={contact.type} />
              </div>

              <s-box padding="small" borderWidth="base" borderRadius="base">
                <InfoRow label="Email">{contact.email || "—"}</InfoRow>
                <InfoRow label="Phone">{contact.phone || "—"}</InfoRow>
                <InfoRow label="Channel">
                  {CHANNEL_LABELS[contact.channel] ?? contact.channel}
                </InfoRow>
                <InfoRow label="Location">{contact.location || "—"}</InfoRow>
                <InfoRow label="Marketing opt-in">
                  {contact.marketingOptIn ? "Yes" : "No"}
                </InfoRow>
                <InfoRow label="First seen">{formatDate(contact.createdAt)}</InfoRow>
                <InfoRow label="Last chat at">
                  {contact.lastActivityAt ? formatDateTime(contact.lastActivityAt) : "—"}
                </InfoRow>
              </s-box>

              <s-stack gap="small">
                <s-text type="strong">
                  Conversations ({props.conversations.length})
                </s-text>
                {props.conversations.length === 0 ? (
                  <s-text tone="neutral">No conversations yet.</s-text>
                ) : (
                  props.conversations.map((c) => (
                    <s-box key={c.id} padding="small" borderWidth="base" borderRadius="base">
                      <s-stack gap="none">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <s-badge tone={c.status === "resolved" ? "success" : "info"}>
                            {c.status === "resolved" ? "Resolved" : "Open"}
                          </s-badge>
                          <s-text tone="neutral">{formatDate(c.lastMessageAt)}</s-text>
                        </div>
                        <span
                          style={{
                            fontSize: 13,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            padding: "4px 0",
                          }}
                        >
                          {c.preview || <s-text tone="neutral">No messages</s-text>}
                        </span>
                        <Link to={`/app/inbox?c=${c.id}`}>Open in Inbox</Link>
                      </s-stack>
                    </s-box>
                  ))
                )}
              </s-stack>

              <s-stack gap="none">
                <s-text type="strong">Activity</s-text>
                <span
                  style={{
                    fontSize: 12.5,
                    color: "var(--s-color-text-secondary, #8a8a93)",
                    paddingBottom: 6,
                  }}
                >
                  Track all activities in conversations with your customers
                </span>
                {props.activities.length === 0 ? (
                  <s-text tone="neutral">No activity yet.</s-text>
                ) : (
                  <ActivityTimeline items={props.activities} />
                )}
              </s-stack>
            </s-stack>
          )}
        </div>
      </div>
    </div>
  );
}
