import { useState } from "react";
import type { SetupChecklist } from "../lib/dashboard/dashboard.server";
import { ProgressRing } from "./ui/Progress";

// Setup checklist (spec 13, design dashboard.html .cl-head/.cl-row): SVG
// progress ring N/6, To do / Done pills, deep links per step. Collapses with
// a celebration state at 6/6. The embed step's "unknown" state (no
// read_themes scope) renders a "Verify in theme editor" external link.

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
