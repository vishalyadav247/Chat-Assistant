import { useState } from "react";
import { Link } from "react-router";
import type { WidgetSettingsData } from "../lib/settings/schemas";
import { ChatboxUploadButton } from "./ChatboxUploadButton";
import { arrayMove, DragHandle, useDragReorder } from "./DragReorder";
import { RadioOption } from "./ui/RadioOption";
import { htmlTextLength, RichTextEditor } from "./ui/RichTextEditor";
import { INK, SCROLLBAR_CSS } from "./ui/tokens";

// Chatbox → Chat page tab (spec 06): welcome/offline message, conversation
// starters (add/edit modal with rich-text answer, import from FAQs, reorder,
// delete), chat avatar, pre-chat form, satisfaction survey toggle.

type Starter = WidgetSettingsData["starters"]["items"][number];
type PrechatField = WidgetSettingsData["prechat"]["fields"][number];

const MODAL_ID = "chatbox-starter-modal";
const IMPORT_MODAL_ID = "chatbox-starter-import-modal";

interface ModalEl extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}

const modalEl = (id: string = MODAL_ID) => document.getElementById(id) as ModalEl | null;

/** Published FAQ available for "Import from FAQs" (spec 06). */
export interface ImportableFaq {
  id: string;
  question: string;
  answerHtml: string;
}

const ANSWER_MAX = 5000;
const newStarterId = () =>
  `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface StarterDraft {
  index: number | null; // null = adding
  emoji: string;
  question: string;
  /** Rich-text HTML (sanitized server-side on save). */
  answer: string;
}

const FIELD_LABELS: Record<PrechatField["key"], string> = {
  email: "Email address",
  name: "Name",
  phone: "Phone number",
};

/** Active team member offered as the chat face (loader-provided). */
export interface ChatTeamMember {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}

export function ChatboxChatPage(props: {
  value: WidgetSettingsData;
  onChange: (next: WidgetSettingsData) => void;
  /** Published FAQs offered by "Import from FAQs" (loader-provided). */
  faqs: ImportableFaq[];
  /** Active team members — who "Team member profile" can choose from. */
  teamMembers: ChatTeamMember[];
}) {
  const { value, onChange } = props;
  const starters = value.starters;
  const prechat = value.prechat;
  const [modal, setModal] = useState<StarterDraft>({ index: null, emoji: "💬", question: "", answer: "" });
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set());
  const [importQuery, setImportQuery] = useState("");

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
      setModal({ index, emoji: item.emoji, question: item.question, answer: item.answerHtml });
    }
    modalEl()?.showOverlay();
  };

  const answerTooLong = modal.answer.length > ANSWER_MAX;

  const saveModal = () => {
    if (!modal.question.trim() || answerTooLong) return;
    const next: Starter = {
      id: modal.index !== null ? starters.items[modal.index].id : newStarterId(),
      emoji: modal.emoji || "💬",
      question: modal.question.slice(0, 100),
      answerHtml: modal.answer,
      order: modal.index !== null ? starters.items[modal.index].order : starters.items.length,
    };
    const items = [...starters.items];
    if (modal.index !== null) items[modal.index] = next;
    else items.push(next);
    setStarters(items);
    modalEl()?.hideOverlay();
  };

  // ── Import from FAQs ────────────────────────────────────────────────────
  const normalizeQ = (q: string) => q.trim().toLowerCase();
  const existingQuestions = new Set(starters.items.map((s) => normalizeQ(s.question)));
  const importableFaqs = props.faqs.filter((f) => {
    const q = importQuery.trim().toLowerCase();
    return !q || f.question.toLowerCase().includes(q);
  });
  const selectableIds = importableFaqs
    .filter((f) => !existingQuestions.has(normalizeQ(f.question)))
    .map((f) => f.id);

  const openImport = () => {
    setImportSelected(new Set());
    setImportQuery("");
    modalEl(IMPORT_MODAL_ID)?.showOverlay();
  };

  const toggleImport = (id: string, checked: boolean) =>
    setImportSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const importFaqs = () => {
    const picked = props.faqs.filter((f) => importSelected.has(f.id));
    if (picked.length === 0) return;
    const added: Starter[] = picked.map((f, i) => ({
      id: newStarterId(),
      emoji: "💬",
      question: f.question.slice(0, 100),
      answerHtml: f.answerHtml.slice(0, ANSWER_MAX),
      order: starters.items.length + i,
    }));
    setStarters([...starters.items, ...added]);
    modalEl(IMPORT_MODAL_ID)?.hideOverlay();
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
          onInput={(e) => onChange({ ...value, offlineMessageEnabled: e.currentTarget.checked })}
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
          onInput={(e) =>
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
          <s-button icon="import" onClick={openImport}>
            Import from FAQs
          </s-button>
        </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Chat avatar">
        <s-stack gap="base">
          {/* One single-choice list per option with the reveal panel as a
              sibling — s-choice children flatten to text, so a picker nested
              inside <s-choice> would be swallowed. Same pattern as the
              order-tracking modes in SettingsChatbox. */}
          <RadioOption
            name="chat-avatar"
            value="store_branding"
            selected={value.avatarMode}
            label="Store branding"
            onSelect={() => onChange({ ...value, avatarMode: "store_branding" })}
          >
            <s-paragraph>
              Show your store logo and name in customer chats.{" "}
              <Link to="/app/settings?tab=general">Edit store logo</Link>
            </s-paragraph>
          </RadioOption>

          <RadioOption
            name="chat-avatar"
            value="team_member"
            selected={value.avatarMode}
            label="Team member profile"
            onSelect={() =>
              onChange({
                ...value,
                avatarMode: "team_member",
                // Pre-select when there is exactly one obvious answer, so the
                // mode is never selected-but-unconfigured.
                avatarMemberId:
                  value.avatarMemberId ?? (props.teamMembers.length === 1 ? props.teamMembers[0].id : null),
              })
            }
          >
            <TeamMemberAvatarPicker
              members={props.teamMembers}
              selectedId={value.avatarMemberId}
              onSelect={(id) => onChange({ ...value, avatarMemberId: id })}
            />
          </RadioOption>
        </s-stack>
      </s-section>

      <s-section heading="Pre-chat form">
        <s-stack gap="base">
        <s-paragraph>Collect leads from customers</s-paragraph>
        <s-choice-list
          label="How customers start a chat"
          name="prechat-mode"
          values={[prechat.mode]}
          onInput={(e) => {
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
                onInput={(e) => {
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
                  onInput={(e) => {
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
              onInput={(e) => setPrechat({ marketingOptIn: e.currentTarget.checked })}
            />
          </>
        ) : null}

        <s-checkbox
          label="Disclaimer consent"
          details="Inform customers how their data is used before they start a conversation or subscribe"
          checked={prechat.disclaimer.enabled}
          onInput={(e) =>
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
            onInput={(e) => onChange({ ...value, survey: e.currentTarget.checked })}
          />
          <s-paragraph>
            Turn on to send a satisfaction survey in your conversations with customers.{" "}
            <Link to="/app/settings?tab=survey">Configure survey</Link>
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
          <RichTextEditor
            label="Answer"
            rows={5}
            value={modal.answer}
            placeholder="Write the instant answer shoppers see when they tap this question…"
            onChange={(answer) => setModal((m) => ({ ...m, answer }))}
            details={
              answerTooLong
                ? "Answer is too long — shorten it to save."
                : `${htmlTextLength(modal.answer)} characters`
            }
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!modal.question.trim() || answerTooLong}
          onClick={saveModal}
        >
          Save
        </s-button>
        <s-button slot="secondary-actions" onClick={() => modalEl()?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>

      <s-modal id={IMPORT_MODAL_ID} heading="Import from FAQs">
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
        <s-stack gap="base">
          {props.faqs.length === 0 ? (
            <s-paragraph>
              No published FAQs yet.{" "}
              <Link to="/app/ai-agent/training?tab=faqs">Create FAQs</Link> first, then import
              them here as conversation starters.
            </s-paragraph>
          ) : (
            <>
              <s-text-field
                label="Search FAQs"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search questions"
                icon="search"
                value={importQuery}
                onInput={(e) => setImportQuery(e.currentTarget.value)}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <s-text tone="neutral">
                  {importSelected.size} selected · {selectableIds.length} available
                </s-text>
                <s-button
                  variant="tertiary"
                  disabled={selectableIds.length === 0}
                  onClick={() =>
                    setImportSelected(
                      selectableIds.every((id) => importSelected.has(id))
                        ? new Set()
                        : new Set(selectableIds),
                    )
                  }
                >
                  {selectableIds.length > 0 && selectableIds.every((id) => importSelected.has(id))
                    ? "Clear selection"
                    : "Select all"}
                </s-button>
              </div>
              {/* The FAQ list is the ONLY scroller: capped so the modal body
                  itself never overflows (two nested scrollbars otherwise). */}
              <div
                className="cc-scroll"
                style={{
                  maxHeight: "max(140px, min(300px, calc(100vh - 340px)))",
                  overflowY: "auto",
                  paddingRight: 4,
                }}
              >
                {importableFaqs.length === 0 ? (
                  <s-text tone="neutral">No FAQs match your search.</s-text>
                ) : (
                  importableFaqs.map((faq, i) => {
                    const already = existingQuestions.has(normalizeQ(faq.question));
                    return (
                      <div
                        key={faq.id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          padding: "8px 0",
                          borderTop: i > 0 ? `1px solid ${INK.border}` : "none",
                          opacity: already ? 0.6 : 1,
                        }}
                      >
                        <s-checkbox
                          label={faq.question}
                          labelAccessibilityVisibility="exclusive"
                          checked={already || importSelected.has(faq.id)}
                          disabled={already}
                          onInput={(e) => toggleImport(faq.id, e.currentTarget.checked)}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <s-text type="strong">{faq.question}</s-text>
                          <div
                            style={{
                              fontSize: 12.5,
                              color: INK.muted,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {faq.answerHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() ||
                              "No answer"}
                          </div>
                        </div>
                        {already ? <s-badge>Added</s-badge> : null}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={importSelected.size === 0}
          onClick={importFaqs}
        >
          {importSelected.size > 0 ? `Import ${importSelected.size}` : "Import"}
        </s-button>
        <s-button slot="secondary-actions" onClick={() => modalEl(IMPORT_MODAL_ID)?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>
    </s-stack>
  );
}

/**
 * "Team member profile" configuration: pick who fronts the chat, and give them
 * a photo. Falls back to their initials, so a member with no photo is still a
 * valid choice rather than a blank circle.
 *
 * Uploads persist immediately (upload-member-avatar writes the TeamMember row)
 * because the photo belongs to the person, not to this unsaved draft — but the
 * SELECTION is draft state like every other setting on this page, so it only
 * takes effect on Save.
 */
function TeamMemberAvatarPicker(props: {
  members: ChatTeamMember[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selected = props.members.find((m) => m.id === props.selectedId) ?? null;

  if (props.members.length === 0) {
    return (
      <s-stack gap="small-300">
        <s-paragraph>
          You don&apos;t have any active team members yet. Invite one to use their profile as
          the chat avatar.
        </s-paragraph>
        <div>
          <Link to="/app/settings?tab=general">Manage team</Link>
        </div>
      </s-stack>
    );
  }

  return (
    <s-stack gap="base">
      <s-paragraph>
        Show a real person in customer chats — their photo and name appear on every AI and
        agent reply.
      </s-paragraph>
      <s-select
        label="Team member"
        value={props.selectedId ?? ""}
        onInput={(e) => props.onSelect(e.currentTarget.value || null)}
      >
        <s-option value="">Select a team member</s-option>
        {props.members.map((member) => (
          <s-option key={member.id} value={member.id}>
            {member.name} ({member.role})
          </s-option>
        ))}
      </s-select>

      {selected ? (
        <s-stack direction="inline" gap="base" alignItems="center">
          {selected.avatarUrl ? (
            <img
              src={selected.avatarUrl}
              alt=""
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <span
              aria-hidden="true"
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
                fontWeight: 700,
                color: "#fff",
                background: "linear-gradient(135deg,#6d3bf5,#3b82f6)",
              }}
            >
              {memberInitials(selected.name)}
            </span>
          )}
          <s-stack gap="small-500">
            <s-text type="strong">{selected.name}</s-text>
            <s-text color="subdued">
              {selected.avatarUrl ? "Photo uploaded" : "No photo — initials will be shown"}
            </s-text>
          </s-stack>
          <ChatboxUploadButton
            intent="upload-member-avatar"
            memberId={selected.id}
            label={selected.avatarUrl ? "Replace photo" : "Upload photo"}
            accept="image/png,image/jpeg,image/webp"
            onUploaded={() => {
              /* The row is already written; the loader revalidation shows it. */
            }}
          />
        </s-stack>
      ) : null}
    </s-stack>
  );
}

function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}
