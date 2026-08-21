// Pure promo-code helpers shared by server (promo-codes.server.ts) and client
// (platform coupons page). No DB, no secrets — safe in the browser bundle.

export type PromoKind = "percent" | "fixed";

/**
 * How long an unapproved redemption reservation holds a maxRedemptions slot.
 * Lives here so the operator console can label the "pending" column without
 * pulling the server module into the client bundle.
 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Upper-case and strip ALL whitespace (leading, trailing and internal) so
 * "save 20", "SAVE 20" and " save20 " all resolve to the same stored code.
 * `toUpperCase()` runs first, so `\s` can never match a letter — in particular
 * the letter S survives (the old `/s+/g` literal was a guaranteed no-op only
 * because of that ordering; with the regex fixed the ordering keeps it safe).
 */
export function normalizePromoCode(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export function promoCodeProblem(code: string): string | null {
  if (!code) return "Please enter a code.";
  if (!CODE_PATTERN.test(code))
    return "Codes are 3–32 characters: letters, numbers, dashes or underscores.";
  return null;
}

/**
 * Discount values must survive the trip to Shopify unchanged.
 * `AppSubscriptionDiscountInput.percentage` is a 0–1 fraction, and we send it
 * rounded to 4 dp — so a percent may carry at most 2 decimals (12.34 → 0.1234
 * exactly; 12.345 would silently become 0.1235 and the merchant would be
 * charged a different price than the card previewed). Fixed amounts are money:
 * 2 decimals.
 */
export function promoValueProblem(kind: PromoKind, value: number): string | null {
  if (!Number.isFinite(value) || value <= 0)
    return "Enter a discount value greater than 0.";
  if (kind === "percent" && value > 100)
    return "A percentage discount can't exceed 100%.";
  if (Math.round(value * 100) !== Number((value * 100).toFixed(6)))
    return kind === "percent"
      ? "A percentage can have at most 2 decimal places."
      : "An amount can have at most 2 decimal places (cents).";
  return null;
}

/** Random human-friendly code (no ambiguous 0/O/1/I). */
export function generatePromoCode(prefix = ""): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const p = normalizePromoCode(prefix);
  return p ? `${p}-${out}` : out;
}

export function describePromo(p: {
  kind: string;
  value: number | { toNumber(): number };
  durationIntervals: number | null;
}): string {
  const value = typeof p.value === "number" ? p.value : p.value.toNumber();
  const amount =
    p.kind === "percent"
      ? `${value % 1 === 0 ? value.toFixed(0) : value}% off`
      : `$${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)} off`;
  if (p.durationIntervals === null) return `${amount} forever`;
  if (p.durationIntervals === 1) return `${amount} for the first billing cycle`;
  return `${amount} for ${p.durationIntervals} billing cycles`;
}
