import type { ShopSettingsData } from "../lib/settings/schemas";

// Settings → Chatbox tab (spec 16): availability + survey entry cards,
// cart-drawer toggle, order tracking mode.

type OrderTracking = ShopSettingsData["orderTracking"];

export function SettingsChatbox(props: {
  cartDrawer: boolean;
  orderTracking: OrderTracking;
  onCartDrawerChange: (value: boolean) => void;
  onOrderTrackingChange: (value: OrderTracking) => void;
  onManageAvailability: () => void;
  onManageSurvey: () => void;
}) {
  return (
    <s-stack gap="base">
      <s-section>
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack gap="small-300">
            <s-heading>Chat availability</s-heading>
            <s-text tone="neutral">
              Display your online status during these hours and when you are active in the inbox.
            </s-text>
          </s-stack>
          <s-button onClick={props.onManageAvailability}>Manage</s-button>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack gap="small-300">
            <s-heading>Satisfaction survey</s-heading>
            <s-text tone="neutral">Collect feedback from customers in their chat</s-text>
          </s-stack>
          <s-button onClick={props.onManageSurvey}>Manage</s-button>
        </s-stack>
      </s-section>

      <s-section>
        <s-switch
          label="Open cart drawer after add to cart"
          details="When a shopper adds a product from the chat, minimize the chat and open your theme's cart drawer. Turn off to keep shoppers in the conversation."
          checked={props.cartDrawer}
          onChange={(e) => props.onCartDrawerChange(e.currentTarget.checked)}
        />
      </s-section>

      <s-section heading="Order tracking">
        <s-paragraph>Set up how customers can track their orders via your chatbox.</s-paragraph>
        <s-choice-list
          label="Order tracking mode"
          labelAccessibilityVisibility="exclusive"
          name="order-tracking-mode"
          values={[props.orderTracking.mode]}
          onChange={(e) => {
            const mode = (e.currentTarget.values[0] ?? "default") as OrderTracking["mode"];
            props.onOrderTrackingChange({ ...props.orderTracking, mode });
          }}
        >
          <s-choice value="default">
            Default tracking
            <s-text slot="details">Direct to the shipping carrier&apos;s tracking page</s-text>
          </s-choice>
          <s-choice value="custom">
            Custom tracking
            <s-text slot="details">
              Direct to a custom tracking link for orders without tracking. Otherwise, use the
              default link
            </s-text>
          </s-choice>
        </s-choice-list>
        {props.orderTracking.mode === "custom" ? (
          <s-text-field
            label="Custom tracking URL"
            placeholder="www.delhivery.com/track-v2/package/"
            value={props.orderTracking.customUrl}
            onInput={(e) =>
              props.onOrderTrackingChange({ ...props.orderTracking, customUrl: e.currentTarget.value })
            }
          />
        ) : null}
      </s-section>
    </s-stack>
  );
}
