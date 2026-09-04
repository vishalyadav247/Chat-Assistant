import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { PlanPromo } from "./PlanCards";
import { IconChip } from "./ui/IconChip";

// Discount code + support cards (spec 15, design plan-usage.html).
// The code is validated by the plan page action ("validate_code"); once valid
// the plan cards preview the discounted price and the code rides along with
// the subscribe request, where Shopify applies it as the subscription discount.

type ValidateResult =
  { ok: true; promo: PlanPromo } | { ok: false; error: string; field?: string };

export function PlanDiscountCard(props: {
  applied: PlanPromo | null;
  onApplied: (promo: PlanPromo) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const fetcher = useFetcher<ValidateResult>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";

  const handled = useRef<unknown>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result)
      return;
    handled.current = result;
    if (result.ok && "promo" in result) {
      setError(null);
      setCode("");
      props.onApplied(result.promo);
    } else if (!result.ok) {
      setError(result.error);
    }
  }, [fetcher.data, fetcher.state, props]);

  const apply = () => {
    const value = code.trim();
    if (!value) {
      setError("Please enter a code.");
      return;
    }
    setError(null);
    fetcher.submit(
      { intent: "validate_code", code: value },
      { method: "post" },
    );
  };

  return (
    <s-section heading="Discount code">
      {props.applied ? (
        <s-stack gap="small">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="success">{props.applied.code}</s-badge>
            <s-text>{props.applied.label}</s-text>
          </s-stack>
          <s-text color="subdued">
            Pick a plan above — the discounted price is shown on the card and
            applied by Shopify on the approval page.
          </s-text>
          <s-stack direction="inline">
            <s-button variant="tertiary" onClick={props.onRemove}>
              Remove code
            </s-button>
          </s-stack>
        </s-stack>
      ) : (
        <>
          <s-paragraph>
            Have a code from the ChatConvert team? Apply it before choosing a
            plan.
          </s-paragraph>
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field
              label="Discount code"
              placeholder="Enter your code"
              value={code}
              error={error ?? undefined}
              disabled={props.disabled}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
            <s-button onClick={apply} loading={busy} disabled={props.disabled}>
              Apply
            </s-button>
          </s-stack>
        </>
      )}
    </s-section>
  );
}

/** We do NOT configure the app for merchants — this offers help with THEIR
 *  setup, through the support bubble SupportChat.tsx mounts bottom-right. */
export function PlanSupportCard() {
  return (
    <s-section>
      <s-stack direction="inline" gap="base" alignItems="center">
        <IconChip icon="chat" tone="info" size="large" />
        <s-stack gap="small-200">
          <s-heading>Need a hand?</s-heading>
          <s-text color="subdued">
            Not sure which plan fits, or stuck somewhere in setup? Chat with our
            support team — click the chat icon in the bottom-right corner of the
            screen.
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
