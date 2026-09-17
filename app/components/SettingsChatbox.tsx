import type { ShopSettingsData } from "../lib/settings/schemas";
import { PlanBanner } from "./ui/PlanGate";

// Settings → Chatbox tab (spec 16): availability + survey entry cards,
// cart-drawer toggle, order tracking mode.

type OrderTracking = ShopSettingsData["orderTracking"];

/** One order-tracking mode: a single-choice radio plus, when it is the chosen
 *  mode, its required details indented directly beneath it. All three share a
 *  radio-group name so they read as one group to assistive tech; `mode` (not
 *  the DOM) decides which is checked. */
function TrackingMode(props: {
  value: OrderTracking["mode"];
  mode: OrderTracking["mode"];
  label: string;
  details: string;
  onSelect: (mode: OrderTracking["mode"]) => void;
  children?: React.ReactNode;
}) {
  const selected = props.mode === props.value;
  return (
    <s-stack gap="small-300">
      <s-choice-list
        label={props.label}
        labelAccessibilityVisibility="exclusive"
        name="order-tracking-mode"
        values={selected ? [props.value] : []}
        onInput={(e) => {
          // A radio can only ever be turned ON; ignore the de-select event the
          // previously checked list fires so two clicks can't clear the group.
          if (e.currentTarget.values.includes(props.value)) props.onSelect(props.value);
        }}
      >
        <s-choice value={props.value}>
          {props.label}
          <s-text slot="details">{props.details}</s-text>
        </s-choice>
      </s-choice-list>
      {selected && props.children ? (
        <s-box paddingInlineStart="large">
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack gap="base">{props.children}</s-stack>
          </s-box>
        </s-box>
      ) : null}
    </s-stack>
  );
}

export function SettingsChatbox(props: {
  cartDrawer: boolean;
  /** Human-support waiting message — "" uses the default. */
  humanModeMessage: string;
  orderTracking: OrderTracking;
  /** Last SAVED tracking config — drives the Connected state (the editable
   *  draft may differ while the merchant types a new key). */
  savedTracking: OrderTracking;
  /** Tier that unlocks order tracking, or null when this plan has it. */
  orderTrackingPlan: string | null;
  connecting: boolean;
  onCartDrawerChange: (value: boolean) => void;
  onHumanModeMessageChange: (value: string) => void;
  onOrderTrackingChange: (value: OrderTracking) => void;
  /** Validate + persist the provider key ("" disconnects). */
  onConnect: (apiKey: string) => void;
  onManageAvailability: () => void;
  onManageSurvey: () => void;
}) {
  const connected = Boolean(props.savedTracking.apiKey);
  const keyDirty = props.orderTracking.apiKey.trim() !== props.savedTracking.apiKey;
  const select = (mode: OrderTracking["mode"]) =>
    props.onOrderTrackingChange({ ...props.orderTracking, mode });
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

      {/* Human-support mode (this tab is its home;
          the AI Agent page's off-banner links here). Saved by the page's
          normal SaveBar with the rest of the chatbox slice. */}
      <s-section heading="Human support mode">
        <s-stack gap="base">
          <s-paragraph>
            When the AI agent is deactivated, chat runs as human support: shoppers&apos;
            messages go to your Inbox and this is the first reply they see while your team is
            on the way.
          </s-paragraph>
          <s-text-area
            label="Waiting message"
            rows={3}
            maxLength={300}
            value={props.humanModeMessage}
            placeholder="Thanks for reaching out! Our team is helping other customers right now — we'll connect you with an agent shortly."
            details="Sent once per conversation. Leave blank to use the default shown above."
            onInput={(e) => props.onHumanModeMessageChange(e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-section>
        <s-switch
          label="Open cart drawer after add to cart"
          details="When a shopper adds a product from the chat, minimize the chat and open your theme's cart drawer. Turn off to keep shoppers in the conversation."
          checked={props.cartDrawer}
          onInput={(e) => props.onCartDrawerChange(e.currentTarget.checked)}
        />
      </s-section>

      {/* Order tracking. Each mode's required details are revealed directly
          under that mode (user request) — they used to sit after the whole
          list, and the integration setup in a separate card further down, so
          it was never obvious which option a field belonged to.
          s-choice-list can't host content between its options ("component
          types other than choice can't be used as options"), so each mode is
          its own single-choice list sharing one radio-group name; `mode` is
          the single source of truth for which is selected. */}
      <s-section heading="Order tracking">
        <s-stack gap="base">
          <s-paragraph>Set up how customers can track their orders via your chatbox.</s-paragraph>
          {/* Settings stay editable while locked (they are kept for after an
              upgrade); the banner says the storefront won't show tracking. */}
          <PlanBanner plan={props.orderTrackingPlan} heading="Order tracking isn't included in your plan">
            Shoppers can&apos;t track orders in the chat on your current plan. Your settings here are
            saved and apply as soon as you upgrade.
          </PlanBanner>

          <TrackingMode
            value="default"
            mode={props.orderTracking.mode}
            label="Default tracking"
            details="Direct to the shipping carrier's tracking page"
            onSelect={select}
          />

          <TrackingMode
            value="custom"
            mode={props.orderTracking.mode}
            label="Custom tracking"
            details="Direct to a custom tracking link for orders without tracking. Otherwise, use the default link"
            onSelect={select}
          >
            <s-text-field
              label="Custom tracking URL"
              maxLength={500}
              placeholder="www.delhivery.com/track-v2/package/"
              details="The tracking number is added to the end — or put {number} where it belongs in the URL."
              value={props.orderTracking.customUrl}
              onInput={(e) =>
                props.onOrderTrackingChange({
                  ...props.orderTracking,
                  customUrl: e.currentTarget.value,
                })
              }
            />
          </TrackingMode>

          <TrackingMode
            value="integration"
            mode={props.orderTracking.mode}
            label="Integrate with tracking app"
            details="Show real-time shipment status updates inside the chatbox for better customer support"
            onSelect={select}
          >
            <s-stack gap="small-300">
              <s-heading>Step 1. Select tracking provider</s-heading>
              <s-stack gap="small-300">
                <s-checkbox label="17Track" checked disabled={false} onInput={() => {}} />
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
                  props.onOrderTrackingChange({
                    ...props.orderTracking,
                    apiKey: e.currentTarget.value,
                  })
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
          </TrackingMode>
        </s-stack>
      </s-section>
    </s-stack>
  );
}
