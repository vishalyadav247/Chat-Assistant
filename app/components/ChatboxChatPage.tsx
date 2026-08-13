import { useState } from "react";
import { Link } from "react-router";
import type { WidgetSettingsData } from "../lib/settings/schemas";
import { arrayMove, DragHandle, useDragReorder } from "./DragReorder";

// Chatbox → Chat page tab (spec 06): welcome/offline message, conversation
// starters (add/edit modal, reorder, delete), chat avatar, pre-chat form,
// satisfaction survey toggle.

type Starter = WidgetSettingsData["starters"]["items"][number];
type PrechatField = WidgetSettingsData["prechat"]["fields"][number];

const MODAL_ID = "chatbox-starter-modal";

interface ModalEl extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}

const modalEl = () => document.getElementById(MODAL_ID) as ModalEl | null;

/** v1 plain-text answer editor (rich text deferred): newlines ↔ <br>. */
const textToHtml = (text: string) => text.replace(/\n/g, "<br>");
const htmlToText = (html: string) =>
  html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");

interface StarterDraft {
  index: number | null; // null = adding
  emoji: string;
  question: string;
  answer: string;
}

const FIELD_LABELS: Record<PrechatField["key"], string> = {
  email: "Email address",
  name: "Name",
  phone: "Phone number",
};

export function ChatboxChatPage(props: {
  value: WidgetSettingsData;
  onChange: (next: WidgetSettingsData) => void;
}) {
  const { value, onChange } = props;
  const starters = value.starters;
  const prechat = value.prechat;
  const [modal, setModal] = useState<StarterDraft>({ index: null, emoji: "💬", question: "", answer: "" });

  const setStarters = (items: Starter[]) =>
    onChange({
      ...value,
      starters: { ...starters, items: items.map((item, index) => ({ ...item, order: index })) },
    });

  const openModal = (index: number | null) => {
    if (index === null) {
      setModal({ index: null, emoji: "💬", question: "", answer: "" });
    } else {
      const item = starters.items[index];
      setModal({
        index,
        emoji: item.emoji,
        question: item.question,
        answer: htmlToText(item.answerHtml),
      });
    }
    modalEl()?.showOverlay();
  };

  const saveModal = () => {
    if (!modal.question.trim()) return;
    const next: Starter = {
      id:
        modal.index !== null
          ? starters.items[modal.index].id
          : `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      emoji: modal.emoji || "💬",
      question: modal.question.slice(0, 100),
      answerHtml: textToHtml(modal.answer).slice(0, 5000),
      order: modal.index !== null ? starters.items[modal.index].order : starters.items.length,
    };
    const items = [...starters.items];
    if (modal.index !== null) items[modal.index] = next;
    else items.push(next);
    setStarters(items);
    modalEl()?.hideOverlay();
  };

  const moveStarter = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= starters.items.length) return;
    const items = [...starters.items];
    [items[index], items[target]] = [items[target], items[index]];
    setStarters(items);
  };

  const starterDrag = useDragReorder((from, to) =>
    setStarters(arrayMove(starters.items, from, to)),
  );

  const setPrechat = (next: Partial<WidgetSettingsData["prechat"]>) =>
    onChange({ ...value, prechat: { ...prechat, ...next } });

  const usedFieldKeys = new Set(prechat.fields.map((field) => field.key));
  const showCollect = prechat.mode === "guest" || prechat.mode === "both";

  return (
    <s-stack gap="base">
      <s-section heading="Welcome message">
        <s-stack gap="base">
        <s-paragraph>Send the welcome message when visitors initiate the chat</s-paragraph>
        <s-stack gap="small-300">
          <s-text-area
            label="Message"
            rows={3}
            value={value.welcomeMessage}
            maxLength={500}
            onInput={(e) => onChange({ ...value, welcomeMessage: e.currentTarget.value })}
          />
          <s-stack direction="inline">
            <s-button
              variant="tertiary"
              onClick={() => {
                const next = `${value.welcomeMessage}{{customer_name}}`;
                if (next.length <= 500) onChange({ ...value, welcomeMessage: next });
              }}
            >
              Insert customer name
            </s-button>
          </s-stack>
        </s-stack>
        <s-checkbox
          label="Use different offline message"
          checked={value.offlineMessageEnabled}
          onChange={(e) => onChange({ ...value, offlineMessageEnabled: e.currentTarget.checked })}
        />
        {value.offlineMessageEnabled ? (
          <s-text-area
            label="Offline message"
            rows={3}
            value={value.offlineMessage}
            maxLength={500}
            onInput={(e) => onChange({ ...value, offlineMessage: e.currentTarget.value })}
          />
        ) : null}
        </s-stack>
      </s-section>

      {/* Same shape as the Order tracking / FAQs cards: the switch carries the
          visible title (no separate section heading — a bare unlabeled toggle
          under a heading read as broken). */}
      <s-section>
        <s-stack gap="base">
        <s-switch
          label="Conversation starter"
          details="Provide instant answers to customer's questions based on your FAQs"
          checked={starters.enabled}
          onChange={(e) =>
            onChange({ ...value, starters: { ...starters, enabled: e.currentTarget.checked } })
          }
        />
        {/* Question-only rows with light dividers (user request 2026-08-13);
            the answer stays behind the edit modal. One wrapper div so the
            section s-stack gap doesn't spread the rows apart. */}
        <div>
          {starters.items.map((item, index) => (
            <div key={item.id || index} data-drag-row {...starterDrag.rowProps(index)}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                  borderTop: index > 0 ? "1px solid var(--p-color-border, #e9e9ec)" : "none",
                }}
              >
                <DragHandle
                  label={`Reorder ${item.question || "question"}`}
                  drag={starterDrag.handleProps(index)}
                  onKeyMove={(d) => moveStarter(index, d === "up" ? -1 : 1)}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <s-text type="strong">{item.question}</s-text>
                </div>
                <s-button
                  icon="edit"
                  variant="tertiary"
                  accessibilityLabel="Edit question"
                  onClick={() => openModal(index)}
                />
                <s-button
                  icon="delete"
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel="Delete question"
                  onClick={() => setStarters(starters.items.filter((_, i) => i !== index))}
                />
              </div>
            </div>
          ))}
        </div>
        <s-stack direction="inline" gap="base">
          <s-button icon="plus" onClick={() => openModal(null)}>
            Add question
          </s-button>
        </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Chat avatar">
        <s-stack gap="base">
        <s-stack gap="small-300">
          <s-choice-list
            label="Chat avatar"
            labelAccessibilityVisibility="exclusive"
            name="chat-avatar"
            values={[value.avatarMode]}
            onChange={(e) => {
              const avatarMode = (e.currentTarget.values[0] ?? "store_branding") as
                | "store_branding"
                | "team_member";
              onChange({ ...value, avatarMode });
            }}
          >
            <s-choice value="store_branding">Store branding</s-choice>
            <s-choice value="team_member" disabled>
              Team member profile (coming soon)
            </s-choice>
          </s-choice-list>
          <s-paragraph>
            Show your store logo and name in customer chats.{" "}
            <Link to="/app/settings#general">Edit store logo</Link>
          </s-paragraph>
        </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Pre-chat form">
        <s-stack gap="base">
        <s-paragraph>Collect leads from customers</s-paragraph>
        <s-choice-list
          label="How customers start a chat"
          name="prechat-mode"
          values={[prechat.mode]}
          onChange={(e) => {
            const mode = (e.currentTarget.values[0] ?? "both") as "guest" | "anonymous" | "both";
            setPrechat({ mode });
          }}
        >
          <s-choice value="guest">
            Chat as guest
            <s-text slot="details">Require information before chat</s-text>
          </s-choice>
          <s-choice value="anonymous">
            Chat as anonymous
            <s-text slot="details">No information required</s-text>
          </s-choice>
          <s-choice value="both">
            Show both options
            <s-text slot="details">Let customers choose to provide information or not</s-text>
          </s-choice>
        </s-choice-list>

        {prechat.mode === "both" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <s-text>Show form after X messages from visitors</s-text>
            <s-box maxInlineSize="90px">
              <s-number-field
                label="Show form after X messages from visitors"
                labelAccessibilityVisibility="exclusive"
                min={0}
                max={20}
                value={String(prechat.showAfterMessages)}
                onChange={(e) => {
                  const n = Math.min(
                    20,
                    Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)),
                  );
                  setPrechat({ showAfterMessages: n });
                }}
              />
            </s-box>
          </div>
        ) : null}

        {showCollect ? (
          <>
            <s-text-field
              label="Description"
              value={prechat.description}
              maxLength={300}
              details="Description helps to convey the purpose of collecting user information"
              onInput={(e) => setPrechat({ description: e.currentTarget.value })}
            />
            {/* Checkboxes (user request 2026-08-12 — replaces the add/remove
                dropdown): tick a field to collect it. Email is always on. */}
            <s-stack gap="small">
              <s-text type="strong">Information to be collected</s-text>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <s-checkbox label="Email address" checked disabled />
                <s-badge tone="info">Always required</s-badge>
              </div>
              {(["name", "phone"] as const).map((key) => (
                <s-checkbox
                  key={key}
                  label={FIELD_LABELS[key]}
                  checked={usedFieldKeys.has(key)}
                  onChange={(e) => {
                    if (e.currentTarget.checked) {
                      if (!usedFieldKeys.has(key))
                        setPrechat({ fields: [...prechat.fields, { key, required: false }] });
                    } else {
                      setPrechat({ fields: prechat.fields.filter((f) => f.key !== key) });
                    }
                  }}
                />
              ))}
            </s-stack>
            <s-checkbox
              label="Show marketing opt-in to customers"
              details="Visitors who subscribe will be converted to customers"
              checked={prechat.marketingOptIn}
              onChange={(e) => setPrechat({ marketingOptIn: e.currentTarget.checked })}
            />
          </>
        ) : null}

        <s-checkbox
          label="Disclaimer consent"
          details="Inform customers how their data is used before they start a conversation or subscribe"
          checked={prechat.disclaimer.enabled}
          onChange={(e) =>
            setPrechat({ disclaimer: { ...prechat.disclaimer, enabled: e.currentTarget.checked } })
          }
        />
        {prechat.disclaimer.enabled ? (
          <>
            <s-banner tone="info">
              Please ensure that this setting aligns with your business&apos;s legal and
              operational requirements regarding data privacy and customer engagement.
            </s-banner>
            <s-text-area
              label="Disclaimer text"
              rows={3}
              value={prechat.disclaimer.html}
              maxLength={2000}
              onInput={(e) =>
                setPrechat({ disclaimer: { ...prechat.disclaimer, html: e.currentTarget.value } })
              }
            />
          </>
        ) : null}
        </s-stack>
      </s-section>

      <s-section>
        <s-stack gap="base">
        <s-stack gap="small-300">
          <s-switch
            label="Display satisfaction survey"
            checked={value.survey}
            onChange={(e) => onChange({ ...value, survey: e.currentTarget.checked })}
          />
          <s-paragraph>
            Turn on to send a satisfaction survey in your conversations with customers.{" "}
            <Link to="/app/settings#survey">Configure survey</Link>
          </s-paragraph>
        </s-stack>
        </s-stack>
      </s-section>

      <s-modal
        id={MODAL_ID}
        heading={modal.index !== null ? "Edit question" : "Add question"}
      >
        <s-stack gap="base">
          <s-box maxInlineSize="120px">
            <s-text-field
              label="Emoji"
              value={modal.emoji}
              maxLength={8}
              onInput={(e) => {
                const emoji = e.currentTarget.value;
                setModal((m) => ({ ...m, emoji }));
              }}
            />
          </s-box>
          <s-text-field
            label="Question"
            value={modal.question}
            maxLength={100}
            details={`${modal.question.length}/100`}
            onInput={(e) => {
              const question = e.currentTarget.value.slice(0, 100);
              setModal((m) => ({ ...m, question }));
            }}
          />
          <s-text-area
            label="Answer"
            rows={5}
            value={modal.answer}
            maxLength={5000}
            onInput={(e) => {
              const answer = e.currentTarget.value;
              setModal((m) => ({ ...m, answer }));
            }}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!modal.question.trim()}
          onClick={saveModal}
        >
          Save
        </s-button>
        <s-button slot="secondary-actions" onClick={() => modalEl()?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>
    </s-stack>
  );
}
