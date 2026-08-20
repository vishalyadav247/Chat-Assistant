import { useEffect, useRef } from "react";
import { useAppBridge } from "../lib/ui/surface";

// App Store review prompt (spec: .claude/specs/APP_REVIEW.md). Fires
// shopify.reviews.request() once per app load when the server-side gate says
// the shop is eligible; Shopify decides whether the modal actually appears
// (60-day cooldown, 3/year cap, already-reviewed — all enforced on its side).

type ReviewsApi = {
  reviews?: {
    request: () => Promise<{ success: boolean; code: string; message?: string }>;
  };
};

export function ReviewPrompt({ eligible }: { eligible: boolean }) {
  const shopify = useAppBridge();
  // Loaders revalidate on every client-side navigation, so `eligible` arrives
  // repeatedly; without this guard one session could burn all 3 annual slots.
  const asked = useRef(false);

  useEffect(() => {
    if (!eligible || asked.current) return;
    // App Bridge is CDN-delivered and self-updating; an older cached bundle
    // has no `reviews` API and calling it would throw into the error boundary.
    const reviews = (shopify as unknown as ReviewsApi).reviews;
    if (typeof reviews?.request !== "function") return;
    asked.current = true;

    reviews.request().then(
      (r) => {
        if (!r.success) console.debug(`[reviews] not shown: ${r.code}`);
      },
      (e) => console.debug("[reviews] request failed", e),
    );
  }, [eligible, shopify]);

  return null;
}
