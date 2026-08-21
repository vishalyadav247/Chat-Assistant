import { useEffect } from "react";
import { useBlocker } from "react-router";
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

  // Leave guard. The embedded admin gets this from App Bridge's ui-save-bar;
  // the standalone web surface has to do it itself, or rail navigation and
  // tab closes silently drop the edits (QA D11).
  const guard = surface === "web" && props.dirty;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      guard && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!guard) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guard]);
  // A blocked navigation that is no longer dirty (saved/discarded mid-prompt)
  // must not stay stuck.
  useEffect(() => {
    if (blocker.state === "blocked" && !guard) blocker.reset?.();
  }, [blocker, guard]);

  if (surface === "web") {
    if (blocker.state === "blocked") {
      return (
        <div
          role="alertdialog"
          aria-label="Unsaved changes"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,.45)",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#fff",
              color: "#1a1a1a",
              borderRadius: 12,
              padding: 20,
              maxWidth: 380,
              boxShadow: "0 12px 32px rgba(0,0,0,.3)",
              fontSize: 14,
            }}
          >
            <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 15 }}>Unsaved changes</p>
            <p style={{ margin: "0 0 16px" }}>
              You have unsaved changes. Leaving this page will discard them.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => blocker.reset?.()}
                style={{
                  borderRadius: 8,
                  padding: "6px 12px",
                  cursor: "pointer",
                  font: "inherit",
                  background: "#fff",
                  border: "1px solid #c9c9c9",
                }}
              >
                Stay
              </button>
              <button
                type="button"
                onClick={() => blocker.proceed?.()}
                style={{
                  borderRadius: 8,
                  padding: "6px 12px",
                  cursor: "pointer",
                  font: "inherit",
                  background: "#1a1a1a",
                  color: "#fff",
                  border: "1px solid #1a1a1a",
                }}
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      );
    }
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
          bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
          // Below the mobile nav drawer (drawer 110 / scrim 100 in
          // web-shell.css) so an open drawer is never covered (QA D11).
          zIndex: 90,
          maxWidth: "calc(100vw - 24px)",
          display: "flex",
          flexWrap: "wrap",
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
