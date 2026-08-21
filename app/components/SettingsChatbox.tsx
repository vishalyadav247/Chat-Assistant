import type { ShopSettingsData } from "../lib/settings/schemas";

// Settings → Chatbox tab (spec 16): availability + survey entry cards,
// cart-drawer toggle, order tracking mode.

type OrderTracking = ShopSettingsData["orderTracking"];

export function SettingsChatbox(props: {
  cartDrawer: boolean;
  orderTracking: OrderTracking;
  /** Last SAVED tracking config — drives the Connected state (the editable
   *  draft may differ while the merchant types a new key). */
  savedTracking: OrderTracking;
  connecting: boolean;
  onCartDrawerChange: (value: boolean) => void;
  onOrderTrackingChange: (value: OrderTracking) => void;
  /** Validate + persist the provider key ("" disconnects). */
  onConnect: (apiKey: string) => void;
  onManageAvailability: () => void;
  onManageSurvey: () => void;
}) {
  const connected = Boolean(props.savedTracking.apiKey);
  const keyDirty = props.orderTracking.apiKey.trim() !== props.savedTracking.apiKey;
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
          <s-choice value="integration">
            Integrate with tracking app
            <s-text slot="details">
              Show real-time shipment status updates inside the chatbox for better customer support
            </s-text>
          </s-choice>
        </s-choice-list>
        {props.orderTracking.mode === "custom" ? (
          <s-text-field
            label="Custom tracking URL"
            maxLength={500}
            placeholder="www.delhivery.com/track-v2/package/"
            details="The tracking number is added to the end — or put {number} where it belongs in the URL."
            value={props.orderTracking.customUrl}
            onInput={(e) =>
              props.onOrderTrackingChange({ ...props.orderTracking, customUrl: e.currentTarget.value })
            }
          />
        ) : null}
      </s-section>

      {props.orderTracking.mode === "integration" ? (
        <s-section heading="Set up order tracking integration app">
          <s-stack gap="base">
            <s-stack gap="small-300">
              <s-heading>Step 1. Select tracking provider</s-heading>
              <s-stack gap="small-300">
                <s-checkbox label="17Track" checked disabled={false} onChange={() => {}} />
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-checkbox label="TrackingMore" checked={false} disabled onChange={() => {}} />
                  <s-badge tone="neutral">Coming soon</s-badge>
                </s-stack>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-checkbox label="Track123" checked={false} disabled onChange={() => {}} />
                  <s-badge tone="neutral">Coming soon</s-badge>
                </s-stack>
              </s-stack>
            </s-stack>

            <s-stack gap="small-300">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-heading>Step 2. Set up integrations</s-heading>
                {connected ? <s-badge tone="success">Connected</s-badge> : null}
              </s-stack>
              <s-paragraph>Enter your API key here to enable the integration</s-paragraph>
              <s-text-field
                label="API key"
                placeholder="Your 17Track security key"
                value={props.orderTracking.apiKey}
                onInput={(e) =>
                  props.onOrderTrackingChange({ ...props.orderTracking, apiKey: e.currentTarget.value })
                }
              />
              <s-paragraph>
                Don&apos;t have your API key?{" "}
                <s-link href="https://api.17track.net/en/admin/settings" target="_blank">
                  Learn how to find it
                </s-link>
              </s-paragraph>
              <s-stack direction="inline" gap="small">
                <s-button
                  variant="primary"
                  disabled={!props.orderTracking.apiKey.trim() || !keyDirty || props.connecting}
                  loading={props.connecting}
                  onClick={() => props.onConnect(props.orderTracking.apiKey.trim())}
                >
                  Connect
                </s-button>
                {connected ? (
                  <s-button
                    tone="critical"
                    disabled={props.connecting}
                    onClick={() => props.onConnect("")}
                  >
                    Disconnect
                  </s-button>
                ) : null}
              </s-stack>
            </s-stack>
          </s-stack>
        </s-section>
      ) : null}
    </s-stack>
  );
}
