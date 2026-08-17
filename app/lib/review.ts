// App Store review prompt domain logic (spec: .claude/specs/APP_REVIEW.md).
// Pure module — no I/O — so it is importable from client components and the
// gate stays testable/tunable in one place. We store NO prompt state of our
// own: Shopify tracks the 60-day cooldown, 3/year cap, and already-reviewed
// state, and enforces them on every reviews.request() call.

export const REVIEW_MIN_INSTALL_AGE_MS = 24 * 60 * 60 * 1000;

// The handle comes from SHOPIFY_APP_STORE_HANDLE (env) — blank until the
// listing is live. While blank this returns null and the fallback link
// renders nothing. The fragment must be exactly `WriteReviewModal` — there is
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
