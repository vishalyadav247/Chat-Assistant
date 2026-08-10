import { useState } from "react";

// Billing FAQ accordion (spec 15 — these 6 items are the policy contract and
// the copy is verbatim from the design prototype plan-usage.html).
// Multiple items can be open at once.

const FAQ_ITEMS: Array<[question: string, answer: string]> = [
  [
    "What exactly is counted as 1 AI conversation?",
    "A conversation is a single shopper session with your AI — no matter how many back-and-forth messages it contains. A new session begins after 30 minutes of inactivity.",
  ],
  [
    "What happens when I reach my monthly AI conversation limit?",
    "Your AI keeps replying — extra conversations beyond your plan are billed at $0.4 each. Upgrade anytime to raise the included allowance.",
  ],
  [
    "Does unused AI usage carry over to the next month?",
    "No. Unused conversations reset on the 1st of each month and don't roll over to the next period.",
  ],
  [
    "Can I cancel my subscription at anytime?",
    "Yes. You can cancel from this page at any time; your plan stays active until the end of the current billing period.",
  ],
  [
    "If I cancel the paid plans, will I lose the features or effects that were available in the previous plan?",
    "You keep all your data, but plan-specific features (extra conversations, exports, branding removal) pause until you resubscribe.",
  ],
  [
    "Is it easy to switch between plans?",
    "Very easy — upgrade or downgrade right here anytime. Changes apply immediately and billing is prorated by Shopify.",
  ],
];

export function PlanFaq(props: { contactHref: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());

  const toggle = (index: number) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <s-section heading="Frequently asked questions">
      <s-paragraph>
        Don&apos;t see your answer?{" "}
        <s-link href={props.contactHref} target="_blank">
          Reach out to us, we&apos;d love to help!
        </s-link>
      </s-paragraph>
      <s-stack gap="none">
        {FAQ_ITEMS.map(([question, answer], index) => {
          const isOpen = open.has(index);
          return (
            <div
              key={question}
              style={{
                borderBottom:
                  index < FAQ_ITEMS.length - 1
                    ? "1px solid var(--s-color-border, #e3e3e3)"
                    : "none",
              }}
            >
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-expanded={isOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  padding: "12px 2px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                }}
              >
                <span style={{ flex: 1, fontWeight: 600 }}>{question}</span>
                <span aria-hidden="true">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen ? (
                <div style={{ padding: "0 2px 12px" }}>
                  <s-text color="subdued">{answer}</s-text>
                </div>
              ) : null}
            </div>
          );
        })}
      </s-stack>
    </s-section>
  );
}
