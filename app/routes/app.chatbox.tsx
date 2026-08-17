import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import { hasFeature } from "../lib/billing/plans.server";
import { resolveAvailability } from "../lib/settings/availability.server";
import { loadShopSettings } from "../lib/settings/save.server";
import {
  applyChatboxIntent,
  loadWidgetSettings,
  type ChatboxActionResult,
} from "../lib/widget/settings-save.server";
import { getWidgetRendererJs, getWidgetCssText } from "../lib/widget/renderer-assets.server";
import type { WidgetSettingsData } from "../lib/settings/schemas";
import { SaveBar } from "../components/SaveBar";
import { TabPills } from "../components/ui/TabPills";
import { ChatboxGeneral } from "../components/ChatboxGeneral";
import { ChatboxChatPage } from "../components/ChatboxChatPage";
import { ChatboxAppearance } from "../components/ChatboxAppearance";
import { ChatboxPreview, type ChatboxTab } from "../components/ChatboxPreview";

// Chatbox settings + live preview (spec 06). Left: General / Chat page /
// Appearance tabs. Right: sticky preview rendered by the storefront widget's
// own renderer (parity by construction — see renderer-assets.server.ts).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);

  const [shop, settings, shopSettings, faqs, categories] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId } }),
    loadWidgetSettings(shopId),
    loadShopSettings(shopId),
    db.faq.findMany({
      where: { shopId, status: "published", featured: true },
      orderBy: { position: "asc" },
      take: 8,
      select: { id: true, question: true, answerHtml: true, categoryId: true },
    }),
    db.faqCategory.findMany({
      where: { shopId, status: "published" },
      select: { id: true, name: true },
    }),
  ]);

  const plan = shop?.plan ?? "free";
  const availability = resolveAvailability(shopSettings.availability, shop?.timezone || "UTC");
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  return {
    settings,
    // Open enforcement mode → true for every plan today (plans.server.ts).
    removeBrandingAllowed: hasFeature(plan, "remove_branding"),
    availability: { status: availability.status, message: availability.message },
    featuredFaqs: faqs.map((f) => ({
      id: f.id,
      question: f.question,
      answerHtml: f.answerHtml,
      category: (f.categoryId && categoryName.get(f.categoryId)) || null,
    })),
    rendererJs: getWidgetRendererJs(),
    widgetCss: getWidgetCssText(),
    currency: shop?.currency ?? "USD",
    // Survey copy/format (Settings page) — the preview renders the real
    // storefront surveyPrompt with it when "Display satisfaction survey" is on.
    survey: {
      format: shopSettings.survey.format,
      intro: shopSettings.survey.intro,
      thanks: shopSettings.survey.thanks,
    },
    // Order-tracking mode (Settings page) — decides which tracking form(s)
    // the preview shows, same as the storefront.
    orderTrackingMode: shopSettings.orderTracking.mode,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const formData = await request.formData();
  return applyChatboxIntent({ shopId, shopDomain: session.shop, formData });
};

const TABS: Array<{ id: ChatboxTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "chatpage", label: "Chat page" },
  { id: "appearance", label: "Appearance" },
];

export default function ChatboxPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const saveFetcher = useFetcher<ChatboxActionResult>();
  const toggleFetcher = useFetcher<ChatboxActionResult>();

  const [tab, setTab] = useState<ChatboxTab>("general");
  const [draft, setDraft] = useState<WidgetSettingsData>(data.settings);

  // Reset the draft only when the SAVED blob changes (save / activate toggle /
  // reload) — upload actions revalidate the loader without persisting, and
  // must not wipe in-progress edits.
  const savedJson = useMemo(() => JSON.stringify(data.settings), [data.settings]);
  const lastSaved = useRef(savedJson);
  useEffect(() => {
    if (lastSaved.current === savedJson) return;
    lastSaved.current = savedJson;
    setDraft(JSON.parse(savedJson) as WidgetSettingsData);
  }, [savedJson]);

  const saving = saveFetcher.state !== "idle";
  const dirty = useMemo(() => JSON.stringify(draft) !== savedJson, [draft, savedJson]);

  const save = useCallback(() => {
    saveFetcher.submit(
      { intent: "save", payload: JSON.stringify(draft) },
      { method: "post" },
    );
  }, [saveFetcher, draft]);

  const discard = useCallback(() => {
    setDraft(JSON.parse(savedJson) as WidgetSettingsData);
  }, [savedJson]);

  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data) return;
    if (saveFetcher.data.intent !== "save") return;
    if (saveFetcher.data.ok) shopify.toast.show("Chatbox settings saved");
  }, [saveFetcher.state, saveFetcher.data, shopify]);

  const active = data.settings.active;
  const toggling = toggleFetcher.state !== "idle";
  const toggleActive = useCallback(() => {
    // The toggle round-trip revalidates the loader, which resets the draft to
    // the saved blob — silently discarding unsaved edits. Block it while dirty.
    if (dirty) {
      shopify.toast.show("Save or discard your changes first", { isError: true });
      return;
    }
    toggleFetcher.submit(
      { intent: "toggle-active", payload: JSON.stringify({ active: !active }) },
      { method: "post" },
    );
  }, [toggleFetcher, active, dirty, shopify]);

  useEffect(() => {
    if (toggleFetcher.state !== "idle" || !toggleFetcher.data) return;
    if (toggleFetcher.data.ok) {
      shopify.toast.show(
        toggleFetcher.data.intent === "toggle-active" ? "Chatbox updated" : "Saved",
      );
    }
  }, [toggleFetcher.state, toggleFetcher.data, shopify]);

  const saveError =
    saveFetcher.state === "idle" && saveFetcher.data && !saveFetcher.data.ok
      ? saveFetcher.data.error
      : undefined;

  return (
    <s-page heading="Chatbox">
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />

      <s-stack gap="base">
        {saveError ? (
          <s-banner tone="critical" heading="Couldn't save chatbox settings">
            {saveError}
          </s-banner>
        ) : null}

        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={active ? "success" : "neutral"}>{active ? "On" : "Off"}</s-badge>
            <s-text tone="neutral">Set up your customer chat experience.</s-text>
          </s-stack>
          <s-button disabled={toggling} onClick={toggleActive}>
            {active ? "Deactivate" : "Activate"}
          </s-button>
        </s-stack>

        <TabPills tabs={TABS} active={tab} onChange={setTab} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 340px",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div>
            {tab === "general" ? <ChatboxGeneral value={draft} onChange={setDraft} /> : null}
            {tab === "chatpage" ? <ChatboxChatPage value={draft} onChange={setDraft} /> : null}
            {tab === "appearance" ? (
              <ChatboxAppearance
                value={draft}
                removeBrandingAllowed={data.removeBrandingAllowed}
                onChange={setDraft}
              />
            ) : null}
          </div>

          <div style={{ position: "sticky", top: 20 }}>
            <s-stack gap="small">
              <s-heading>Preview</s-heading>
              <ChatboxPreview
                settings={draft}
                tab={tab}
                availability={data.availability}
                featuredFaqs={data.featuredFaqs}
                rendererJs={data.rendererJs}
                widgetCss={data.widgetCss}
                currency={data.currency}
                survey={data.survey}
                orderTrackingMode={data.orderTrackingMode}
              />
            </s-stack>
          </div>
        </div>
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
