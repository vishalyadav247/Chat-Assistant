import { useState } from "react";

// Discount code + Done-for-you cards (spec 15, design plan-usage.html).
// Discount code is cosmetic in v1: appSubscriptionCreate has no merchant-facing
// discount-code parameter (2026-07) — the field renders per design and keeps the
// code client-side. Messages are verbatim from the design.

export function PlanDiscountCard() {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "critical"; text: string } | null>(
    null,
  );

  const apply = () => {
    const value = code.trim();
    if (!value) {
      setMessage({ tone: "critical", text: "Please enter a code." });
      return;
    }
    setMessage({
      tone: "success",
      text: `Code "${value.toUpperCase()}" applied — discount will show at checkout.`,
    });
  };

  return (
    <s-section heading="Discount code">
      <s-paragraph>Apply a discount code to your subscription.</s-paragraph>
      <s-stack direction="inline" gap="small" alignItems="end">
        <s-text-field
          label="Discount code"
          placeholder="Enter your code"
          value={code}
          onInput={(e) => setCode(e.currentTarget.value)}
        />
        <s-button onClick={apply}>Apply</s-button>
      </s-stack>
      {message ? <s-text tone={message.tone}>{message.text}</s-text> : null}
    </s-section>
  );
}

export function PlanDoneForYouCard(props: { contactHref: string }) {
  return (
    <s-section>
      <s-stack gap="small">
        <s-heading>Want it set up for you?</s-heading>
        <s-text color="subdued">
          Progryss builds your curated-answer library from your real customer questions, tunes
          voice &amp; guardrails, and configures custom automations.
        </s-text>
        <s-stack direction="inline">
          <s-button href={props.contactHref} target="_blank">
            Talk to Progryss about done-for-you setup
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
