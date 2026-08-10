// Dashboard hero (spec 13, design dashboard.html): time-of-day greeting,
// "Assistant online" pulsing pill, dynamic subline, three actions. The
// design's purple gradient is widget-only branding — admin surfaces use
// standard Polaris (see polaris-admin-ui skill); structure + copy carry over.

export function AssistantPill(props: { online: boolean }) {
  return (
    <s-badge tone={props.online ? "success" : "neutral"}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {props.online ? (
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#16a34a",
              display: "inline-block",
              animation: "cc-pulse 1.6s ease-in-out infinite",
            }}
          />
        ) : null}
        {props.online ? "Assistant online" : "Assistant off"}
      </span>
      <style>{`@keyframes cc-pulse{0%,100%{box-shadow:0 0 0 2px rgba(34,197,94,.25);}50%{box-shadow:0 0 0 6px rgba(34,197,94,.05);}}`}</style>
    </s-badge>
  );
}

export function DashboardHero(props: {
  pendingQuestions: number;
  atcThisMonth: number;
  aiEnabled: boolean;
  syncing: boolean;
  onAnswerQuestions: () => void;
  onSyncCatalog: () => void;
  onPreviewWidget: () => void;
}) {
  const { pendingQuestions: pending, atcThisMonth: atc } = props;
  const subline =
    pending === 0 && atc === 0
      ? "Your assistant is ready — shoppers' questions and chat add-to-carts will show up here."
      : `${pending} shopper ${pending === 1 ? "question is" : "questions are"} waiting for an answer, and your assistant drove ${atc} chat add-to-cart${atc === 1 ? "" : "s"} this month.`;

  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-text tone="neutral">{subline}</s-text>
          <AssistantPill online={props.aiEnabled} />
        </s-stack>
        <s-stack direction="inline" gap="small">
          <s-button variant="primary" onClick={props.onAnswerQuestions}>
            {pending > 0
              ? `Answer ${pending} question${pending === 1 ? "" : "s"}`
              : "Review questions"}
          </s-button>
          <s-button disabled={props.syncing} onClick={props.onSyncCatalog}>
            {props.syncing ? "Syncing…" : "Sync catalog"}
          </s-button>
          <s-button onClick={props.onPreviewWidget}>Preview widget</s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
