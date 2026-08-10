import { useEffect } from "react";
import { Link } from "react-router";
import type { ContactRowData } from "./ContactsShared";
import {
  CHANNEL_LABELS,
  ContactAvatar,
  ContactTypeBadge,
  contactDisplayName,
} from "./ContactsShared";

// Contact detail side panel (spec 11 v1): overlay sliding panel with contact
// info + their conversation list. Conversation rows link to /app/inbox
// (deep-link selection is owned by the inbox route — see spec delta note).

export interface ContactConversation {
  id: string;
  preview: string;
  status: string;
  lastMessageAt: string | Date;
}

function formatDate(value: string | Date) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function InfoRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0" }}>
      <s-text tone="neutral">{props.label}</s-text>
      <span style={{ textAlign: "right", fontSize: 13 }}>{props.children}</span>
    </div>
  );
}

export function ContactDetailPanel(props: {
  open: boolean;
  loading: boolean;
  contact: ContactRowData | null;
  conversations: ContactConversation[];
  onClose: () => void;
}) {
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
          }}
        >
          <s-heading>Contact details</s-heading>
          <s-button icon="x" variant="tertiary" accessibilityLabel="Close" onClick={onClose} />
        </div>

        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {props.loading || !contact ? (
            <s-text tone="neutral">Loading…</s-text>
          ) : (
            <s-stack gap="base">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <ContactAvatar id={contact.id} displayName={displayName} size={44} />
                <s-stack gap="none">
                  <s-text type="strong">{displayName}</s-text>
                  <ContactTypeBadge type={contact.type} />
                </s-stack>
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
                        <Link to="/app/inbox">Open in Inbox</Link>
                      </s-stack>
                    </s-box>
                  ))
                )}
              </s-stack>
            </s-stack>
          )}
        </div>
      </div>
    </div>
  );
}
