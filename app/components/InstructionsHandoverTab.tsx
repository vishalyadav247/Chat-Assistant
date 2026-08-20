import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
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
    <s-stack direction="inline" justifyContent="end">
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {props.value.length}/{props.max}
      </s-text>
    </s-stack>
  );
}

function LeaveMessageForm(props: {
  value: LeaveMessageData;
  onChange: (next: LeaveMessageData) => void;
}) {
  const { value, onChange } = props;
  const collect = value.collect;
  return (
    <s-stack gap="base">
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

      <s-stack gap="small-300">
        <s-text type="strong">Information collected from customer</s-text>
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
        <s-text color="subdued">Email and issue description are required and always collected.</s-text>
      </s-stack>

      <s-text-area
        label="Message shown with the form"
        rows={3}
        maxLength={300}
        value={value.formMessage}
        details="The expected reply time above is appended automatically."
        onInput={(e) => onChange({ ...value, formMessage: e.currentTarget.value })}
      />
      <Counter value={value.formMessage} max={300} />

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

      <s-section heading="Auto triggers">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            When should the AI hand off to your team? It detects these signals and transfers
            automatically.
          </s-paragraph>

          <TriggerRow
            title="Customer asks to talk to a person"
            badge={<s-badge tone="success">Always on</s-badge>}
            description='AI detects intent: "talk to a human", "speak to an agent", "real person".'
          />
          <s-divider />
          <TriggerRow
            control={
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
            }
            accessory={
              triggers.cannotAnswer.enabled ? (
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
              ) : null
            }
          />
          <s-divider />
          <TriggerRow
            control={
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
            }
            accessory={
              triggers.repeatedQuestion.enabled ? (
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
              ) : null
            }
          />
          <s-divider />
          <TriggerRow
            control={
              <s-switch
                label="Negative sentiment"
                details="Auto hand-off on frustration or anger — wording, ALL CAPS, repeated punctuation, negative emojis (👎 😠 💩), or 2+ thumb-down reactions on AI replies"
                checked={triggers.negativeSentiment.enabled}
                onChange={(e) =>
                  setTriggers({
                    ...triggers,
                    negativeSentiment: { enabled: e.currentTarget.checked },
                  })
                }
              />
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Intent rules">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            You define topics — the AI semantically matches them and transfers immediately, with no
            AI response first.
          </s-paragraph>
          {config.intentRules.length > 0 ? (
            <s-stack gap="small-200">
              {config.intentRules.map((rule, index) => (
                // eslint-disable-next-line react/no-array-index-key
                <s-stack key={`${rule.topic}-${index}`} gap="small-200">
                  <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-icon type="target" size="small" tone="neutral" />
                      <s-text>{rule.topic}</s-text>
                    </s-stack>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      icon="delete"
                      accessibilityLabel={`Delete rule ${rule.topic}`}
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          intentRules: prev.intentRules.filter((_, i) => i !== index),
                        }))
                      }
                    />
                  </s-grid>
                  <s-divider />
                </s-stack>
              ))}
            </s-stack>
          ) : (
            <s-text color="subdued">No rules yet — add topics like &ldquo;wholesale inquiry&rdquo; or &ldquo;partnership&rdquo;.</s-text>
          )}
          {ruleFormOpen ? (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack gap="base">
                <s-heading>Add handover rule</s-heading>
                <s-text-field
                  label="Topic name"
                  value={ruleTopic}
                  maxLength={150}
                  placeholder="e.g. Wholesale inquiry, Custom order, Partnership…"
                  details="The AI matches this topic by meaning, so keyword variations are covered. Avoid after-sales topics — those are handled separately."
                  onInput={(e) => setRuleTopic(e.currentTarget.value)}
                />
                <Counter value={ruleTopic} max={150} />
                <s-stack direction="inline" gap="small-200" alignItems="center">
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
                </s-stack>
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="inline">
              <s-button icon="plus" onClick={() => setRuleFormOpen(true)}>
                Add rule
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Where does the customer go?">
        <s-stack gap="base">
          <s-choice-list
            label="Handover destination"
            labelAccessibilityVisibility="exclusive"
            name="handover-destination"
            values={[config.destination]}
            onChange={(e) => {
              const destination = (e.currentTarget.values[0] ??
                "inbox") as HandoverConfigData["destination"];
              setConfig((prev) => ({ ...prev, destination }));
            }}
          >
            <s-choice value="inbox">
              Transfer to a human in the ChatConvert inbox
              <s-text slot="details">
                Recommended — an agent joins the chat directly; the customer stays in the same
                window, no friction.
              </s-text>
            </s-choice>
            <s-choice value="collect_email">
              Collect info &amp; follow up by email
              <s-text slot="details">
                No live agents needed — the AI collects customer details and sends a summary to your
                team email.
              </s-text>
            </s-choice>
            <s-choice value="contact_methods">
              Show contact methods
              <s-text slot="details">
                The AI shows the contact methods configured in your Chatbox settings (phone,
                WhatsApp, email) and lets the customer pick how to reach out.
              </s-text>
            </s-choice>
          </s-choice-list>

          {config.destination === "inbox" ? (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack gap="base">
                <s-stack gap="small-200">
                  <s-heading>Messages while your team is online</s-heading>
                  <s-text color="subdued">
                    Working hours are configured in Settings → Chat availability.
                  </s-text>
                </s-stack>
                <s-text-area
                  label="Ask before connecting"
                  rows={3}
                  maxLength={300}
                  value={inbox.onlineAskMessage}
                  details="The AI asks the customer to confirm before handing the chat to your team."
                  onInput={(e) => setInbox({ ...inbox, onlineAskMessage: e.currentTarget.value })}
                />
                <Counter value={inbox.onlineAskMessage} max={300} />
                <s-text-area
                  label="After the chat is handed over"
                  rows={3}
                  maxLength={300}
                  value={inbox.afterHandoverMessage}
                  details="Sent once the customer confirms and the chat moves to your inbox."
                  onInput={(e) => setInbox({ ...inbox, afterHandoverMessage: e.currentTarget.value })}
                />
                <Counter value={inbox.afterHandoverMessage} max={300} />

                <s-divider />

                <s-choice-list
                  label="When your team is offline, show customers"
                  name="inbox-offline-mode"
                  values={[inbox.offlineMode]}
                  onChange={(e) => {
                    const offlineMode = (e.currentTarget.values[0] ??
                      "leave_message") as HandoverConfigData["inbox"]["offlineMode"];
                    setInbox({ ...inbox, offlineMode });
                  }}
                >
                  <s-choice value="leave_message">Leave a message — we&apos;ll follow up</s-choice>
                  <s-choice value="contact_methods">
                    Show contact methods
                    <s-text slot="details">
                      The contact methods configured in your Chatbox settings, so the customer can
                      reach out until your team is back.
                    </s-text>
                  </s-choice>
                </s-choice-list>
                {inbox.offlineMode === "leave_message" ? (
                  <s-box padding="base" borderWidth="base" borderRadius="base" background="base">
                    <LeaveMessageForm
                      value={inbox.leaveMessage}
                      onChange={(leaveMessage) => setInbox({ ...inbox, leaveMessage })}
                    />
                  </s-box>
                ) : null}

                <s-divider />

                <s-choice-list
                  label="While the customer waits for your team, let the AI keep replying"
                  name="inbox-ai-waiting"
                  values={[inbox.aiWhileWaiting]}
                  onChange={(e) => {
                    const aiWhileWaiting = (e.currentTarget.values[0] ??
                      "always") as HandoverConfigData["inbox"]["aiWhileWaiting"];
                    setInbox({ ...inbox, aiWhileWaiting });
                  }}
                >
                  <s-choice value="always">
                    Allow all the time
                    <s-text slot="details">
                      The AI keeps replying while the customer waits — even during business hours.
                      A reply from your team takes over the conversation.
                    </s-text>
                  </s-choice>
                  <s-choice value="outside_hours">
                    Allow only outside business hours
                    <s-text slot="details">
                      During business hours the AI stays quiet once the customer is waiting for an
                      agent.
                    </s-text>
                  </s-choice>
                  <s-choice value="never">
                    Don&apos;t allow
                    <s-text slot="details">
                      The AI stops replying as soon as the customer is waiting for an agent.
                    </s-text>
                  </s-choice>
                </s-choice-list>
              </s-stack>
            </s-box>
          ) : null}

          {config.destination === "collect_email" ? (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <LeaveMessageForm
                value={config.collectEmail}
                onChange={(collectEmail) => setConfig((prev) => ({ ...prev, collectEmail }))}
              />
            </s-box>
          ) : null}

          {config.destination === "contact_methods" ? (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack gap="small-200">
                <s-text-area
                  label="Message shown with the contact methods"
                  rows={4}
                  maxLength={300}
                  value={config.contactMethods.message}
                  details="You can include a link, for example to your contact page. The same message is used when your team is offline and the fallback is Show contact methods."
                  onInput={(e) => {
                    const message = e.currentTarget.value;
                    setConfig((prev) => ({
                      ...prev,
                      contactMethods: { message },
                    }));
                  }}
                />
                <Counter value={config.contactMethods.message} max={300} />
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-section>
    </s-stack>
  );
}

/** One auto-trigger row: [switch or title+badge+description] … [optional accessory control]. */
function TriggerRow(props: {
  control?: React.ReactNode;
  title?: string;
  badge?: React.ReactNode;
  description?: string;
  accessory?: React.ReactNode;
}) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
      {props.control ?? (
        <s-stack gap="small-500">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{props.title}</s-text>
            {props.badge}
          </s-stack>
          {props.description ? <s-text color="subdued">{props.description}</s-text> : null}
        </s-stack>
      )}
      {props.accessory ?? <span />}
    </s-grid>
  );
}
