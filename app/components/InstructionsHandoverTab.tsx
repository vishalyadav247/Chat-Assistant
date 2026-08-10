import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { HandoverConfigData } from "../lib/settings/schemas";
import type { InstructionsActionResult } from "../routes/app.ai-agent.instructions";
import { SaveBar } from "./SaveBar";

// Instructions → Human handover tab (spec 08, design #viewInstructions
// handover panel). Renders EXACTLY the handoverConfigSchema shape
// (app/lib/settings/schemas.ts — frozen): triggers + intentRules +
// destination (inbox / collect_email / contact_methods) with nested config.
// Runtime consumption is feature 10 — this tab persists config only.

type LeaveMessageData = HandoverConfigData["inbox"]["leaveMessage"];

const REPLY_TIMES: { value: LeaveMessageData["replyTime"]; label: string }[] = [
  { value: "24h", label: "Within 24 hours" },
  { value: "12h", label: "Within 12 hours" },
  { value: "48h", label: "Within 48 hours" },
  { value: "same_day", label: "Same day" },
];

function Counter(props: { value: string; max: number }) {
  return (
    <div style={{ textAlign: "right" }}>
      <s-text tone="neutral">
        {props.value.length}/{props.max}
      </s-text>
    </div>
  );
}

function RadioRow(props: {
  name: string;
  checked: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--s-color-border, #e3e3e3)",
        borderRadius: 12,
        padding: "12px 14px",
      }}
    >
      <label style={{ display: "flex", gap: 10, cursor: "pointer", alignItems: "flex-start" }}>
        <input
          type="radio"
          name={props.name}
          checked={props.checked}
          onChange={props.onSelect}
          style={{ marginTop: 3 }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>{props.title}</span>
          {props.description ? (
            <s-text tone="neutral">{props.description}</s-text>
          ) : null}
        </span>
      </label>
      {props.checked && props.children ? (
        <div style={{ marginTop: 12, paddingLeft: 24 }}>{props.children}</div>
      ) : null}
    </div>
  );
}

function LeaveMessageForm(props: {
  value: LeaveMessageData;
  onChange: (next: LeaveMessageData) => void;
}) {
  const { value, onChange } = props;
  const collect = value.collect;
  return (
    <s-stack gap="small">
      <s-select
        label="When customers can expect a reply"
        value={value.replyTime}
        onChange={(e) =>
          onChange({ ...value, replyTime: e.currentTarget.value as LeaveMessageData["replyTime"] })
        }
      >
        {REPLY_TIMES.map((rt) => (
          <s-option key={rt.value} value={rt.value}>
            {rt.label}
          </s-option>
        ))}
      </s-select>

      <s-text>Information collected from customer</s-text>
      <s-checkbox label="Email" checked disabled />
      <s-checkbox label="Issue description" checked disabled />
      <s-checkbox
        label="Order number"
        checked={collect.orderNumber}
        onChange={(e) =>
          onChange({ ...value, collect: { ...collect, orderNumber: e.currentTarget.checked } })
        }
      />
      <s-checkbox
        label="Phone number"
        checked={collect.phone}
        onChange={(e) =>
          onChange({ ...value, collect: { ...collect, phone: e.currentTarget.checked } })
        }
      />
      <s-checkbox
        label="Photo upload"
        checked={collect.photoUpload}
        onChange={(e) =>
          onChange({ ...value, collect: { ...collect, photoUpload: e.currentTarget.checked } })
        }
      />
      <s-text tone="neutral">Email and issue description are required and always collected.</s-text>

      <s-text-area
        label="Message shown with the form"
        rows={3}
        maxLength={300}
        value={value.formMessage}
        onInput={(e) => onChange({ ...value, formMessage: e.currentTarget.value })}
      />
      <Counter value={value.formMessage} max={300} />
      <s-text tone="neutral">The expected reply time above is appended automatically.</s-text>

      <s-text-area
        label="Message shown after the form is submitted"
        rows={3}
        maxLength={300}
        value={value.postSubmitMessage}
        onInput={(e) => onChange({ ...value, postSubmitMessage: e.currentTarget.value })}
      />
      <Counter value={value.postSubmitMessage} max={300} />
    </s-stack>
  );
}

export function InstructionsHandoverTab(props: { initial: HandoverConfigData }) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<InstructionsActionResult>();
  const [saved, setSaved] = useState<HandoverConfigData>(props.initial);
  const [config, setConfig] = useState<HandoverConfigData>(props.initial);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [ruleTopic, setRuleTopic] = useState("");

  const dirty = JSON.stringify(config) !== JSON.stringify(saved);
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.intent !== "save-handover") return;
    if (fetcher.data.ok) {
      shopify.toast.show("Handover settings saved");
      setSaved(config);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const save = () =>
    fetcher.submit(
      { intent: "save-handover", payload: JSON.stringify(config) },
      { method: "post" },
    );
  const discard = () => setConfig(saved);

  const triggers = config.triggers;
  const setTriggers = (next: HandoverConfigData["triggers"]) =>
    setConfig((prev) => ({ ...prev, triggers: next }));
  const inbox = config.inbox;
  const setInbox = (next: HandoverConfigData["inbox"]) =>
    setConfig((prev) => ({ ...prev, inbox: next }));

  const addRule = () => {
    const topic = ruleTopic.trim().slice(0, 150);
    if (!topic) return;
    setConfig((prev) => ({ ...prev, intentRules: [...prev.intentRules, { topic }] }));
    setRuleTopic("");
    setRuleFormOpen(false);
  };

  return (
    <s-stack gap="base">
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />

      <s-heading>When should AI hand off to your team?</s-heading>

      <s-section heading="Auto triggers">
        <s-paragraph>AI detects customer behavior and transfers automatically</s-paragraph>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>
              Customer asks to talk to a person{" "}
            </span>
            <s-badge tone="success">Always on</s-badge>
            <span style={{ display: "block" }}>
              <s-text tone="neutral">
                AI detects intent: &quot;talk to human&quot;, &quot;speak to agent&quot;, &quot;real person&quot;
              </s-text>
            </span>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <s-switch
              label="AI cannot answer"
              details={`Auto hand-off after ${triggers.cannotAnswer.threshold} consecutive low-confidence responses`}
              checked={triggers.cannotAnswer.enabled}
              onChange={(e) =>
                setTriggers({
                  ...triggers,
                  cannotAnswer: { ...triggers.cannotAnswer, enabled: e.currentTarget.checked },
                })
              }
            />
          </span>
          {triggers.cannotAnswer.enabled ? (
            <s-select
              label="Low-confidence threshold"
              labelAccessibilityVisibility="exclusive"
              value={String(triggers.cannotAnswer.threshold)}
              onChange={(e) =>
                setTriggers({
                  ...triggers,
                  cannotAnswer: {
                    ...triggers.cannotAnswer,
                    threshold: Number(e.currentTarget.value),
                  },
                })
              }
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <s-option key={n} value={String(n)}>
                  {n} in a row
                </s-option>
              ))}
            </s-select>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <s-switch
              label="Customer repeats question"
              details={`Auto hand-off when the same question is asked ${triggers.repeatedQuestion.threshold}+ times`}
              checked={triggers.repeatedQuestion.enabled}
              onChange={(e) =>
                setTriggers({
                  ...triggers,
                  repeatedQuestion: {
                    ...triggers.repeatedQuestion,
                    enabled: e.currentTarget.checked,
                  },
                })
              }
            />
          </span>
          {triggers.repeatedQuestion.enabled ? (
            <s-select
              label="Repeat threshold"
              labelAccessibilityVisibility="exclusive"
              value={String(triggers.repeatedQuestion.threshold)}
              onChange={(e) =>
                setTriggers({
                  ...triggers,
                  repeatedQuestion: {
                    ...triggers.repeatedQuestion,
                    threshold: Number(e.currentTarget.value),
                  },
                })
              }
            >
              {[2, 3, 4, 5].map((n) => (
                <s-option key={n} value={String(n)}>
                  {n}+ times
                </s-option>
              ))}
            </s-select>
          ) : null}
        </div>

        <s-switch
          label="Negative sentiment"
          details="Auto hand-off on frustration or anger — wording, ALL CAPS, repeated punctuation, negative emojis (👎 😠 💩), or 2+ thumb-down reactions on AI replies"
          checked={triggers.negativeSentiment.enabled}
          onChange={(e) =>
            setTriggers({ ...triggers, negativeSentiment: { enabled: e.currentTarget.checked } })
          }
        />
      </s-section>

      <s-section heading="Intent rules">
        <s-paragraph>
          You define topics — AI semantically matches and transfers immediately, no AI response
          first
        </s-paragraph>
        {config.intentRules.length > 0 ? (
          <s-stack gap="small">
            {config.intentRules.map((rule, index) => (
              <div
                // eslint-disable-next-line react/no-array-index-key
                key={`${rule.topic}-${index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 0",
                  borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{rule.topic}</span>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel={`Delete rule ${rule.topic}`}
                  onClick={() =>
                    setConfig((prev) => ({
                      ...prev,
                      intentRules: prev.intentRules.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Delete
                </s-button>
              </div>
            ))}
          </s-stack>
        ) : null}
        {ruleFormOpen ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-heading>Add handover rule</s-heading>
              <s-text-field
                label="Topic name"
                value={ruleTopic}
                maxLength={150}
                placeholder="e.g. Wholesale inquiry, Custom order, Partnership…"
                onInput={(e) => setRuleTopic(e.currentTarget.value)}
              />
              <Counter value={ruleTopic} max={150} />
              <s-text tone="neutral">
                AI semantically matches this topic — covers keyword variations. Avoid after-sales
                topics, already handled separately.
              </s-text>
              <div style={{ display: "flex", gap: 8 }}>
                <s-button variant="primary" disabled={!ruleTopic.trim()} onClick={addRule}>
                  Add rule
                </s-button>
                <s-button
                  onClick={() => {
                    setRuleFormOpen(false);
                    setRuleTopic("");
                  }}
                >
                  Cancel
                </s-button>
              </div>
            </s-stack>
          </s-box>
        ) : (
          <div>
            <s-button onClick={() => setRuleFormOpen(true)}>Add rule</s-button>
          </div>
        )}
      </s-section>

      <s-heading>Where does the customer go?</s-heading>

      <s-section>
        <s-stack gap="small">
          <RadioRow
            name="handover-destination"
            checked={config.destination === "inbox"}
            title={
              <>
                Transfer to human in ChatConvert inbox <s-badge tone="info">Recommended</s-badge>
              </>
            }
            description="Agent joins the chat directly — the customer stays in the same window, no friction."
            onSelect={() => setConfig((prev) => ({ ...prev, destination: "inbox" }))}
          >
            <s-stack gap="small">
              <s-text tone="neutral">
                Working hours are configured in Settings → Chat availability.
              </s-text>

              <s-heading>Messages while your team is online</s-heading>
              <s-text-area
                label="Ask before connecting"
                rows={3}
                maxLength={300}
                value={inbox.onlineAskMessage}
                onInput={(e) => setInbox({ ...inbox, onlineAskMessage: e.currentTarget.value })}
              />
              <Counter value={inbox.onlineAskMessage} max={300} />
              <s-text tone="neutral">
                AI asks the customer to confirm before handing the chat to your team.
              </s-text>
              <s-text-area
                label="After the chat is handed over"
                rows={3}
                maxLength={300}
                value={inbox.afterHandoverMessage}
                onInput={(e) => setInbox({ ...inbox, afterHandoverMessage: e.currentTarget.value })}
              />
              <Counter value={inbox.afterHandoverMessage} max={300} />
              <s-text tone="neutral">
                Sent once the customer confirms and the chat moves to your inbox.
              </s-text>

              <s-heading>When your team is offline, show customers</s-heading>
              <RadioRow
                name="inbox-offline-mode"
                checked={inbox.offlineMode === "leave_message"}
                title="Leave a message — we'll follow up"
                onSelect={() => setInbox({ ...inbox, offlineMode: "leave_message" })}
              >
                <LeaveMessageForm
                  value={inbox.leaveMessage}
                  onChange={(leaveMessage) => setInbox({ ...inbox, leaveMessage })}
                />
              </RadioRow>
              <RadioRow
                name="inbox-offline-mode"
                checked={inbox.offlineMode === "contact_methods"}
                title="Show contact methods"
                description="AI shows the contact methods configured in your Chatbox settings so the customer can reach out while your team is back."
                onSelect={() => setInbox({ ...inbox, offlineMode: "contact_methods" })}
              />

              <s-heading>While the customer waits for your team, let AI keep replying</s-heading>
              <RadioRow
                name="inbox-ai-waiting"
                checked={inbox.aiWhileWaiting === "never"}
                title="Don't allow"
                description="AI stops replying once the customer is waiting for an agent."
                onSelect={() => setInbox({ ...inbox, aiWhileWaiting: "never" })}
              />
              <RadioRow
                name="inbox-ai-waiting"
                checked={inbox.aiWhileWaiting === "outside_hours"}
                title="Allow only outside business hours"
                description="AI keeps handling the conversation instead of handing off."
                onSelect={() => setInbox({ ...inbox, aiWhileWaiting: "outside_hours" })}
              />
              <RadioRow
                name="inbox-ai-waiting"
                checked={inbox.aiWhileWaiting === "always"}
                title="Allow all the time"
                description="AI keeps replying while the customer waits — even during business hours."
                onSelect={() => setInbox({ ...inbox, aiWhileWaiting: "always" })}
              />
            </s-stack>
          </RadioRow>

          <RadioRow
            name="handover-destination"
            checked={config.destination === "collect_email"}
            title="Collect info & follow up by email"
            description="No live agents needed — AI collects customer details and sends a summary to your team email"
            onSelect={() => setConfig((prev) => ({ ...prev, destination: "collect_email" }))}
          >
            <LeaveMessageForm
              value={config.collectEmail}
              onChange={(collectEmail) => setConfig((prev) => ({ ...prev, collectEmail }))}
            />
          </RadioRow>

          <RadioRow
            name="handover-destination"
            checked={config.destination === "contact_methods"}
            title="Show contact methods"
            description="AI shows the contact methods configured in your Chatbox settings (phone, WhatsApp, email) and lets the customer pick how to reach out."
            onSelect={() => setConfig((prev) => ({ ...prev, destination: "contact_methods" }))}
          >
            <s-stack gap="small">
              <s-text-area
                label="Message shown with the contact methods"
                rows={4}
                maxLength={300}
                value={config.contactMethods.message}
                onInput={(e) => {
                  const message = e.currentTarget.value;
                  setConfig((prev) => ({
                    ...prev,
                    contactMethods: { message },
                  }));
                }}
              />
              <Counter value={config.contactMethods.message} max={300} />
              <s-text tone="neutral">
                You can include a link, for example to your contact page. The same message is used
                when your team is offline and the fallback is Show contact methods.
              </s-text>
            </s-stack>
          </RadioRow>
        </s-stack>
      </s-section>
    </s-stack>
  );
}
