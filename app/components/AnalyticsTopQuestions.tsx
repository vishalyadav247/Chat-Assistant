import type { TopQuestion } from "../lib/analytics/shared";
import { BRAND } from "./ui/tokens";

// Top questions card + "Unanswered questions" mini-card (spec 14, design
// analytics.html .tq-list + unanswered card). The unanswered surface is the
// plan-gated "unanswered_analytics" feature (Basic+; open enforcement passes —
// the lock renders only when the server says the feature is off).

export function AnalyticsTopQuestions(props: { questions: TopQuestion[] }) {
  return (
    <s-section heading="Top questions">
      <s-stack gap="base">
        <s-text tone="neutral">What shoppers ask most.</s-text>
        {props.questions.length === 0 ? (
          <s-box padding="large">
            <s-text tone="neutral">
              No shopper questions yet — the most-asked questions appear here once
              conversations come in.
            </s-text>
          </s-box>
        ) : (
          <s-stack gap="base">
            {props.questions.map((q) => (
              <s-stack key={q.question} gap="small-300">
                <s-stack direction="inline" justifyContent="space-between" gap="base">
                  <s-text>{q.question}</s-text>
                  <s-text tone="neutral">
                    {q.count} {q.count === 1 ? "ask" : "asks"}
                  </s-text>
                </s-stack>
                <div
                  style={{
                    height: 7,
                    borderRadius: 5,
                    background: "var(--s-color-bg-subdued, #f1f1f3)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${q.pct}%`,
                      borderRadius: 5,
                      background: BRAND.progressGradient,
                    }}
                  />
                </div>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

export function AnalyticsUnansweredCard(props: {
  pendingQuestions: number;
  allowed: boolean;
  onReview: () => void;
}) {
  return (
    <s-section heading="Unanswered questions">
      {props.allowed ? (
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack gap="none">
            <s-text>
              {props.pendingQuestions === 0
                ? "All caught up — no questions waiting for review."
                : `${props.pendingQuestions} question${props.pendingQuestions === 1 ? "" : "s"} the AI could not answer.`}
            </s-text>
            <s-text tone="neutral">
              Review them to add curated answers and close knowledge gaps.
            </s-text>
          </s-stack>
          <s-button onClick={props.onReview}>Review questions</s-button>
        </s-stack>
      ) : (
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack gap="none">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text>Unanswered-questions analytics</s-text>
              <s-badge tone="info">Basic+</s-badge>
            </s-stack>
            <s-text tone="neutral">
              Upgrade to see which questions your AI could not answer and fix them.
            </s-text>
          </s-stack>
          <s-link href="/app/plan-usage">View plans</s-link>
        </s-stack>
      )}
    </s-section>
  );
}
