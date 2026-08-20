import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge, useSurface } from "../../lib/ui/surface";

// "Open in web ↗" (spec 18): from inside the Shopify admin, mint a one-time
// handoff token and open the standalone web app in a new tab, already signed
// in as the owner. Renders nothing on the web surface itself.
//
// Popup blockers: the new tab is opened synchronously on click and its
// location is assigned once the handoff URL comes back.

export function OpenInWebButton(props: {
  variant?: "primary" | "secondary" | "tertiary";
  label?: string;
  /** e.g. "secondary-actions" when placed directly inside an s-page header. */
  slot?: Lowercase<string>;
}) {
  const surface = useSurface();
  const shopify = useAppBridge();
  const fetcher = useFetcher<{ ok: boolean; url?: string; error?: string }>();
  const pending = useRef<Window | null>(null);
  // Popup blocked → offer the handoff URL as a plain link (valid 2 minutes).
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const win = pending.current;
    pending.current = null;
    if (fetcher.data.ok && fetcher.data.url) {
      if (win && !win.closed) {
        try {
          win.opener = null;
        } catch {
          /* opener already detached */
        }
        win.location.href = fetcher.data.url;
      } else {
        setFallbackUrl(fetcher.data.url);
        shopify.toast.show("Pop-up blocked — use the link next to the button", { isError: true });
      }
    } else {
      win?.close();
      shopify.toast.show(fetcher.data.error ?? "Couldn't open the web app", { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  if (surface !== "admin") return null;

  const button = (
    <s-button
      {...(props.slot ? { slot: props.slot } : {})}
      variant={props.variant ?? "secondary"}
      icon="external"
      loading={fetcher.state !== "idle"}
      onClick={() => {
        setFallbackUrl(null);
        // "about:blank" passes through App Bridge's window.open override
        // untouched (an empty URL would resolve to the iframe's own URL).
        pending.current = window.open("about:blank", "_blank");
        fetcher.submit({}, { method: "post", action: "/app/web-handoff" });
      }}
    >
      {props.label ?? "Open in web"}
    </s-button>
  );
  if (!fallbackUrl || props.slot) return button;
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {button}
      <s-link href={fallbackUrl} target="_blank">
        Open web app ↗
      </s-link>
    </s-stack>
  );
}
