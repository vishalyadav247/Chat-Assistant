import { useState } from "react";
import type { SetupChecklist } from "../lib/dashboard/dashboard.server";

// Setup checklist (spec 13, design dashboard.html .cl-head/.cl-row): SVG
// progress ring N/6, To do / Done pills, deep links per step. Collapses with
// a celebration state at 6/6. The embed step's "unknown" state (no
// read_themes scope) renders a "Verify in theme editor" external link.

const RING_RADIUS = 24;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 150.8, as in the design

export function ProgressRing(props: { completed: number; total: number }) {
  const fraction = props.total === 0 ? 0 : props.completed / props.total;
  const offset = RING_CIRCUMFERENCE * (1 - fraction);
  return (
    <div style={{ position: "relative", width: 56, height: 56, flex: "none" }}>
      <svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={`${props.completed} of ${props.total} steps complete`}>
        <circle cx="28" cy="28" r={RING_RADIUS} fill="none" stroke="#e9e9ec" strokeWidth="6" />
        <circle
          cx="28"
          cy="28"
          r={RING_RADIUS}
          fill="none"
          stroke="url(#cc-ring-gradient)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 28 28)"
          style={{ transition: "stroke-dashoffset .4s ease" }}
        />
        <defs>
          <linearGradient id="cc-ring-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
      </svg>
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {props.completed}/{props.total}
      </span>
    </div>
  );
}

export function DashboardChecklist(props: {
  checklist: SetupChecklist;
  onNavigate: (href: string) => void;
}) {
  const { checklist } = props;
  const allDone = checklist.completed === checklist.total;
  const [expanded, setExpanded] = useState(!allDone);

  return (
    <s-section heading="Setup checklist">
      <s-stack gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <ProgressRing completed={checklist.completed} total={checklist.total} />
          <s-text tone="neutral">
            {allDone
              ? "🎉 You're all set — every step is complete."
              : "Finish these to unlock the best results."}
          </s-text>
          {allDone ? (
            <s-button variant="tertiary" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Hide checklist" : "Show checklist"}
            </s-button>
          ) : null}
        </s-stack>

        {expanded ? (
          <s-stack gap="small">
            {checklist.steps.map((step) => (
              <s-box key={step.id} padding="small" borderWidth="base" borderRadius="base">
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge
                      tone={
                        step.state === "done"
                          ? "success"
                          : step.state === "unknown"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {step.state === "done" ? "Done" : step.state === "unknown" ? "Verify" : "To do"}
                    </s-badge>
                    {step.state === "done" ? (
                      <s-text tone="neutral">{step.label}</s-text>
                    ) : (
                      <s-text>{step.label}</s-text>
                    )}
                  </s-stack>
                  {step.externalUrl ? (
                    <s-link href={step.externalUrl} target="_blank">
                      {step.linkLabel}
                    </s-link>
                  ) : (
                    <s-button variant="tertiary" onClick={() => props.onNavigate(step.href)}>
                      {step.linkLabel}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}
