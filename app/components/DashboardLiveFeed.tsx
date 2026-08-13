import type { LiveFeedItem } from "../lib/dashboard/dashboard.server";
import { EmptyState } from "./ui/EmptyState";
import { SPACE } from "./ui/tokens";

// Live conversations feed (spec 13, design dashboard.html .feed): latest 4
// open conversations — avatar initials, last shopper message, Live / Waiting
// for agent tag, relative time. Rows click through to the inbox thread.

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#f97316,#ef4444)",
  "linear-gradient(135deg,#8b5cf6,#6366f1)",
  "linear-gradient(135deg,#0ea5e9,#22c55e)",
  "linear-gradient(135deg,#ec4899,#f43f5e)",
];

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function FeedTag(props: { tag: LiveFeedItem["tag"] }) {
  if (props.tag === "waiting") return <s-badge tone="warning">Waiting for agent</s-badge>;
  if (props.tag === "live") {
    return (
      <s-badge tone="success">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#16a34a",
              display: "inline-block",
              animation: "cc-pulse 1.6s ease-in-out infinite",
            }}
          />
          Live
        </span>
      </s-badge>
    );
  }
  return <s-badge tone="neutral">Open</s-badge>;
}

export function DashboardLiveFeed(props: {
  items: LiveFeedItem[];
  onOpen: (conversationId: string) => void;
}) {
  return (
    <s-section heading="Live conversations">
      <s-stack gap="base">
        <s-text tone="neutral">Shoppers chatting with your AI right now.</s-text>
        {props.items.length === 0 ? (
          <EmptyState
            icon="chat"
            tone="accent"
            compact
            title="No conversations yet"
            description="Once the widget is live on your storefront, active chats will appear here."
          />
        ) : (
          <s-stack gap="small">
            {props.items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => props.onOpen(item.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)";
                  e.currentTarget.style.borderColor = "var(--p-color-border-emphasis, #b5b5bd)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)";
                  e.currentTarget.style.borderColor = "var(--p-color-border, #e9e9ec)";
                }}
                style={{
                  display: "flex",
                  gap: SPACE.md,
                  alignItems: "flex-start",
                  width: "100%",
                  padding: "12px",
                  background: "var(--p-color-bg-surface, #fff)",
                  border: "1px solid var(--p-color-border, #e9e9ec)",
                  borderRadius: 12,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                  transition: "box-shadow 120ms ease, border-color 120ms ease",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 9,
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#fff",
                    background: AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length],
                  }}
                >
                  {item.initials}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <s-text>{item.preview}</s-text>
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}
                  >
                    <FeedTag tag={item.tag} />
                    <s-text tone="neutral">{relativeTime(item.lastMessageAt)}</s-text>
                  </span>
                </span>
              </button>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
