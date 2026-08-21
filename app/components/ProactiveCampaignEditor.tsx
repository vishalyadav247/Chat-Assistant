import { useState } from "react";
import type { CampaignSettingsData } from "../lib/settings/schemas";
import {
  campaignTemplate,
  isCartTemplate,
  usesCollectionPicker,
  usesProductPicker,
} from "../lib/campaigns/templates";
import type { BrowseItemMeta } from "./BrowseProductsModal";
import { BrowseProductsModal, BrowseThumb } from "./BrowseProductsModal";
import { BrowseCollectionsModal } from "./BrowseCollectionsModal";

// Minimal campaign editor (spec 12 — design gap, spec-defined): Name, trigger
// (page types / url contains / delay / exit intent / cart state), message with
// merge-tag hint, CTA (label + action + url), discount code, product/collection
// pickers per template, status. Once-per-session frequency is fixed v1.

export interface CampaignDraft {
  id: string | null;
  templateType: string;
  name: string;
  status: "active" | "inactive";
  settings: CampaignSettingsData;
}

const PAGE_TYPES: { value: CampaignSettingsData["trigger"]["pageTypes"][number]; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "product", label: "Product" },
  { value: "collection", label: "Collection" },
  { value: "search", label: "Search" },
  { value: "cart", label: "Cart" },
  { value: "any", label: "Any page" },
];

export function ProactiveCampaignEditor(props: {
  draft: CampaignDraft;
  setDraft: (updater: (d: CampaignDraft) => CampaignDraft) => void;
  error: string | null;
  productMeta: Record<string, BrowseItemMeta>;
  collectionMeta: Record<string, BrowseItemMeta>;
  onCancel: () => void;
}) {
  const { draft, setDraft } = props;
  const tpl = campaignTemplate(draft.templateType);
  const [browseProducts, setBrowseProducts] = useState(false);
  const [browseCollections, setBrowseCollections] = useState(false);
  const [extraMeta, setExtraMeta] = useState<Record<string, BrowseItemMeta>>({});

  const meta = (id: string): BrowseItemMeta | undefined =>
    extraMeta[id] ?? props.productMeta[id] ?? props.collectionMeta[id];

  const setTrigger = (patch: Partial<CampaignSettingsData["trigger"]>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, trigger: { ...d.settings.trigger, ...patch } } }));
  const setSettings = (patch: Partial<CampaignSettingsData>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } }));

  const togglePageType = (value: CampaignSettingsData["trigger"]["pageTypes"][number]) => {
    const current = draft.settings.trigger.pageTypes;
    let next: typeof current;
    if (value === "any") {
      next = ["any"];
    } else if (current.includes(value)) {
      next = current.filter((p) => p !== value);
      if (next.length === 0) next = ["any"];
    } else {
      next = [...current.filter((p) => p !== "any"), value];
    }
    setTrigger({ pageTypes: next });
  };

  // Mirrors the strict save-path rule (campaigns.server.ts): only relative
  // paths or http(s) links, and "Open a link" needs one.
  const ctaUrl = draft.settings.ctaUrl;
  const ctaUrlError =
    draft.settings.ctaAction !== "link"
      ? undefined
      : ctaUrl.trim() === ""
        ? "Add the link the button should open"
        : /^(\/|https?:\/\/)/i.test(ctaUrl)
          ? undefined
          : "Link URL must start with / or http(s)://";

  const showCartFields = isCartTemplate(draft.templateType) || draft.settings.trigger.pageTypes.includes("cart");
  const showDiscountCode = draft.templateType === "cart_booster" || draft.settings.ctaAction === "apply_code";

  const pickedList = (ids: string[], remove: (id: string) => void) => (
    <div>
      {ids.map((id) => {
        const m = meta(id);
        return (
          <div
            key={id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 0",
              borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
            }}
          >
            <BrowseThumb imageUrl={m?.imageUrl ?? null} title={m?.title ?? "Item"} />
            <span style={{ flex: 1, fontSize: 13 }}>{m?.title ?? "Unavailable item"}</span>
            <s-button
              icon="x"
              variant="tertiary"
              accessibilityLabel={`Remove ${m?.title ?? "item"}`}
              onClick={() => remove(id)}
            />
          </div>
        );
      })}
    </div>
  );

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button
          icon="chevron-left"
          variant="tertiary"
          accessibilityLabel="Back to campaigns"
          onClick={props.onCancel}
        />
        <s-heading>
          {draft.id ? "Edit campaign" : `New campaign — ${tpl?.name ?? draft.templateType}`}
        </s-heading>
      </s-stack>
    <s-section>
      <s-stack gap="base">
        {props.error ? (
          <s-banner tone="critical" heading="Couldn't save campaign">
            {props.error}
          </s-banner>
        ) : null}

        <s-text-field
          label="Name"
          value={draft.name}
          maxLength={100}
          onInput={(e) => {
            const name = e.currentTarget.value;
            setDraft((d) => ({ ...d, name }));
          }}
        />

        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack gap="small">
            <s-heading>Trigger</s-heading>
            <s-text tone="neutral">Show this message when all conditions match. Shown once per visitor session.</s-text>
            <s-stack gap="small">
              <s-text>Page types</s-text>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {PAGE_TYPES.map((p) => (
                  <s-checkbox
                    key={p.value}
                    label={p.label}
                    checked={draft.settings.trigger.pageTypes.includes(p.value)}
                    onChange={() => togglePageType(p.value)}
                  />
                ))}
              </div>
            </s-stack>
            <s-text-field
              label="URL contains (optional)"
              value={draft.settings.trigger.urlContains}
              maxLength={300}
              placeholder="/collections/sale"
              onInput={(e) => setTrigger({ urlContains: e.currentTarget.value })}
            />
            <s-number-field
              label="Delay (seconds)"
              value={String(draft.settings.trigger.delaySeconds)}
              min={0}
              max={300}
              onChange={(e) => {
                const n = Math.max(0, Math.min(300, Math.round(Number(e.currentTarget.value) || 0)));
                setTrigger({ delaySeconds: n });
              }}
            />
            <s-checkbox
              label="Exit intent (show when the cursor leaves toward the top of the page)"
              checked={draft.settings.trigger.exitIntent}
              onChange={(e) => setTrigger({ exitIntent: e.currentTarget.checked })}
            />
            {showCartFields ? (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <s-number-field
                  label="Cart has at least (items)"
                  value={String(draft.settings.trigger.cartMinItems)}
                  min={0}
                  onChange={(e) =>
                    setTrigger({ cartMinItems: Math.max(0, Math.round(Number(e.currentTarget.value) || 0)) })
                  }
                />
                <s-number-field
                  label="Cart value at least"
                  value={String(draft.settings.trigger.cartMinValue)}
                  min={0}
                  onChange={(e) => setTrigger({ cartMinValue: Math.max(0, Number(e.currentTarget.value) || 0) })}
                />
              </div>
            ) : null}
          </s-stack>
        </s-box>

        <s-text-area
          label="Message"
          details="Merge tags: {{customer_name}} — replaced with the logged-in customer's first name."
          rows={3}
          value={draft.settings.message}
          maxLength={500}
          onInput={(e) => setSettings({ message: e.currentTarget.value })}
        />

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <s-text-field
            label="Button label"
            value={draft.settings.ctaLabel}
            maxLength={60}
            onInput={(e) => setSettings({ ctaLabel: e.currentTarget.value })}
          />
          <s-select
            label="Button action"
            value={draft.settings.ctaAction}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setSettings({
                ctaAction: v === "apply_code" ? "apply_code" : v === "link" ? "link" : "open_chat",
              });
            }}
          >
            <s-option value="open_chat">Open chat</s-option>
            <s-option value="apply_code">Apply discount code</s-option>
            <s-option value="link">Open a link</s-option>
          </s-select>
          {draft.settings.ctaAction === "link" ? (
            <s-text-field
              label="Link URL"
              value={draft.settings.ctaUrl}
              maxLength={500}
              placeholder="/checkout"
              error={ctaUrlError}
              onInput={(e) => setSettings({ ctaUrl: e.currentTarget.value })}
            />
          ) : null}
        </div>

        {showDiscountCode ? (
          <s-text-field
            label="Discount code"
            details="Applied to the shopper's checkout when they tap the button."
            value={draft.settings.discountCode}
            maxLength={60}
            onInput={(e) => setSettings({ discountCode: e.currentTarget.value })}
          />
        ) : null}

        {usesProductPicker(draft.templateType) ? (
          <s-stack gap="small">
            <s-text>Recommended products (up to 3 shown)</s-text>
            {draft.settings.productIds.length === 0 ? (
              <s-text tone="neutral">No products selected yet.</s-text>
            ) : (
              pickedList(draft.settings.productIds, (id) =>
                setSettings({ productIds: draft.settings.productIds.filter((p) => p !== id) }),
              )
            )}
            <div>
              <s-button onClick={() => setBrowseProducts(true)}>Browse products</s-button>
            </div>
          </s-stack>
        ) : null}

        {usesCollectionPicker(draft.templateType) ? (
          <s-stack gap="small">
            <s-text>Collections</s-text>
            {draft.settings.collectionIds.length === 0 ? (
              <s-text tone="neutral">No collections selected yet.</s-text>
            ) : (
              pickedList(draft.settings.collectionIds, (id) =>
                setSettings({ collectionIds: draft.settings.collectionIds.filter((c) => c !== id) }),
              )
            )}
            <div>
              <s-button onClick={() => setBrowseCollections(true)}>Browse collections</s-button>
            </div>
          </s-stack>
        ) : null}

        <s-select
          label="Status"
          value={draft.status}
          onChange={(e) => {
            const status = e.currentTarget.value === "active" ? "active" : "inactive";
            setDraft((d) => ({ ...d, status }));
          }}
        >
          <s-option value="active">Active</s-option>
          <s-option value="inactive">Inactive</s-option>
        </s-select>

      </s-stack>

      <BrowseProductsModal
        open={browseProducts}
        onClose={() => setBrowseProducts(false)}
        selectedIds={draft.settings.productIds}
        onConfirm={(ids, newMeta) => {
          setSettings({ productIds: ids });
          if (newMeta) setExtraMeta((prev) => ({ ...prev, ...newMeta }));
          setBrowseProducts(false);
        }}
      />
      <BrowseCollectionsModal
        open={browseCollections}
        onClose={() => setBrowseCollections(false)}
        selectedIds={draft.settings.collectionIds}
        onConfirm={(ids, newMeta) => {
          setSettings({ collectionIds: ids });
          if (newMeta) setExtraMeta((prev) => ({ ...prev, ...newMeta }));
          setBrowseCollections(false);
        }}
      />
    </s-section>
    </s-stack>
  );
}
