// App Store review prompt domain logic (spec: .claude/specs/APP_REVIEW.md).
// Pure module — no I/O — so it is importable from client components and the
// gate stays testable/tunable in one place. We store NO prompt state of our
// own: Shopify tracks the 60-day cooldown, 3/year cap, and already-reviewed
// state, and enforces them on every reviews.request() call.

export const REVIEW_MIN_INSTALL_AGE_MS = 24 * 60 * 60 * 1000;

/** The App Store LISTING slug: `apps.shopify.com/<this>`.
 *
 *  NOT the same field as `handle` in shopify.app.toml — that one is the App
 *  Home admin-URL slug, and the two drifted apart (the toml said
 *  "chatconvert-app" while the listing had been live at "chatconvert-2" since
 *  2026-07-22, so every App Store link in the app pointed at a 404).
 *
 *  Baked in as the LAST fallback so the links work with no ops step. Admin →
 *  Settings and SHOPIFY_APP_STORE_HANDLE both still win over it — that is the
 *  escape hatch if the slug ever changes before a deploy can go out. */
export const DEFAULT_APP_STORE_HANDLE = "chatconvert-2";

// The handle is the EFFECTIVE one — runtimeConfig().appStoreHandle, i.e.
// Admin → Settings, then SHOPIFY_APP_STORE_HANDLE, then the constant above —
// never process.env directly. The fragment must be exactly `WriteReviewModal`;
// there is
// no validation on Shopify's side; a typo silently degrades the link into a
// plain listing page.
export function reviewFallbackUrl(handle: string): string | null {
  if (!handle) return null;
  return `https://apps.shopify.com/${handle}#modal-show=WriteReviewModal`;
}

export function isReviewPromptEligible({
  installedAt,
  hasEngaged,
  now = new Date(),
}: {
  installedAt: Date | null | undefined;
  hasEngaged: boolean;
  now?: Date;
}): boolean {
  if (!installedAt || !hasEngaged) return false;
  return now.getTime() - installedAt.getTime() > REVIEW_MIN_INSTALL_AGE_MS;
}
