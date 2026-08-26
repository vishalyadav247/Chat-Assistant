import { useEffect, useRef, useState } from "react";
import type { CampaignSettingsData } from "../lib/settings/schemas";
import { campaignTemplate, MESSAGE_KIND_LABELS, RECOMMENDATION_OPTIONS } from "../lib/campaigns/templates";
import { countryName } from "../lib/format/countries";
import { ensureWidgetPreviewAssets } from "../lib/ui/widget-preview-assets";
import type { CampaignDraft } from "./ProactiveCampaignEditor";
import type { BrowseItemMeta } from "./BrowseProductsModal";
import { INK, SPACE } from "./ui/tokens";

// Proactive-chat editor → right column (spec 12): "Message Preview" + the
// read-only summary card from the design reference.
//
// Parity BY CONSTRUCTION, exactly like ChatboxPreview: the preview injects the
// real storefront assets (widget-renderer.js + chat-widget.css, delivered as
// raw strings by the route loader) and renders the bubble through
// window.ChatConvertRenderer.campaignBubble — the SAME builder the widget uses.
// Same campaign JSON in → same DOM out, so the preview cannot drift.

// `window.ChatConvertRenderer` is already declared globally by ChatboxPreview
// with the members that preview needs. Rather than widen that declaration (two
// `declare global` blocks for one property is a type error), read the one
// builder this card uses through a narrow local view.
interface CampaignRenderer {
  campaignBubble: (
    campaign: unknown,
    opts: unknown,
    cb: unknown,
  ) => { el: HTMLElement; confirm: (text: string) => void };
}

function campaignRenderer(): CampaignRenderer | undefined {
  if (typeof window === "undefined") return undefined;
  return window.ChatConvertRenderer as unknown as CampaignRenderer | undefined;
}

// Admin-only layout overrides: un-fix the bubble (it renders inside the
// preview card, not the viewport). Visual styling stays 100% storefront CSS.
const PREVIEW_CSS = `
.ccpc .cw-proactive{width:100%;max-width:none;margin-bottom:0;}
.ccpc .cw-pa--product_recommendation,.ccpc .cw-pa--floater{margin-top:14px;}
`;

/** Sample product used when the campaign has no resolved cards to show — the
 *  design's "Example Product" placeholder. Never persisted. */
const EXAMPLE_CARD = {
  id: "example",
  title: "Example Product",
  price: 69.99,
  imageUrl: null,
  handle: "example-product",
  variantId: null,
};

const EXAMPLE_ANCHOR = {
  ...EXAMPLE_CARD,
  title: "Classic Running Sneakers",
  optionName: "size",
  options: [
    { value: "38", variantId: null, available: true },
    { value: "39", variantId: null, available: true },
    { value: "40", variantId: null, available: true },
    { value: "41", variantId: null, available: true },
    { value: "42", variantId: null, available: true },
  ],
};

function bullet(items: string[]) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
      {items.map((item, i) => (
        <li key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: INK.base }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function SummaryBlock(props: { heading: string; items: string[] }) {
  if (props.items.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{props.heading}</span>
      {bullet(props.items)}
    </div>
  );
}

/** Trigger/Conditions/Message restated in plain language, mirroring the design's
 *  right-hand summary card. */
function summary(draft: CampaignDraft): {
  type: string[];
  trigger: string[];
  conditions: string[];
  message: string[];
} {
  const tpl = campaignTemplate(draft.templateType);
  const { trigger, conditions, message } = draft.settings;

  const scopeLabel: Record<CampaignSettingsData["trigger"]["pageScope"], string> = {
    all_pages: "All pages",
    specific_pages: `Pages containing “${trigger.urlContains}”`,
    all_product_pages: "All product pages",
    specific_product_pages: `${trigger.pageProductIds.length} selected product page(s)`,
    all_collection_pages: "All collection pages",
    specific_collection_pages: `${trigger.pageCollectionIds.length} selected collection page(s)`,
    home: "Homepage",
    search: "Search page",
    cart: "Cart page",
  };

  const triggerItems = [scopeLabel[trigger.pageScope]];
  if (trigger.exitIntent) {
    triggerItems.push("When the visitor moves to leave the page");
  } else if (trigger.sendAfter === "scroll") {
    triggerItems.push(`After visitor scrolled ${trigger.scrollPercent}% of the page`);
  } else {
    triggerItems.push(`After visitor viewed for ${trigger.delaySeconds} seconds`);
  }
  if (trigger.cartMinValue > 0) triggerItems.push(`Cart worth at least ${trigger.cartMinValue}`);
  if (trigger.cartMaxValue !== null) triggerItems.push(`Cart worth at most ${trigger.cartMaxValue}`);
  if (trigger.cartMinItems > 0) triggerItems.push(`Cart has at least ${trigger.cartMinItems} item(s)`);

  const conditionItems = [
    conditions.audience === "all"
      ? "All audiences"
      : conditions.audience === "visitors"
        ? "Only visitors"
        : "Only customers",
    conditions.displayTime === "all" ? "All time (24/7)" : "During business hours",
    conditions.device === "all"
      ? "All devices"
      : conditions.device === "desktop"
        ? "Desktop only"
        : "Mobile only",
    conditions.displayDuration === "always"
      ? "Always display"
      : `${conditions.startDate || "—"} → ${conditions.endDate || "—"}`,
    conditions.countryMode === "all"
      ? "All countries"
      : conditions.countries.length
        ? conditions.countries.map(countryName).join(", ")
        : "No countries selected",
  ];

  const messageItems = [`Type: ${MESSAGE_KIND_LABELS[message.kind]}`];
  if (message.kind === "floater") {
    messageItems.push(`Floater message: ${message.floaterMessage}`);
    if (message.subtitle) messageItems.push(`Subtitle: ${message.subtitle}`);
    if (message.ctaText) messageItems.push(`CTA button: ${message.ctaText}`);
  } else {
    const plain = message.bodyHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (message.contentMode === "quick_question" && message.kind === "text") {
      messageItems.push("Content: conversation starter chips");
    } else if (plain) {
      messageItems.push(`Content: ${plain.length > 90 ? `${plain.slice(0, 90)}…` : plain}`);
    }
    if (message.kind === "product_recommendation") {
      const label = RECOMMENDATION_OPTIONS.find((o) => o.value === message.recommendation)?.label ?? "";
      messageItems.push(`Recommend: ${label}`);
    }
    if (message.kind === "discount") {
      if (message.discountCode) messageItems.push(`Code: ${message.discountCode}`);
      if (message.collectLead) messageItems.push("Collects a lead before revealing the code");
    }
  }

  return {
    type: [tpl?.name ?? draft.templateType],
    trigger: triggerItems,
    conditions: conditionItems,
    message: messageItems,
  };
}

export function ProactiveCampaignPreview(props: {
  draft: CampaignDraft;
  currency: string;
  starters: { label: string }[];
  productMeta: Record<string, BrowseItemMeta>;
  rendererJs: string;
  widgetCss: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const { draft } = props;

  useEffect(() => {
    setReady(
      ensureWidgetPreviewAssets(
        props.rendererJs,
        props.widgetCss,
        "chatconvert-preview-proactive-css",
        PREVIEW_CSS,
      ),
    );
  }, [props.rendererJs, props.widgetCss]);

  useEffect(() => {
    const container = containerRef.current;
    const R = campaignRenderer();
    if (!ready || !container || !R) return;

    const message = draft.settings.message;
    // Cards the merchant explicitly picked render with their real titles; every
    // other source resolves at serve time, so the preview stands in an example.
    const picked = message.productIds
      .map((id) => props.productMeta[id])
      .filter((m): m is BrowseItemMeta => Boolean(m))
      .slice(0, 1)
      .map((m) => ({ ...EXAMPLE_CARD, title: m.title, imageUrl: m.imageUrl }));

    const campaign = {
      id: draft.id ?? "preview",
      templateType: draft.templateType,
      trigger: draft.settings.trigger,
      conditions: draft.settings.conditions,
      message: { ...message, lead: message.collectLead ? message.lead : null },
      appearance: draft.settings.appearance,
      products: picked.length ? picked : [EXAMPLE_CARD],
    };

    container.textContent = "";
    const bubble = R.campaignBubble(
      campaign,
      {
        currency: props.currency,
        customerName: "",
        cartTotal: null,
        anchor: EXAMPLE_ANCHOR,
        starters: props.starters,
        preview: true,
      },
      // No callbacks: the preview is inert. campaignBubble already falls back
      // to showing the configured success copy when onLead is absent.
      {},
    );
    container.appendChild(bubble.el);
  }, [ready, draft, props.currency, props.starters, props.productMeta]);

  const info = summary(draft);

  return (
    <s-stack gap="base">
      <s-section heading="Message Preview">
        <div className="ccpc" ref={containerRef} />
      </s-section>

      <s-section>
        <s-stack gap="base">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: SPACE.sm,
            }}
          >
            <s-heading>{draft.name || "Untitled campaign"}</s-heading>
            <s-badge tone={draft.status === "active" ? "success" : undefined}>
              {draft.status === "active" ? "Active" : "Inactive"}
            </s-badge>
          </div>
          <SummaryBlock heading="Type" items={info.type} />
          <s-divider />
          <SummaryBlock heading="Trigger" items={info.trigger} />
          <s-divider />
          <SummaryBlock heading="Conditions" items={info.conditions} />
          <s-divider />
          <SummaryBlock heading="Message" items={info.message} />
        </s-stack>
      </s-section>
    </s-stack>
  );
}
