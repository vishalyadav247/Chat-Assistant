import { Link } from "react-router";
import { isUnlimitedQuota } from "../../lib/billing/plan-shared";
import { RADIUS } from "./tokens";

// The one vocabulary for "this costs more" (spec 15).
//
// Before this file the app said it three different ways — a hand-rolled amber
// chip in the proactive editor, an s-badge + button in the training sync rows,
// a .cin-upgrade span in the inbox — and said it not at all on seven gated
// features, where the control simply failed or silently capped. Merchants
// cannot upgrade for a limit they were never shown.
//
// Three components, one rule each:
//   PlanBadge   a visible control is LOCKED           → chip beside its label
//   PlanMeter   a quota is COUNTABLE                  → "N of M used" + bar
//   PlanBanner  a whole section is locked or capped   → banner + upgrade link
//
// The plan NAME always comes from the server (requiredPlanName /
// nextPlanNameForQuota read the live, operator-editable matrix). Never write a
// tier name into a component: the operator can move a feature between plans
// from /platform, and a hard-coded "Pro" would quietly start lying.

const UPGRADE_HREF = "/app/plan-usage";

/** Locked-control chip: `👑 Pro`. Sits inline next to the control's label. */
export function PlanBadge(props: { plan: string | null; label?: string }) {
  if (!props.plan) return null;
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 800,
        borderRadius: RADIUS.pill,
        padding: "2px 8px",
        color: "#8a5a00",
        background: "#fde68a",
        whiteSpace: "nowrap",
      }}
    >
      {props.label ?? `👑 ${props.plan}`}
    </span>
  );
}

/** Warning at 80% of the quota, critical at 100%. */
function quotaTone(used: number, quota: number): "auto" | "warning" | "critical" {
  if (quota <= 0) return "auto";
  const pct = (used / quota) * 100;
  return pct >= 100 ? "critical" : pct >= 80 ? "warning" : "auto";
}

/**
 * "12 of 20 curated answers used", with a bar and, once it matters, the plan
 * that raises the ceiling.
 *
 * Unlimited renders as a plain count: a progress bar against MAX_SAFE_INTEGER
 * is a permanently empty bar, which reads as broken rather than generous.
 */
export function PlanMeter(props: {
  used: number;
  quota: number;
  /** What is being counted, e.g. "curated answers". */
  label: string;
  /** Plan that raises this ceiling (nextPlanNameForQuota); null = highest. */
  nextPlan?: string | null;
}) {
  if (isUnlimitedQuota(props.quota)) {
    return (
      <s-text color="subdued">
        {props.used} {props.label} — unlimited on your plan
      </s-text>
    );
  }
  const tone = quotaTone(props.used, props.quota);
  const pct = props.quota > 0 ? Math.min(100, Math.round((props.used / props.quota) * 100)) : 0;
  const atCap = tone === "critical";
  return (
    <s-stack gap="small-400">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text tone={tone === "auto" ? undefined : tone}>
          {props.used} of {props.quota} {props.label} used
        </s-text>
        {tone !== "auto" && props.nextPlan ? (
          <Link to={UPGRADE_HREF}>Upgrade to {props.nextPlan}</Link>
        ) : null}
      </s-stack>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--s-color-border, #e3e3e3)",
          overflow: "hidden",
        }}
        role="progressbar"
        aria-valuenow={props.used}
        aria-valuemin={0}
        aria-valuemax={props.quota}
        aria-label={`${props.label} used`}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 3,
            background: atCap
              ? "#d72c0d"
              : tone === "warning"
                ? "#b98900"
                : "linear-gradient(135deg,#6d3bf5,#3b82f6)",
            transition: "width 200ms ease",
          }}
        />
      </div>
    </s-stack>
  );
}

/**
 * Section-level lock or cap. `plan` null → renders nothing, so a caller can
 * pass requiredPlanName() straight through without a conditional at every
 * site.
 */
export function PlanBanner(props: {
  plan: string | null;
  heading: string;
  children?: React.ReactNode;
  /** "critical" once a limit is actually blocking work rather than looming. */
  tone?: "info" | "warning" | "critical";
}) {
  if (!props.plan) return null;
  return (
    <s-banner tone={props.tone ?? "info"} heading={props.heading}>
      <s-stack gap="small-300">
        {props.children ? <s-paragraph>{props.children}</s-paragraph> : null}
        <div>
          <Link to={UPGRADE_HREF}>Upgrade to {props.plan}</Link>
        </div>
      </s-stack>
    </s-banner>
  );
}
