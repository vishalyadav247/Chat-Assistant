// Plan tier cards (spec 15, design plan-usage.html). Monthly only — annual
// billing was withdrawn entirely on 2026-09-07, so there is no interval to pick.
// All numbers/prices arrive serialized from the server plan matrix — never
// hard-coded here. CTA labels derive from tier order (Current / Upgrade to X /
// Downgrade to X) — the design's all-"Downgrade" buttons are a known design bug.

import { BRAND, RADIUS, SPACE } from "./ui/tokens";

export interface PlanCardData {
  id: string;
  name: string;
  description: string;
  priceMonthly: number;
  trialDays: number;
  /** Per extra conversation. null = this plan never bills overage (Free).
   *  Only shown on the card in MONTHLY mode — see the render. */
  overagePerConversation: number | null;
  bullets: string[];
  popular: boolean;
}

/** Promo code validated by the server (app.plan-usage action) — preview only;
 *  the discount itself is applied by Shopify at subscribe time. */
export interface PlanPromo {
  code: string;
  label: string;
  kind: "percent" | "fixed";
  value: number;
  durationIntervals: number | null;
  plans: string[];
  intervals: string[];
}

const TIER_ORDER = ["free", "basic", "pro", "plus"];

/**
 * What the code does to this card. Mirrors the server's
 * promoApplicabilityProblem() so the preview and the subscribe-time answer
 * agree: a fixed discount bigger than the charge used to silently render the
 * full price here and then fail server-side with "this code doesn't apply to
 * that plan", which describes the wrong problem.
 */
export type PromoPreview =
  | { kind: "discounted"; price: number }
  | { kind: "too-large" }
  | { kind: "not-applicable" };

export function promoPreviewFor(
  plan: PlanCardData,
  promo: PlanPromo | null | undefined,
): PromoPreview {
  const none = { kind: "not-applicable" } as const;
  if (!promo || plan.priceMonthly <= 0) return none;
  if (promo.plans.length && !promo.plans.includes(plan.id)) return none;
  // A code stored for "yearly only" can never apply now that annual is gone.
  if (promo.intervals.length && !promo.intervals.includes("monthly")) return none;
  const charge = plan.priceMonthly;
  if (promo.kind === "fixed" && promo.value >= charge)
    return { kind: "too-large" };
  const after =
    promo.kind === "percent"
      ? charge * (1 - promo.value / 100)
      : charge - promo.value;
  if (after <= 0) return { kind: "too-large" };
  return {
    kind: "discounted",
    price: Number(after.toFixed(2)),
  };
}

/** Per-month price after the promo, or null when the code does not cover this plan. */
export function promoPriceFor(
  plan: PlanCardData,
  promo: PlanPromo | null | undefined,
): number | null {
  const preview = promoPreviewFor(plan, promo);
  return preview.kind === "discounted" ? preview.price : null;
}

function money(value: number): string {
  return `$${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}`;
}

/**
 * Trial phrase for this card. `trialDays` is the shop's REMAINING entitlement
 * (server-resolved), not the tier's headline allowance: a shop that has already
 * used its trial gets billed immediately, and saying "7-day free trial" to that
 * merchant is a false pricing claim (App Store requirement 1.1.4) as well as a
 * guaranteed support ticket. Returns "" when there is no trial to promise.
 */
export function trialPhraseFor(plan: PlanCardData): string {
  if (plan.trialDays <= 0) return "";
  // Always states what this shop will ACTUALLY get: a full allowance on a first
  // subscription, or whatever is left of one already part-used.
  return `${plan.trialDays}-day free trial, then `;
}

export function termsFor(plan: PlanCardData): string {
  if (plan.priceMonthly === 0) return "Free forever — no subscription needed.";
  const trial = trialPhraseFor(plan);
  return trial
    ? `${trial}${money(plan.priceMonthly)}/month, billed by Shopify.`
    : `${money(plan.priceMonthly)}/month, billed by Shopify.`;
}

export function ctaFor(
  planId: string,
  currentPlan: string,
  planName: string,
): {
  label: string;
  kind: "current" | "upgrade" | "downgrade";
} {
  const target = TIER_ORDER.indexOf(planId);
  const current = TIER_ORDER.indexOf(currentPlan);
  if (target === current) return { label: "Current plan", kind: "current" };
  return target > current
    ? { label: `Upgrade to ${planName}`, kind: "upgrade" }
    : { label: `Downgrade to ${planName}`, kind: "downgrade" };
}

export function PlanCards(props: {
  plans: PlanCardData[];
  currentPlan: string;
  onSelect: (planId: string) => void;
  subscribingPlan: string | null;
  promo?: PlanPromo | null;
}) {
  return (
    <s-stack gap="base">

      <div
        className="cc-plan-carousel"
        style={{
          display: "grid",
          // 2-up grid (user decision 2026-08-10): four plans render as 2×2.
          // Phones swipe a snap carousel with a peeking next card
          // (.cc-plan-carousel, Chatty reference plans.png).
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: SPACE.cardGrid,
          alignItems: "stretch",
        }}
      >
        {props.plans.map((plan) => {
          const cta = ctaFor(plan.id, props.currentPlan, plan.name);
          const price = plan.priceMonthly;
          const subscribing = props.subscribingPlan === plan.id;
          const preview = promoPreviewFor(plan, props.promo);
          const promoPrice =
            preview.kind === "discounted" ? preview.price : null;
          return (
            <div
              key={plan.id}
              style={{
                // Only the CURRENT plan gets an accent border; "Most popular" is
                // conveyed by the badge alone (user decision 2026-08-21).
                border:
                  cta.kind === "current"
                    ? `2px solid ${BRAND.accent}`
                    : "1px solid var(--s-color-border, #e3e3e3)",
                background: cta.kind === "current" ? BRAND.accentSoft : "#fff",
                borderRadius: RADIUS.card,
                padding: SPACE.cardPad,
                display: "flex",
                flexDirection: "column",
                gap: SPACE.sm,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: SPACE.sm,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{ fontSize: 20, fontWeight: 650, lineHeight: 1.2 }}
                >
                  {plan.name}
                </span>
                {cta.kind === "current" ? (
                  <s-badge tone="info">Current plan</s-badge>
                ) : null}
                {plan.popular && cta.kind !== "current" ? (
                  <s-badge tone="success">Most popular</s-badge>
                ) : null}
              </div>
              <s-text color="subdued">{plan.description}</s-text>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: SPACE.xs,
                  marginTop: SPACE.xs,
                }}
              >
                <span
                  style={{
                    fontSize: 32,
                    fontWeight: 700,
                    lineHeight: 1,
                    letterSpacing: "-0.02em",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {money(promoPrice ?? price)}
                </span>
                <s-text color="subdued">/mo</s-text>
                {promoPrice !== null ? (
                  <s-text color="subdued">
                    <s style={{ fontVariantNumeric: "tabular-nums" }}>
                      {money(price)}
                    </s>
                  </s-text>
                ) : null}
              </div>
              {promoPrice !== null && props.promo ? (
                <s-badge tone="success">
                  {props.promo.code}: {props.promo.label}
                </s-badge>
              ) : null}
              {preview.kind === "too-large" && props.promo ? (
                <s-text color="subdued">
                  {props.promo.code} takes {money(props.promo.value)} off — more
                  than this plan costs, so it can&apos;t be used here.
                </s-text>
              ) : null}
              <s-text color="subdued">{termsFor(plan)}</s-text>
              {/* MONTHLY PAID PLANS ONLY — the only case that can actually be
                  billed, so the only case a card may promise it (2026-09-03).
                  Free has no subscription and Shopify rejects usage lines on
                  ANNUAL ones, so both hard-cap at the quota instead: the card
                  used to print this line from the matrix alone and advertised a
                  charge the app would never make on two of its four tiers.
                  Same predicate as overageBillable() on the server. */}
              {plan.overagePerConversation !== null ? (
                <s-text color="subdued">
                  ${plan.overagePerConversation.toFixed(2)} per additional AI conversation
                </s-text>
              ) : null}
              <s-button
                variant={
                  cta.kind === "current"
                    ? "secondary"
                    : cta.kind === "upgrade"
                      ? "primary"
                      : "secondary"
                }
                disabled={
                  cta.kind === "current" || props.subscribingPlan !== null
                }
                loading={subscribing}
                onClick={() => props.onSelect(plan.id)}
              >
                {subscribing ? "Redirecting to Shopify…" : cta.label}
              </s-button>
              <div
                style={{
                  borderTop: "1px solid var(--s-color-border, #e3e3e3)",
                  marginTop: SPACE.xs,
                  paddingTop: SPACE.md,
                  flex: 1,
                }}
              >
                <s-stack gap="small-200">
                  {plan.bullets.map((bullet) => (
                    <div
                      key={bullet}
                      style={{
                        display: "flex",
                        gap: SPACE.sm,
                        alignItems: "flex-start",
                      }}
                    >
                      <span
                        style={{
                          color: BRAND.accent,
                          fontWeight: 700,
                          lineHeight: "20px",
                        }}
                        aria-hidden="true"
                      >
                        ✓
                      </span>
                      <s-text>{bullet}</s-text>
                    </div>
                  ))}
                </s-stack>
              </div>
            </div>
          );
        })}
      </div>
    </s-stack>
  );
}
