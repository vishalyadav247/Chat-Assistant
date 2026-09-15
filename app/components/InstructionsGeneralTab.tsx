import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
import type { GeneralData, InstructionsActionResult } from "../routes/app.ai-agent.instructions";
import { SaveBar } from "./SaveBar";
import { STORE_INFO_MAX } from "../lib/settings/schemas";

const SCOPE_MAX = 300;
const OFF_TOPIC_MAX = 300;

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
    <s-stack direction="inline" justifyContent="end">
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {props.value.length}/{props.max}
      </s-text>
    </s-stack>
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
  storeInfoAbout: string;
  scope: string;
  offTopicMessage: string;
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
    storeInfoAbout: data.storeInfoAbout,
    scope: data.scope,
    offTopicMessage: data.offTopicMessage,
  };
}

export function InstructionsGeneralTab(props: { initial: GeneralData }) {
  const shopify = useAppBridge();
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

  // Arriving from the dashboard step (#store-info): bring the section into view.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#store-info") {
      document.getElementById("store-info")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

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
      storeInfoAbout: form.storeInfoAbout.slice(0, STORE_INFO_MAX),
      scope: form.scope.slice(0, SCOPE_MAX),
      offTopicMessage: form.offTopicMessage.slice(0, OFF_TOPIC_MAX),
    };
    fetcher.submit(
      { intent: "save-general", payload: JSON.stringify(payload) },
      { method: "post" },
    );
  };

  const discard = () => setForm(saved);

  // Spec 26: instructions written from the store's own data after install.
  const regenerateFetcher = useFetcher<InstructionsActionResult>();
  const regenerating = regenerateFetcher.state !== "idle";
  useEffect(() => {
    const result = regenerateFetcher.data;
    if (regenerateFetcher.state !== "idle" || !result || result.intent !== "ai-setup-regenerate") return;
    if (result.ok) {
      shopify.toast.show("Rewriting your instructions from your store data — refresh in about a minute");
    } else {
      shopify.toast.show(result.error ?? "Couldn't start — try again", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenerateFetcher.state, regenerateFetcher.data]);
  const aiSetup = props.initial.aiSetup;
  const aiWritten = aiSetup.status === "done" && aiSetup.generatedAt;
  const needsReview = aiWritten && !aiSetup.reviewedAt;
  const inProgress = aiSetup.status === "pending" || aiSetup.status === "running";

  return (
    <s-stack gap="base">
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />

      {needsReview ? (
        <s-banner tone="info" heading="Your assistant's instructions were written from your store">
          <s-stack gap="small-200">
            <s-paragraph>
              We used your Shopify store details, policies, pages and catalogue. They&apos;re live now — review them and
              press Save to confirm. Anything you change is never rewritten.
            </s-paragraph>
            {aiSetup.conflicts.length > 0 ? (
              <s-stack gap="small-100">
                <s-text type="strong">Your store data disagrees with itself — fix it in Shopify so the assistant is consistent:</s-text>
                <s-unordered-list>
                  {aiSetup.conflicts.map((conflict) => (
                    <s-list-item key={conflict}>{conflict}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            ) : null}
            {aiSetup.faqDrafts > 0 ? (
              <s-paragraph>
                {aiSetup.faqDrafts} FAQ draft{aiSetup.faqDrafts === 1 ? "" : "s"} added in Training → FAQs — answer and
                publish the ones you want shoppers to see.
              </s-paragraph>
            ) : null}
          </s-stack>
        </s-banner>
      ) : null}
      {inProgress ? (
        <s-banner tone="info" heading="Writing your instructions from your store data…">
          <s-paragraph>This takes about a minute after your products finish syncing.</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Write from my store">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-paragraph color="subdued">
            Rewrite store info, role, tone, behaviours, scope and messages from your Shopify store data. Fields you have
            edited yourself are kept.
          </s-paragraph>
          <s-button
            icon="wand"
            loading={regenerating}
            disabled={regenerating || inProgress}
            onClick={() => regenerateFetcher.submit({ intent: "ai-setup-regenerate" }, { method: "post" })}
          >
            {aiWritten ? "Rewrite from my store" : "Write from my store"}
          </s-button>
        </s-grid>
      </s-section>

      {/* Store info (2026-09-14): what the AI knows about the store itself.
          Saved to ShopSettings.storeInfo.about and embedded as the store_info
          knowledge source, so "where are you based?" is answered from it. The
          dashboard "Add store info" step links here (#store-info). */}
      <s-section id="store-info" heading="Store info">
          <s-stack gap="small-200">
            {/* "Fill from Shopify" was removed 2026-09-15 (owner decision): "Write
                from my store" (spec 26) above writes this field and every other
                one from the same Shopify data and more. */}
            <s-paragraph color="subdued">
              Tell your assistant about your store — what you sell, where you&apos;re based,
              opening hours, and how shoppers can reach you. It answers questions about your
              store from this.
            </s-paragraph>
            <s-text-area
              label="Store info"
              labelAccessibilityVisibility="exclusive"
              rows={6}
              maxLength={STORE_INFO_MAX}
              value={form.storeInfoAbout}
              placeholder={
                "e.g., [Store name] is a small family-run business selling [what you sell].\nBased in: [city, country]. Opening hours: [days and times].\nShipping: [where you ship and how long it takes].\nContact: [email / phone]"
              }
              onInput={(e) => set("storeInfoAbout", e.currentTarget.value)}
            />
            <Counter value={form.storeInfoAbout} max={STORE_INFO_MAX} />
          </s-stack>
        </s-section>

      <s-section heading="Role">
        <s-stack gap="small-200">
          <s-paragraph color="subdued">
            Define who your assistant is and what they help customers with.
          </s-paragraph>
          <s-text-area
            label="Role"
            labelAccessibilityVisibility="exclusive"
            rows={3}
            maxLength={250}
            value={form.role}
            placeholder="e.g., You are a friendly shopping assistant for this store. You help shoppers find the right products and answer their questions about products, orders and store policies."
            onInput={(e) => set("role", e.currentTarget.value)}
          />
          <Counter value={form.role} max={250} />
        </s-stack>
      </s-section>

      <s-section heading="Communication style">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Pick a preset or describe the personality and speaking style yourself.
          </s-paragraph>
          <s-stack direction="inline" gap="small-200">
            {STYLE_PRESETS.map((preset) => {
              const active = form.communicationStyle === preset.id;
              return (
                <s-clickable-chip
                  key={preset.id}
                  color={active ? "strong" : "base"}
                  accessibilityLabel={`${preset.label} style${active ? " (selected)" : ""}`}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      communicationStyle: preset.id,
                      brandVoice: preset.id === "custom" ? prev.brandVoice : preset.text,
                    }))
                  }
                >
                  {active ? <s-icon slot="graphic" type="check" size="small" /> : null}
                  {preset.label}
                </s-clickable-chip>
              );
            })}
          </s-stack>
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
        </s-stack>
      </s-section>

      <s-section heading="Behaviours">
        <s-stack gap="small-200">
          <s-paragraph color="subdued">
            Define how your assistant should respond to customers and handle conversations.
          </s-paragraph>
          <s-text-area
            label="Behaviours"
            labelAccessibilityVisibility="exclusive"
            rows={14}
            maxLength={1000}
            placeholder={"ROLE:\n- …\n\nKNOWLEDGE:\n- …\n\nCOMMUNICATION STYLE:\n- …\n\nGUIDELINES:\n- …\n\nAVOID:\n- …"}
            value={form.behaviours}
            onInput={(e) => set("behaviours", e.currentTarget.value)}
          />
          <Counter value={form.behaviours} max={1000} />
        </s-stack>
      </s-section>

      <s-section heading="Language">
        <s-stack gap="base">
          <s-select
            label="Default language"
            details="Used when the shopper's language can't be detected."
            value={form.defaultLanguage}
            onInput={(e) => set("defaultLanguage", e.currentTarget.value)}
          >
            {LANGUAGE_OPTIONS.map((lang) => (
              <s-option key={lang.value} value={lang.value}>
                {lang.label}
              </s-option>
            ))}
          </s-select>
          {/* Available on every plan. */}
          <s-switch
            label="Auto-detect shopper's language"
            details="When enabled, the assistant answers in the language of the shopper's latest message and switches with them mid-chat. When off, it always answers in the default language above."
            checked={form.autoDetectLanguage}
            onInput={(e) => set("autoDetectLanguage", e.currentTarget.checked)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Banned topics & phrases">
        <s-stack gap="small-200">
          <s-paragraph color="subdued">
            One topic or phrase per line. If a shopper&apos;s message is about one of these, the
            assistant politely declines.
          </s-paragraph>
          <s-text-area
            label="Banned topics"
            labelAccessibilityVisibility="exclusive"
            rows={4}
            value={form.bannedTopicsText}
            placeholder={"medical advice\ncompetitor pricing"}
            details="Changes take effect within about a minute — banned-topic vectors re-embed automatically on the next message."
            onInput={(e) => set("bannedTopicsText", e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      {/* Store scope + off-topic message (QA-A3 / owner decision D-4,
          2026-09-14). The pipeline supported both but no screen set them. With a
          scope set, requests outside it — including creative or general tasks
          like "write me a poem" — are declined with the off-topic message. */}
      <s-section heading="Store scope">
        <s-stack gap="small-200">
          <s-paragraph color="subdued">
            What your store is about. When set, requests outside it — like writing a poem or
            general questions — are politely declined with the message below. Leave empty to
            not restrict topics.
          </s-paragraph>
          <s-text-area
            label="Store scope"
            labelAccessibilityVisibility="exclusive"
            rows={2}
            maxLength={SCOPE_MAX}
            value={form.scope}
            placeholder="e.g., outdoor clothing and camping gear"
            onInput={(e) => set("scope", e.currentTarget.value)}
          />
          <Counter value={form.scope} max={SCOPE_MAX} />
          <s-text-area
            label="Off-topic message"
            rows={2}
            maxLength={OFF_TOPIC_MAX}
            value={form.offTopicMessage}
            placeholder="I can only help with our store and its products — is there something I can help you find?"
            details="Shown when a request is outside your store scope. Leave blank to use the built-in default."
            onInput={(e) => set("offTopicMessage", e.currentTarget.value)}
          />
          <Counter value={form.offTopicMessage} max={OFF_TOPIC_MAX} />
        </s-stack>
      </s-section>

      <s-section heading="Fallback message">
        <s-stack gap="small-200">
          <s-paragraph color="subdued">Shown when the assistant can&apos;t confidently help.</s-paragraph>
          <s-text-area
            label="Fallback message"
            labelAccessibilityVisibility="exclusive"
            rows={3}
            maxLength={500}
            value={form.fallbackMessage}
            placeholder="I'm not sure about that one — leave your email and our team will get back to you."
            details="Leave blank to use the built-in default, shown in your store's language. The assistant captures the shopper's email as a lead after showing this."
            onInput={(e) => set("fallbackMessage", e.currentTarget.value)}
          />
          <Counter value={form.fallbackMessage} max={500} />
        </s-stack>
      </s-section>
    </s-stack>
  );
}
