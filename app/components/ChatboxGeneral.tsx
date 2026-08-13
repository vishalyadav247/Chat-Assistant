import { Link } from "react-router";
import type { WidgetSettingsData } from "../lib/settings/schemas";
import { ChatboxUploadButton } from "./ChatboxUploadButton";
import { arrayMove, DragHandle, useDragReorder } from "./DragReorder";

// Chatbox → General tab (spec 06, design chatbox.html): chat focus mode,
// header (logo/name/description), Contact & Chat (status, live chat, contact
// methods with single-use add dropdown), order tracking, FAQs.

type ContactType = WidgetSettingsData["contactMethods"]["items"][number]["type"];

const CONTACT_LABELS: Record<ContactType, string> = {
  whatsapp: "WhatsApp",
  phone: "Phone call",
  email: "Email",
};
const ALL_CONTACT_TYPES: ContactType[] = ["whatsapp", "phone", "email"];

export function ChatboxGeneral(props: {
  value: WidgetSettingsData;
  onChange: (next: WidgetSettingsData) => void;
}) {
  const { value, onChange } = props;
  const methods = value.contactMethods;

  const setMethods = (items: WidgetSettingsData["contactMethods"]["items"]) =>
    onChange({
      ...value,
      contactMethods: {
        ...methods,
        items: items.map((item, index) => ({ ...item, order: index })),
      },
    });

  const usedTypes = new Set(methods.items.map((item) => item.type));
  const availableTypes = ALL_CONTACT_TYPES.filter((type) => !usedTypes.has(type));

  const addMethod = (type: ContactType) => {
    if (usedTypes.has(type)) return; // single-use per type
    setMethods([
      ...methods.items,
      { type, value: "", countryCode: type === "email" ? undefined : "+1", order: methods.items.length },
    ]);
  };

  const moveMethod = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= methods.items.length) return;
    const items = [...methods.items];
    [items[index], items[target]] = [items[target], items[index]];
    setMethods(items);
  };

  const methodDrag = useDragReorder((from, to) => setMethods(arrayMove(methods.items, from, to)));

  return (
    <s-stack gap="base">
      <s-section>
        <s-switch
          label="Chat focus mode"
          details="Quickly jump into the chat page when opening the chatbox. Active only with live chat enabled."
          checked={value.chatFocusMode}
          onChange={(e) => onChange({ ...value, chatFocusMode: e.currentTarget.checked })}
        />
      </s-section>

      <s-section heading="Chatbox header">
        <s-stack gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-thumbnail
            size="large"
            src={value.header.logoUrl ?? undefined}
            alt="Chatbox logo"
          />
          <s-stack gap="small-200">
            <ChatboxUploadButton
              intent="upload-logo"
              label="Upload logo"
              onUploaded={(url) =>
                onChange({ ...value, header: { ...value.header, logoUrl: url } })
              }
            />
            <s-text tone="neutral">PNG or JPG, up to 2MB</s-text>
          </s-stack>
        </s-stack>
        <s-text-field
          label="Name"
          value={value.header.name}
          maxLength={60}
          placeholder="ChatConvert"
          details="Shown as the chat window title. Leave blank to use ChatConvert."
          onInput={(e) => onChange({ ...value, header: { ...value.header, name: e.currentTarget.value } })}
        />
        <s-text-field
          label="Description"
          value={value.header.description}
          maxLength={120}
          details="Shown below the name in the chat window header."
          onInput={(e) =>
            onChange({ ...value, header: { ...value.header, description: e.currentTarget.value } })
          }
        />
        </s-stack>
      </s-section>

      <s-section heading="Contact & Chat">
        <s-stack gap="base">
        <s-paragraph>Manage how customers reach and chat with you</s-paragraph>
        <s-stack gap="small-300">
          <s-switch
            label="Chat status"
            checked={value.chatStatus}
            onChange={(e) => onChange({ ...value, chatStatus: e.currentTarget.checked })}
          />
          <s-paragraph>
            Set up online/offline status in{" "}
            <Link to="/app/settings#availability">working hours settings</Link>
          </s-paragraph>
        </s-stack>
        <s-divider />
        <s-switch
          label="Live chat"
          details="Enable real time conversation with your customers."
          checked={value.liveChat}
          onChange={(e) => onChange({ ...value, liveChat: e.currentTarget.checked })}
        />
        <s-divider />
        <s-switch
          label="Contact methods"
          details="Show contact methods to your store"
          checked={methods.enabled}
          onChange={(e) =>
            onChange({ ...value, contactMethods: { ...methods, enabled: e.currentTarget.checked } })
          }
        />
        {methods.items.map((method, index) => (
          // One aligned row per method: handle | fixed-width name | inputs
          // (visible field labels off — they floated mid-row and misaligned
          // everything) | delete. The value input flexes to fill the card.
          <div key={method.type} data-drag-row {...methodDrag.rowProps(index)}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
              <DragHandle
                label={`Reorder ${CONTACT_LABELS[method.type]}`}
                drag={methodDrag.handleProps(index)}
                onKeyMove={(d) => moveMethod(index, d === "up" ? -1 : 1)}
              />
              <span style={{ width: 84, flexShrink: 0, fontWeight: 600, fontSize: 13 }}>
                {CONTACT_LABELS[method.type]}
              </span>
              {method.type !== "email" ? (
                <s-box minInlineSize="90px" maxInlineSize="90px">
                  <s-text-field
                    label={`${CONTACT_LABELS[method.type]} country code`}
                    labelAccessibilityVisibility="exclusive"
                    placeholder="+1"
                    maxLength={8}
                    value={method.countryCode ?? ""}
                    onInput={(e) => {
                      const items = [...methods.items];
                      items[index] = { ...method, countryCode: e.currentTarget.value };
                      setMethods(items);
                    }}
                  />
                </s-box>
              ) : null}
              <div style={{ flex: 1, minWidth: 160 }}>
                <s-text-field
                  label={CONTACT_LABELS[method.type]}
                  labelAccessibilityVisibility="exclusive"
                  placeholder={method.type === "email" ? "support@example.com" : "555 000 0000"}
                  maxLength={200}
                  value={method.value}
                  onInput={(e) => {
                    const items = [...methods.items];
                    items[index] = { ...method, value: e.currentTarget.value };
                    setMethods(items);
                  }}
                />
              </div>
              <s-button
                icon="delete"
                variant="tertiary"
                tone="critical"
                accessibilityLabel={`Remove ${CONTACT_LABELS[method.type]}`}
                onClick={() => setMethods(methods.items.filter((_, i) => i !== index))}
              />
            </div>
          </div>
        ))}
        {availableTypes.length > 0 ? (
          <s-box maxInlineSize="220px">
            <s-select
              label="Add contact method"
              labelAccessibilityVisibility="exclusive"
              value=""
              onChange={(e) => {
                const type = e.currentTarget.value as ContactType | "";
                if (type) addMethod(type);
              }}
            >
              <s-option value="">Add contact method…</s-option>
              {availableTypes.map((type) => (
                <s-option key={type} value={type}>
                  {CONTACT_LABELS[type]}
                </s-option>
              ))}
            </s-select>
          </s-box>
        ) : null}
        </s-stack>
      </s-section>

      <s-section>
        <s-stack gap="base">
        <s-stack gap="small-300">
          <s-switch
            label="Order tracking"
            checked={value.orderTracking}
            onChange={(e) => onChange({ ...value, orderTracking: e.currentTarget.checked })}
          />
          <s-paragraph>
            Show the Order Tracking block to let customers track their orders. Select a tracking
            method in <Link to="/app/settings#chatbox">Integration settings</Link>.
          </s-paragraph>
        </s-stack>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack gap="base">
        <s-stack gap="small-300">
          <s-switch
            label="FAQs"
            checked={value.faqs}
            onChange={(e) => onChange({ ...value, faqs: e.currentTarget.checked })}
          />
          <s-paragraph>
            Show featured questions set up in <Link to="/app/ai-agent">FAQs settings</Link>.
          </s-paragraph>
        </s-stack>
        </s-stack>
      </s-section>
    </s-stack>
  );
}
