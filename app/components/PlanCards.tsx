// Plan tier cards + Monthly|Yearly billing toggle (spec 15, design plan-usage.html).
// All numbers/prices arrive serialized from the server plan matrix — never
// hard-coded here. CTA labels derive from tier order (Current / Upgrade to X /
// Downgrade to X) — the design's all-"Downgrade" buttons are a known design bug.

import { BRAND, RADIUS, SPACE } from "./ui/tokens";

export interface PlanCardData {
  id: string;
  name: string;
  description: string;
  priceMonthly: number;
  priceYearlyPerMonth: number;
  yearlyTotal: number;
  trialDays: number;
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
  interval: "monthly" | "yearly",
  promo: PlanPromo | null | undefined,
): PromoPreview {
  const none = { kind: "not-applicable" } as const;
  if (!promo || plan.priceMonthly <= 0) return none;
  if (promo.plans.length && !promo.plans.includes(plan.id)) return none;
  if (promo.intervals.length && !promo.intervals.includes(interval))
    return none;
  const charge = interval === "yearly" ? plan.yearlyTotal : plan.priceMonthly;
  if (promo.kind === "fixed" && promo.value >= charge)
    return { kind: "too-large" };
  const after =
    promo.kind === "percent"
      ? charge * (1 - promo.value / 100)
      : charge - promo.value;
  if (after <= 0) return { kind: "too-large" };
  return {
    kind: "discounted",
    price: Number((interval === "yearly" ? after / 12 : after).toFixed(2)),
  };
}

/** Per-month price after the promo, or null when the code doesn't cover this plan/interval. */
export function promoPriceFor(
  plan: PlanCardData,
  interval: "monthly" | "yearly",
  promo: PlanPromo | null | undefined,
): number | null {
  const preview = promoPreviewFor(plan, interval, promo);
  return preview.kind === "discounted" ? preview.price : null;
}

function money(value: number): string {
  return `$${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}`;
}

/** Yearly discount computed from the plan matrix — never a hard-coded %. */
export function yearlySavingsPercent(plan: PlanCardData): number {
  if (plan.priceMonthly <= 0 || plan.yearlyTotal <= 0) return 0;
  return Math.round((1 - plan.yearlyTotal / (plan.priceMonthly * 12)) * 100);
}

/** Toggle badge copy. One shared saving → "Save N%", mixed → "Save up to N%". */
export function savingsBadgeLabel(plans: PlanCardData[]): string | null {
  const savings = plans.map(yearlySavingsPercent).filter((pct) => pct > 0);
  if (savings.length === 0) return null;
  const max = Math.max(...savings);
  return new Set(savings).size === 1 ? `Save ${max}%` : `Save up to ${max}%`;
}

export function termsFor(
  plan: PlanCardData,
  interval: "monthly" | "yearly",
): string {
  if (plan.priceMonthly === 0) return "Free forever — no subscription needed.";
  if (interval === "yearly") {
    const saving = yearlySavingsPercent(plan);
    return saving > 0
      ? `Billed ${money(plan.yearlyTotal)}/year — you save ${saving}%.`
      : `Billed ${money(plan.yearlyTotal)}/year.`;
  }
  return `${plan.trialDays}-day free trial, then ${money(plan.priceMonthly)}/month, billed by Shopify.`;
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
  interval: "monthly" | "yearly";
  onIntervalChange: (interval: "monthly" | "yearly") => void;
  onSelect: (planId: string) => void;
  subscribingPlan: string | null;
  promo?: PlanPromo | null;
}) {
  const savingsLabel = savingsBadgeLabel(props.plans);
  return (
    <s-stack gap="base">
      <div
        style={{
          padding: `${SPACE.xs}px 0`,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          role="radiogroup"
          aria-label="Billing interval"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: SPACE.xs,
            gap: SPACE.xs,
            background: "var(--s-color-bg-surface-secondary, #f1f1f1)",
            border: "1px solid var(--s-color-border, #e3e3e3)",
            borderRadius: RADIUS.pill * 2,
          }}
        >
          {(["monthly", "yearly"] as const).map((interval) => {
            const active = props.interval === interval;
            return (
              <button
                key={interval}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => props.onIntervalChange(interval)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: SPACE.sm,
                  padding: `${SPACE.sm}px ${SPACE.base}px`,
                  border: "none",
                  borderRadius: RADIUS.pill * 2,
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 600,
                  lineHeight: "20px",
                  color: active ? "#fff" : "var(--s-color-text, #303030)",
                  background: active ? BRAND.gradient : "transparent",
                  boxShadow: active ? "0 1px 3px rgba(0,0,0,0.18)" : "none",
                  transition: "background 150ms ease, color 150ms ease",
                }}
              >
                {interval === "monthly" ? "Monthly" : "Yearly"}
                {interval === "yearly" && savingsLabel ? (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      lineHeight: "16px",
                      padding: "0 6px",
                      borderRadius: RADIUS.pill,
                      background: active ? "rgba(255,255,255,0.22)" : "#dcfce7",
                      color: active ? "#fff" : "#15803d",
                    }}
                  >
                    {savingsLabel}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

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
          const price =
            props.interval === "yearly"
              ? plan.priceYearlyPerMonth
              : plan.priceMonthly;
          const subscribing = props.subscribingPlan === plan.id;
          const preview = promoPreviewFor(plan, props.interval, props.promo);
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
              <s-text color="subdued">{termsFor(plan, props.interval)}</s-text>
              {plan.overagePerConversation !== null ? (
                <s-text color="subdued">
                  ${plan.overagePerConversation} per additional AI conversation
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
