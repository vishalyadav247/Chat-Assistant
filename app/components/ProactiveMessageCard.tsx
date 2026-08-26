import { useState } from "react";
import type { CampaignMessageData, CampaignSettingsData } from "../lib/settings/schemas";
import {
  campaignTemplate,
  isPremiumMessageKind,
  isPremiumRecommendation,
  MESSAGE_KIND_LABELS,
  RECOMMENDATION_OPTIONS,
} from "../lib/campaigns/templates";
import type { CampaignDraft, DiscountOption } from "./ProactiveCampaignEditor";
import type { BrowseItemMeta } from "./BrowseProductsModal";
import { BrowseProductsModal, BrowseThumb } from "./BrowseProductsModal";
import { RadioOption } from "./ui/RadioOption";
import { htmlTextLength, RichTextEditor } from "./ui/RichTextEditor";
import { INK, RADIUS, SPACE } from "./ui/tokens";

// Proactive-chat editor → Message card (spec 12). The tab strip, the fields
// under each tab and the character counters all come from the design
// reference (.claude/resources/proactive_chat/*.png); which tabs exist is
// declared per template in lib/campaigns/templates.ts.

function UpgradeBadge(props: { label?: string }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 800,
        borderRadius: RADIUS.pill,
        padding: "2px 8px",
        color: "#8a5a00",
        background: "#fde68a",
        whiteSpace: "nowrap",
      }}
    >
      {props.label ?? "Pro +"}
    </span>
  );
}

/** Message-type tab strip. Gated tabs render disabled with the upgrade chip,
 *  exactly like the design's "Product Quiz — Pro +". */
function KindTabs(props: {
  kinds: CampaignMessageData["kind"][];
  active: CampaignMessageData["kind"];
  premiumAllowed: boolean;
  onChange: (kind: CampaignMessageData["kind"]) => void;
}) {
  if (props.kinds.length < 2) return null;
  return (
    <div
      role="tablist"
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: SPACE.xs,
        background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
        borderRadius: RADIUS.chip,
        padding: 4,
        width: "fit-content",
        maxWidth: "100%",
      }}
    >
      {props.kinds.map((kind) => {
        const active = props.active === kind;
        const gated = isPremiumMessageKind(kind) && !props.premiumAllowed;
        return (
          <button
            key={kind}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={gated}
            onClick={() => (gated ? undefined : props.onChange(kind))}
            style={{
              border: "none",
              font: "inherit",
              fontWeight: 650,
              fontSize: 12.5,
              padding: "6px 12px",
              borderRadius: RADIUS.chip - 2,
              display: "inline-flex",
              alignItems: "center",
              gap: SPACE.sm,
              cursor: gated ? "not-allowed" : "pointer",
              opacity: gated ? 0.55 : 1,
              color: active ? "var(--s-color-text, #2e2e37)" : INK.muted,
              background: active ? "var(--s-color-bg, #fff)" : "transparent",
              boxShadow: active ? "0 1px 3px rgba(20,20,25,.15)" : "none",
            }}
          >
            {active ? <s-icon type="check" size="small" /> : null}
            {MESSAGE_KIND_LABELS[kind]}
            {gated ? <UpgradeBadge /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function ProactiveMessageCard(props: {
  draft: CampaignDraft;
  setDraft: (updater: (d: CampaignDraft) => CampaignDraft) => void;
  discounts: DiscountOption[];
  productMeta: Record<string, BrowseItemMeta>;
  extraMeta: Record<string, BrowseItemMeta>;
  onExtraMeta: (meta: Record<string, BrowseItemMeta>) => void;
  premiumAllowed: boolean;
}) {
  const { draft, setDraft } = props;
  const tpl = campaignTemplate(draft.templateType);
  const message = draft.settings.message;
  const [browseProducts, setBrowseProducts] = useState(false);
  const [discountQuery, setDiscountQuery] = useState("");

  const setMessage = (patch: Partial<CampaignSettingsData["message"]>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, message: { ...d.settings.message, ...patch } } }));
  const setLead = (patch: Partial<CampaignSettingsData["message"]["lead"]>) =>
    setDraft((d) => ({
      ...d,
      settings: {
        ...d.settings,
        message: { ...d.settings.message, lead: { ...d.settings.message.lead, ...patch } },
      },
    }));

  const meta = (id: string) => props.extraMeta[id] ?? props.productMeta[id];

  const bodyEditor = (label: string) => (
    <RichTextEditor
      label={label}
      value={message.bodyHtml}
      rows={5}
      onChange={(bodyHtml) => setMessage({ bodyHtml })}
      details={
        <s-text tone="neutral">
          Merge tags: {"{{customer_name}}"} · {"{{cart_total}}"} — {htmlTextLength(message.bodyHtml)}/1000
        </s-text>
      }
    />
  );

  const productPicker = (
    <s-stack gap="small">
      {message.productIds.length === 0 ? (
        <s-text tone="neutral">No products selected yet.</s-text>
      ) : (
        <div>
          {message.productIds.map((id) => {
            const m = meta(id);
            return (
              <div
                key={id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 0",
                  borderBottom: `1px solid ${INK.borderSoft}`,
                }}
              >
                <BrowseThumb imageUrl={m?.imageUrl ?? null} title={m?.title ?? "Item"} />
                <span style={{ flex: 1, fontSize: 13 }}>{m?.title ?? "Unavailable item"}</span>
                <s-button
                  icon="x"
                  variant="tertiary"
                  accessibilityLabel={`Remove ${m?.title ?? "item"}`}
                  onClick={() => setMessage({ productIds: message.productIds.filter((p) => p !== id) })}
                />
              </div>
            );
          })}
        </div>
      )}
      <div>
        <s-button onClick={() => setBrowseProducts(true)}>Browse products</s-button>
      </div>
    </s-stack>
  );

  // ── per-tab bodies ─────────────────────────────────────────────────────────
  const textTab = (
    <s-stack gap="base">
      {tpl?.showContentMode ? (
        <s-stack gap="small">
          <s-text>Content</s-text>
          <s-stack gap="small-300">
            <RadioOption
              name="campaign-content-mode"
              value="quick_question"
              selected={message.contentMode}
              label="Quick question"
              details="Offer your chatbox conversation starters as tappable chips."
              onSelect={() => setMessage({ contentMode: "quick_question" })}
            />
            <RadioOption
              name="campaign-content-mode"
              value="custom"
              selected={message.contentMode}
              label="Custom message"
              onSelect={() => setMessage({ contentMode: "custom" })}
            >
              {bodyEditor("Message")}
            </RadioOption>
          </s-stack>
        </s-stack>
      ) : (
        bodyEditor("Message")
      )}
    </s-stack>
  );

  const recommendationTab = (
    <s-stack gap="base">
      {bodyEditor("Message")}
      <s-stack gap="small-300">
        {RECOMMENDATION_OPTIONS.map((option) => {
          const gated = isPremiumRecommendation(option.value) && !props.premiumAllowed;
          return (
            <RadioOption
              key={option.value}
              name="campaign-recommendation"
              value={option.value}
              selected={message.recommendation}
              label={option.label}
              details={option.help}
              disabled={gated}
              badge={gated ? <UpgradeBadge label="👑 Upgrade" /> : null}
              onSelect={(recommendation) => setMessage({ recommendation })}
            >
              {option.value === "custom" ? productPicker : null}
            </RadioOption>
          );
        })}
      </s-stack>
      <div style={{ display: "flex", gap: SPACE.md, flexWrap: "wrap" }}>
        <s-text-field
          label="Secondary button text"
          details="Leave empty to hide it."
          value={message.secondaryButtonText}
          maxLength={30}
          onInput={(e) => setMessage({ secondaryButtonText: e.currentTarget.value })}
        />
        <s-text-field
          label="Primary button text"
          value={message.primaryButtonText}
          maxLength={30}
          onInput={(e) => setMessage({ primaryButtonText: e.currentTarget.value })}
        />
      </div>
    </s-stack>
  );

  const filteredDiscounts = (() => {
    const q = discountQuery.trim().toLowerCase();
    const list = q ? props.discounts.filter((d) => d.code.toLowerCase().includes(q)) : props.discounts;
    return list.slice(0, 8);
  })();

  const discountTab = (
    <s-stack gap="base">
      {bodyEditor("Message")}

      <s-text-field
        label="Trigger button text"
        details="A message will be sent automatically to trigger the discount offer flow"
        value={message.triggerButtonText}
        maxLength={60}
        onInput={(e) => setMessage({ triggerButtonText: e.currentTarget.value })}
      />

      <s-stack gap="small">
        <s-text>Discount code</s-text>
        {message.discountCode ? (
          <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
            <s-badge tone="success">{message.discountCode}</s-badge>
            <s-button variant="tertiary" onClick={() => setMessage({ discountCode: "" })}>
              Change
            </s-button>
          </div>
        ) : (
          <s-stack gap="small">
            {/* s-grid, not an inline s-stack: a form control fills the inline
                size it's given, so the field would push "Select" onto its own
                row at any width. */}
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-search-field
                label="Search discount"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search discount"
                value={discountQuery}
                onInput={(e) => setDiscountQuery(e.currentTarget.value)}
              />
              <s-button
                disabled={filteredDiscounts.length !== 1}
                onClick={() =>
                  filteredDiscounts.length === 1
                    ? setMessage({ discountCode: filteredDiscounts[0].code })
                    : undefined
                }
              >
                Select
              </s-button>
            </s-grid>
            {props.discounts.length === 0 ? (
              <s-text tone="neutral">
                No discount codes synced yet. Create one in Shopify → Discounts, then reload this page.
              </s-text>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.sm }}>
                {filteredDiscounts.map((d) => (
                  <s-button key={d.code} onClick={() => setMessage({ discountCode: d.code })}>
                    {d.code}
                  </s-button>
                ))}
                {filteredDiscounts.length === 0 ? (
                  <s-text tone="neutral">No codes match “{discountQuery}”.</s-text>
                ) : null}
              </div>
            )}
          </s-stack>
        )}
      </s-stack>

      <s-text-field
        label="Usage instruction"
        value={message.usageInstruction}
        maxLength={300}
        onInput={(e) => setMessage({ usageInstruction: e.currentTarget.value })}
      />

      <s-stack gap="small">
        <s-checkbox
          label="Collect lead"
          details="Ask for contact details before revealing the code."
          checked={message.collectLead}
          onChange={(e) => setMessage({ collectLead: e.currentTarget.checked })}
        />
        {message.collectLead ? (
          <s-box paddingInlineStart="large">
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack gap="base">
                <s-text-field
                  label="Introduction"
                  value={message.lead.introduction}
                  maxLength={300}
                  onInput={(e) => setLead({ introduction: e.currentTarget.value })}
                />
                <s-stack gap="small">
                  <s-text>Form fields</s-text>
                  {/* Email is the identity the lead is stored under — it can't
                      be switched off, so it renders checked and disabled. */}
                  <s-checkbox label="Email" checked disabled />
                  <s-checkbox
                    label="Name"
                    checked={message.lead.askName}
                    onChange={(e) => setLead({ askName: e.currentTarget.checked })}
                  />
                  <s-checkbox
                    label="Phone"
                    checked={message.lead.askPhone}
                    onChange={(e) => setLead({ askPhone: e.currentTarget.checked })}
                  />
                </s-stack>
                <s-stack gap="small">
                  <s-text>Marketing double opt-in</s-text>
                  <div
                    style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: SPACE.md }}
                  >
                    <s-text tone="neutral">
                      Enable marketing double opt-in to get explicit consent from customers before sending
                      email marketing.
                    </s-text>
                    <s-switch
                      label="Marketing double opt-in"
                      labelAccessibilityVisibility="exclusive"
                      checked={message.lead.doubleOptIn}
                      onChange={(e) => setLead({ doubleOptIn: e.currentTarget.checked })}
                    />
                  </div>
                </s-stack>
                <s-text-area
                  label="Success message"
                  rows={3}
                  value={message.lead.successMessage}
                  maxLength={400}
                  onInput={(e) => setLead({ successMessage: e.currentTarget.value })}
                />
              </s-stack>
            </s-box>
          </s-box>
        ) : null}
      </s-stack>
    </s-stack>
  );

  const floaterTab = (
    <s-stack gap="base">
      <s-text-field
        label="Floater message"
        details={`Use {{ option }} to insert the product's variant option name (e.g. size, color). — ${message.floaterMessage.length}/100`}
        value={message.floaterMessage}
        maxLength={100}
        onInput={(e) => setMessage({ floaterMessage: e.currentTarget.value })}
      />
      <s-text-field
        label="Subtitle"
        details={`Supporting line under the headline. Supports {{ option }} too. — ${message.subtitle.length}/120`}
        value={message.subtitle}
        maxLength={120}
        onInput={(e) => setMessage({ subtitle: e.currentTarget.value })}
      />
      <s-text-field
        label="CTA button text"
        details={`The text shown on the floater's action button — ${message.ctaText.length}/30`}
        value={message.ctaText}
        maxLength={30}
        onInput={(e) => setMessage({ ctaText: e.currentTarget.value })}
      />
    </s-stack>
  );

  const body =
    message.kind === "product_recommendation"
      ? recommendationTab
      : message.kind === "discount"
        ? discountTab
        : message.kind === "floater"
          ? floaterTab
          : textTab;

  return (
    <s-section heading="Message">
      <s-stack gap="base">
        <KindTabs
          kinds={tpl?.messageKinds ?? ["text"]}
          active={message.kind}
          premiumAllowed={props.premiumAllowed}
          onChange={(kind) => setMessage({ kind })}
        />
        {body}
      </s-stack>

      <BrowseProductsModal
        open={browseProducts}
        onClose={() => setBrowseProducts(false)}
        selectedIds={message.productIds}
        onConfirm={(ids, newMeta) => {
          setMessage({ productIds: ids });
          if (newMeta) props.onExtraMeta(newMeta);
          setBrowseProducts(false);
        }}
      />
    </s-section>
  );
}
