import { useEffect, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { GeneralData, InstructionsActionResult } from "../routes/app.ai-agent.instructions";
import { SaveBar } from "./SaveBar";

// Instructions → General tab (spec 08, design #viewInstructions persona panel):
// Role / Communication style / Behaviours / Default language / Auto-detect
// language (Plus gate seam) / Banned topics / Fallback message → Persona +
// Guardrails rows via the save-general intent.

const STYLE_PRESETS: { id: string; label: string; text: string }[] = [
  {
    id: "friendly",
    label: "Friendly",
    text: "Warm, approachable, and enthusiastic tone. Use light-hearted greetings, conversational language, and occasionally emojis to make the customer feel welcome and at ease.",
  },
  {
    id: "professional",
    label: "Professional",
    text: "Polished, precise, and courteous tone. Keep answers clear and to the point, avoid slang, and maintain a professional level of formality.",
  },
  {
    id: "empathetic",
    label: "Empathetic",
    text: "Understanding, patient, and reassuring tone. Acknowledge the customer's feelings, use supportive language, and focus on calmly solving their problem.",
  },
  { id: "custom", label: "Custom", text: "" },
];

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
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

interface FormState {
  role: string;
  communicationStyle: string;
  brandVoice: string;
  behaviours: string;
  defaultLanguage: string;
  autoDetectLanguage: boolean;
  bannedTopicsText: string; // textarea, one per line
  fallbackMessage: string;
}

function toForm(data: GeneralData): FormState {
  return {
    role: data.role,
    communicationStyle: data.communicationStyle,
    brandVoice: data.brandVoice,
    behaviours: data.behaviours,
    defaultLanguage: data.defaultLanguage,
    autoDetectLanguage: data.autoDetectLanguage,
    bannedTopicsText: data.bannedTopics.join("\n"),
    fallbackMessage: data.fallbackMessage,
  };
}

export function InstructionsGeneralTab(props: { initial: GeneralData; autoDetectLocked: boolean }) {
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const fetcher = useFetcher<InstructionsActionResult>();
  const [saved, setSaved] = useState<FormState>(() => toForm(props.initial));
  const [form, setForm] = useState<FormState>(() => toForm(props.initial));

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.intent !== "save-general") return;
    if (fetcher.data.ok) {
      shopify.toast.show("Instructions saved");
      setSaved(form);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = () => {
    const payload = {
      role: form.role.slice(0, 250),
      communicationStyle: form.communicationStyle,
      brandVoice: form.brandVoice.slice(0, 500),
      behaviours: form.behaviours.slice(0, 1000),
      defaultLanguage: form.defaultLanguage,
      autoDetectLanguage: form.autoDetectLanguage,
      bannedTopics: form.bannedTopicsText
        .split("\n")
        .map((line) => line.trim().slice(0, 100))
        .filter(Boolean),
      fallbackMessage: form.fallbackMessage.slice(0, 500),
    };
    fetcher.submit(
      { intent: "save-general", payload: JSON.stringify(payload) },
      { method: "post" },
    );
  };

  const discard = () => setForm(saved);

  return (
    <s-stack gap="base">
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />

      <s-section heading="Role">
        <s-paragraph>Define who your assistant is and what they help customers with</s-paragraph>
        <s-text-area
          label="Role"
          labelAccessibilityVisibility="exclusive"
          rows={3}
          maxLength={250}
          value={form.role}
          placeholder="e.g., You are a friendly customer support assistant for an online accessories store. Your goal is to help customers find products, answer questions and provide excellent service."
          onInput={(e) => set("role", e.currentTarget.value)}
        />
        <Counter value={form.role} max={250} />
      </s-section>

      <s-section heading="Communication style">
        <s-paragraph>Define the personality and speaking style of your assistant</s-paragraph>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {STYLE_PRESETS.map((preset) => {
            const active = form.communicationStyle === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    communicationStyle: preset.id,
                    brandVoice: preset.id === "custom" ? prev.brandVoice : preset.text,
                  }))
                }
                style={{
                  cursor: "pointer",
                  font: "inherit",
                  fontWeight: 600,
                  fontSize: 13,
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: active
                    ? "1.5px solid var(--s-color-border-emphasis, #303030)"
                    : "1px solid var(--s-color-border, #d4d4d4)",
                  background: active ? "var(--s-color-bg-fill-secondary, #f1f1f1)" : "transparent",
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <s-text-area
          label="Tone"
          labelAccessibilityVisibility="exclusive"
          rows={3}
          maxLength={500}
          value={form.brandVoice}
          placeholder="Describe the tone your assistant should use"
          onInput={(e) => {
            const brandVoice = e.currentTarget.value;
            setForm((prev) => ({
              ...prev,
              brandVoice,
              communicationStyle: "custom",
            }));
          }}
        />
      </s-section>

      <s-section heading="Behaviours">
        <s-paragraph>
          Define how your assistant should respond to customers and handle conversations
        </s-paragraph>
        <s-text-area
          label="Behaviours"
          labelAccessibilityVisibility="exclusive"
          rows={14}
          maxLength={1000}
          value={form.behaviours}
          placeholder={"ROLE:\n- …\n\nKNOWLEDGE:\n- …\n\nCOMMUNICATION STYLE:\n- …\n\nGUIDELINES:\n- …\n\nAVOID:\n- …"}
          onInput={(e) => set("behaviours", e.currentTarget.value)}
        />
        <Counter value={form.behaviours} max={1000} />
      </s-section>

      <s-section heading="Default language">
        <s-select
          label="Default language"
          labelAccessibilityVisibility="exclusive"
          value={form.defaultLanguage}
          onChange={(e) => set("defaultLanguage", e.currentTarget.value)}
        >
          {LANGUAGE_OPTIONS.map((lang) => (
            <s-option key={lang.value} value={lang.value}>
              {lang.label}
            </s-option>
          ))}
        </s-select>
      </s-section>

      <s-section heading="Auto-detect shopper's language">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <s-switch
            label="Auto-detect shopper's language"
            labelAccessibilityVisibility="exclusive"
            details="When enabled, the assistant answers in the shopper's detected language"
            checked={form.autoDetectLanguage}
            disabled={props.autoDetectLocked}
            onChange={(e) => set("autoDetectLanguage", e.currentTarget.checked)}
          />
          {props.autoDetectLocked ? (
            <>
              <s-badge tone="info">Plus</s-badge>
              <s-button variant="tertiary" onClick={() => navigate("/app/plan-usage")}>
                Upgrade to unlock
              </s-button>
            </>
          ) : null}
        </div>
      </s-section>

      <s-section heading="Banned topics & phrases">
        <s-paragraph>One topic or phrase per line</s-paragraph>
        <s-text-area
          label="Banned topics"
          labelAccessibilityVisibility="exclusive"
          rows={4}
          value={form.bannedTopicsText}
          placeholder={"medical advice\ncompetitor pricing"}
          onInput={(e) => set("bannedTopicsText", e.currentTarget.value)}
        />
        <s-text tone="neutral">
          If a shopper&apos;s message contains one of these, the assistant declines and shows the
          fallback message. Changes take effect within about a minute — banned-topic vectors
          re-embed automatically on the next message.
        </s-text>
      </s-section>

      <s-section heading="Fallback message">
        <s-paragraph>Shown when the assistant can&apos;t confidently help</s-paragraph>
        <s-text-area
          label="Fallback message"
          labelAccessibilityVisibility="exclusive"
          rows={3}
          maxLength={500}
          value={form.fallbackMessage}
          placeholder="I'm not sure about that one — leave your email and our team will get back to you."
          onInput={(e) => set("fallbackMessage", e.currentTarget.value)}
        />
        <s-text tone="neutral">
          Leave blank to use the built-in default. The assistant captures the shopper&apos;s email as a
          lead after showing this.
        </s-text>
      </s-section>
    </s-stack>
  );
}
