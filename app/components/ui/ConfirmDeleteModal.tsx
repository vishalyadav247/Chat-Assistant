import { useEffect } from "react";
import { RADIUS, SHADOW, SPACE } from "./tokens";

// Shopify-admin-style destructive confirmation: a small centered modal with
// the item named in the title, "can't be undone" body, Cancel + critical
// Delete. Replaces ad-hoc inline banners/button swaps. Renders above the
// app's custom modals (z-index 500 > BrowseModalShell's 400).

export function ConfirmDeleteModal(props: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { open, onCancel } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 500,
        background: "rgba(20,20,25,.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={props.title}
        style={{
          background: "var(--s-color-bg, #fff)",
          borderRadius: RADIUS.card,
          boxShadow: SHADOW.md,
          width: "100%",
          maxWidth: 420,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
          }}
        >
          <s-heading>{props.title}</s-heading>
        </div>
        <div style={{ padding: "16px 20px" }}>
          <s-paragraph>{props.body ?? "This can't be undone."}</s-paragraph>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: SPACE.sm,
            padding: "12px 20px 16px",
          }}
        >
          <s-button onClick={onCancel}>Cancel</s-button>
          <s-button
            variant="primary"
            tone="critical"
            disabled={props.loading}
            loading={props.loading}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "Delete"}
          </s-button>
        </div>
      </div>
    </div>
  );
}
