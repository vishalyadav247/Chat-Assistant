// Plan tier cards + Monthly|Yearly billing toggle (spec 15, design plan-usage.html).
// All numbers/prices arrive serialized from the server plan matrix — never
// hard-coded here. CTA labels derive from tier order (Current / Upgrade to X /
// Downgrade to X) — the design's all-"Downgrade" buttons are a known design bug.

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

const TIER_ORDER = ["free", "basic", "pro", "plus"];

function money(value: number): string {
  return `$${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}`;
}

export function termsFor(plan: PlanCardData, interval: "monthly" | "yearly"): string {
  if (plan.priceMonthly === 0) return "Free forever — no subscription needed.";
  if (interval === "yearly") {
    return `Billed ${money(plan.yearlyTotal)}/year — you save 18%.`;
  }
  return `${plan.trialDays}-day free trial, then ${money(plan.priceMonthly)}/month, billed by Shopify.`;
}

export function ctaFor(planId: string, currentPlan: string, planName: string): {
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
}) {
  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" justifyContent="center" alignItems="center">
        <s-button
          variant={props.interval === "monthly" ? "primary" : "secondary"}
          onClick={() => props.onIntervalChange("monthly")}
        >
          Monthly
        </s-button>
        <s-button
          variant={props.interval === "yearly" ? "primary" : "secondary"}
          onClick={() => props.onIntervalChange("yearly")}
        >
          Yearly
        </s-button>
        <s-badge tone="success">Save 18%</s-badge>
      </s-stack>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
          gap: 12,
          alignItems: "stretch",
        }}
      >
        {props.plans.map((plan) => {
          const cta = ctaFor(plan.id, props.currentPlan, plan.name);
          const price =
            props.interval === "yearly" ? plan.priceYearlyPerMonth : plan.priceMonthly;
          const subscribing = props.subscribingPlan === plan.id;
          return (
            <div
              key={plan.id}
              style={{
                border:
                  cta.kind === "current"
                    ? "2px solid #6d3bf5"
                    : plan.popular
                      ? "2px solid #3b82f6"
                      : "1px solid var(--s-color-border, #e3e3e3)",
                borderRadius: 12,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-heading>{plan.name}</s-heading>
                {cta.kind === "current" ? <s-badge tone="info">Current plan</s-badge> : null}
                {plan.popular && cta.kind !== "current" ? (
                  <s-badge tone="info">Most popular</s-badge>
                ) : null}
              </s-stack>
              <s-text color="subdued">{plan.description}</s-text>
              <s-stack direction="inline" gap="small-300" alignItems="baseline">
                <s-text type="strong" fontVariantNumeric="tabular-nums">
                  {money(price)}
                </s-text>
                <s-text color="subdued">/mo</s-text>
              </s-stack>
              {plan.overagePerConversation !== null ? (
                <s-text color="subdued">
                  ${plan.overagePerConversation} per additional AI conversation
                </s-text>
              ) : null}
              <s-text color="subdued">{termsFor(plan, props.interval)}</s-text>
              <div style={{ flex: 1 }}>
                <s-stack gap="small-300">
                  {plan.bullets.map((bullet) => (
                    <s-text key={bullet}>+ {bullet}</s-text>
                  ))}
                </s-stack>
              </div>
              <s-button
                variant={cta.kind === "current" ? "primary" : "secondary"}
                disabled={cta.kind === "current" || props.subscribingPlan !== null}
                loading={subscribing}
                onClick={() => props.onSelect(plan.id)}
              >
                {subscribing ? "Redirecting to Shopify…" : cta.label}
              </s-button>
            </div>
          );
        })}
      </div>
    </s-stack>
  );
}
