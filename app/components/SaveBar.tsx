import { useEffect } from "react";
import { useAppBridge, useSurface } from "../lib/ui/surface";

// Contextual save bar (specs 06/08/16): shows Shopify's save bar when a form
// is dirty; Save submits, Discard resets. In the admin this is the App Bridge
// ui-save-bar; on the standalone web surface (spec 18, no App Bridge) it is a
// fixed bottom bar with the same two actions.

export function SaveBar(props: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const surface = useSurface();
  const shopify = useAppBridge();

  useEffect(() => {
    if (surface !== "admin") return;
    if (props.dirty) {
      shopify.saveBar?.show?.("chatconvert-save-bar");
    } else {
      shopify.saveBar?.hide?.("chatconvert-save-bar");
    }
  }, [props.dirty, shopify, surface]);

  if (surface === "web") {
    if (!props.dirty) return null;
    const buttonBase = {
      borderRadius: 8,
      padding: "6px 12px",
      cursor: "pointer",
      font: "inherit",
    } as const;
    return (
      <div
        role="region"
        aria-label="Unsaved changes"
        style={{
          position: "fixed",
          left: "50%",
          transform: "translateX(-50%)",
          bottom: 16,
          zIndex: 900,
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "#1a1a1a",
          color: "#fff",
          borderRadius: 12,
          padding: "10px 12px 10px 16px",
          boxShadow: "0 8px 24px rgba(0,0,0,.28)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span>Unsaved changes</span>
        <span style={{ display: "inline-flex", gap: 8 }}>
          <button
            type="button"
            onClick={props.onDiscard}
            disabled={props.saving}
            style={{ ...buttonBase, background: "transparent", color: "#fff", border: "1px solid rgba(255,255,255,.35)" }}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={props.onSave}
            disabled={props.saving}
            style={{ ...buttonBase, background: "#fff", color: "#1a1a1a", border: "1px solid #fff", opacity: props.saving ? 0.7 : 1 }}
          >
            {props.saving ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
    );
  }

  return (
    <ui-save-bar id="chatconvert-save-bar">
      <button
        variant="primary"
        onClick={props.onSave}
        {...(props.saving ? { loading: "" } : {})}
      ></button>
      <button onClick={props.onDiscard}></button>
    </ui-save-bar>
  );
}
