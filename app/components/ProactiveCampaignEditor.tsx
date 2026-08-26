import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { CampaignSettingsData } from "../lib/settings/schemas";
import { campaignTemplate } from "../lib/campaigns/templates";
import { countryOptions } from "../lib/format/countries";
import type { BrowseItemMeta } from "./BrowseProductsModal";
import { BrowseProductsModal, BrowseThumb } from "./BrowseProductsModal";
import { BrowseCollectionsModal } from "./BrowseCollectionsModal";
import { ProactiveMessageCard } from "./ProactiveMessageCard";
import { ProactiveAppearanceCard } from "./ProactiveAppearanceCard";
import { ProactiveCampaignPreview } from "./ProactiveCampaignPreview";
import { RadioGroup, RadioOption } from "./ui/RadioOption";
import { INK, RADIUS, SPACE } from "./ui/tokens";

// Proactive-chat campaign editor (spec 12).
// Layout and every control mirror the design reference in
// .claude/resources/proactive_chat/*.png: an Activate card across the top,
// then a two-column body — General / Trigger / Conditions / Message /
// Appearance on the left, live Message Preview + a read-only summary on the
// right. Which trigger and message controls appear is declared per template in
// lib/campaigns/templates.ts, so all ten templates share this one screen.

export interface CampaignDraft {
  id: string | null;
  templateType: string;
  name: string;
  status: "active" | "inactive";
  settings: CampaignSettingsData;
}

export interface DiscountOption {
  code: string;
  summary: string;
}

/** Collapsible section card with the design's chevron affordance. */
function SectionCard(props: {
  heading: string;
  children: ReactNode;
  /** Omit to render a plain, always-open card (Message / Appearance). */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (!props.collapsible) {
    return <s-section heading={props.heading}>{props.children}</s-section>;
  }
  return (
    <s-section>
      <s-stack gap="base">
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm }}
        >
          <s-heading>{props.heading}</s-heading>
          <s-button
            icon={open ? "chevron-up" : "chevron-down"}
            variant="tertiary"
            accessibilityLabel={`${open ? "Collapse" : "Expand"} ${props.heading}`}
            onClick={() => setOpen((v) => !v)}
          />
        </div>
        {open ? props.children : null}
      </s-stack>
    </s-section>
  );
}

/** Picked-item list shared by the product and collection scope pickers. */
function PickedList(props: {
  ids: string[];
  meta: (id: string) => BrowseItemMeta | undefined;
  onRemove: (id: string) => void;
}) {
  if (props.ids.length === 0) return null;
  return (
    <div>
      {props.ids.map((id) => {
        const m = props.meta(id);
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
              onClick={() => props.onRemove(id)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ProactiveCampaignEditor(props: {
  draft: CampaignDraft;
  setDraft: (updater: (d: CampaignDraft) => CampaignDraft) => void;
  error: string | null;
  productMeta: Record<string, BrowseItemMeta>;
  collectionMeta: Record<string, BrowseItemMeta>;
  /** Discount codes synced from the shop (Message → Discount). */
  discounts: DiscountOption[];
  currency: string;
  /** Chatbox conversation starters — the Text "Quick question" chips. */
  starters: { label: string }[];
  /** Pro+ gates: premium templates, Product Quiz, "similar products". */
  premiumAllowed: boolean;
  rendererJs: string;
  widgetCss: string;
  onCancel: () => void;
}) {
  const { draft, setDraft } = props;
  const tpl = campaignTemplate(draft.templateType);
  const [browseScopeProducts, setBrowseScopeProducts] = useState(false);
  const [browseScopeCollections, setBrowseScopeCollections] = useState(false);
  const [extraMeta, setExtraMeta] = useState<Record<string, BrowseItemMeta>>({});
  const [countryQuery, setCountryQuery] = useState("");

  const meta = (id: string): BrowseItemMeta | undefined =>
    extraMeta[id] ?? props.productMeta[id] ?? props.collectionMeta[id];

  const trigger = draft.settings.trigger;
  const conditions = draft.settings.conditions;

  const setTrigger = (patch: Partial<CampaignSettingsData["trigger"]>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, trigger: { ...d.settings.trigger, ...patch } } }));
  const setConditions = (patch: Partial<CampaignSettingsData["conditions"]>) =>
    setDraft((d) => ({
      ...d,
      settings: { ...d.settings, conditions: { ...d.settings.conditions, ...patch } },
    }));

  // Memoised: the preview re-renders the bubble whenever this reference
  // changes, and a fresh object literal every render would rebuild it on every
  // keystroke in the editor.
  const previewMeta = useMemo(
    () => ({ ...props.productMeta, ...extraMeta }),
    [props.productMeta, extraMeta],
  );

  const countries = useMemo(() => countryOptions(), []);
  const filteredCountries = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    if (!q) return countries.slice(0, 12);
    return countries.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q).slice(0, 12);
  }, [countries, countryQuery]);

  // ── trigger: page scope ────────────────────────────────────────────────────
  const scopeOptions: { value: CampaignSettingsData["trigger"]["pageScope"]; label: string }[] =
    tpl?.scopeMode === "pages"
      ? [
          { value: "all_pages", label: "All pages" },
          { value: "specific_pages", label: "Specific pages" },
          { value: "all_product_pages", label: "All product pages" },
          { value: "specific_product_pages", label: "Specific product pages" },
        ]
      : tpl?.scopeMode === "product"
        ? [
            { value: "all_product_pages", label: "All product pages" },
            { value: "specific_product_pages", label: "Specific product pages" },
          ]
        : tpl?.scopeMode === "collection"
          ? [
              { value: "all_collection_pages", label: "All collection pages" },
              { value: "specific_collection_pages", label: "Specific collection pages" },
            ]
          : [];

  const scopeCard = scopeOptions.length ? (
    <s-stack gap="small">
      <s-text>Page to show</s-text>
      <s-stack gap="small-300">
        {scopeOptions.map((option) => (
          <RadioOption
            key={option.value}
            name="campaign-page-scope"
            value={option.value}
            selected={trigger.pageScope}
            label={option.label}
            onSelect={(value) => setTrigger({ pageScope: value })}
          >
            {option.value === "specific_pages" ? (
              <s-text-field
                label="URL contains"
                details="Shown on every page whose address contains this fragment."
                value={trigger.urlContains}
                maxLength={300}
                placeholder="/collections/sale"
                onInput={(e) => setTrigger({ urlContains: e.currentTarget.value })}
              />
            ) : option.value === "specific_product_pages" ? (
              <s-stack gap="small">
                <PickedList
                  ids={trigger.pageProductIds}
                  meta={meta}
                  onRemove={(id) =>
                    setTrigger({ pageProductIds: trigger.pageProductIds.filter((p) => p !== id) })
                  }
                />
                {trigger.pageProductIds.length === 0 ? (
                  <s-text tone="neutral">No product pages selected yet.</s-text>
                ) : null}
                <div>
                  <s-button onClick={() => setBrowseScopeProducts(true)}>Browse products</s-button>
                </div>
              </s-stack>
            ) : option.value === "specific_collection_pages" ? (
              <s-stack gap="small">
                <PickedList
                  ids={trigger.pageCollectionIds}
                  meta={meta}
                  onRemove={(id) =>
                    setTrigger({ pageCollectionIds: trigger.pageCollectionIds.filter((c) => c !== id) })
                  }
                />
                {trigger.pageCollectionIds.length === 0 ? (
                  <s-text tone="neutral">No collection pages selected yet.</s-text>
                ) : null}
                <div>
                  <s-button onClick={() => setBrowseScopeCollections(true)}>Browse collections</s-button>
                </div>
              </s-stack>
            ) : null}
          </RadioOption>
        ))}
      </s-stack>
    </s-stack>
  ) : null;

  // ── trigger: timing ────────────────────────────────────────────────────────
  const secondsField = (
    <s-number-field
      label="Seconds"
      labelAccessibilityVisibility="exclusive"
      value={String(trigger.delaySeconds)}
      min={0}
      max={600}
      suffix="seconds"
      onInput={(e) =>
        setTrigger({ delaySeconds: Math.max(0, Math.min(600, Math.round(Number(e.currentTarget.value) || 0))) })
      }
    />
  );

  const timingCard =
    tpl?.timingMode === "exit_intent" ? (
      <s-stack gap="small">
        <s-text>Send message after</s-text>
        <s-text tone="neutral">
          The moment the shopper moves to close the tab or leave the page, while their cart still has items.
        </s-text>
      </s-stack>
    ) : tpl?.timingMode === "dwell" ? (
      <s-stack gap="small">
        <s-text>Send message after</s-text>
        <s-text tone="neutral">Visitor has viewed the page for</s-text>
        {secondsField}
      </s-stack>
    ) : (
      <s-stack gap="small">
        <s-text>Send message after</s-text>
        <s-stack gap="small-300">
          <RadioOption
            name="campaign-send-after"
            value="time"
            selected={trigger.sendAfter}
            label="Visitor has viewed the page for"
            onSelect={() => setTrigger({ sendAfter: "time" })}
          >
            {secondsField}
          </RadioOption>
          <RadioOption
            name="campaign-send-after"
            value="scroll"
            selected={trigger.sendAfter}
            label="Visitor has scrolled to a percentage of the page"
            onSelect={() => setTrigger({ sendAfter: "scroll" })}
          >
            <s-number-field
              label="Scroll depth"
              labelAccessibilityVisibility="exclusive"
              value={String(trigger.scrollPercent)}
              min={1}
              max={100}
              suffix="%"
              onInput={(e) =>
                setTrigger({
                  scrollPercent: Math.max(1, Math.min(100, Math.round(Number(e.currentTarget.value) || 1))),
                })
              }
            />
          </RadioOption>
        </s-stack>
      </s-stack>
    );

  const cartValueCard = tpl?.showCartValue ? (
    <s-stack gap="small">
      <s-number-field
        label="Minimum cart value"
        value={String(trigger.cartMinValue)}
        min={0}
        prefix={props.currency}
        onInput={(e) => setTrigger({ cartMinValue: Math.max(0, Number(e.currentTarget.value) || 0) })}
      />
      <s-number-field
        label="Maximum cart value"
        details="Leave empty for no upper limit."
        value={trigger.cartMaxValue === null ? "" : String(trigger.cartMaxValue)}
        min={0}
        prefix={props.currency}
        onInput={(e) => {
          const raw = e.currentTarget.value;
          setTrigger({ cartMaxValue: raw.trim() === "" ? null : Math.max(0, Number(raw) || 0) });
        }}
      />
    </s-stack>
  ) : null;

  const leftColumn = (
    <s-stack gap="base">
      {props.error ? (
        <s-banner tone="critical" heading="Couldn't save campaign">
          {props.error}
        </s-banner>
      ) : null}

      <SectionCard heading="General" collapsible>
        <s-text-field
          label="Name"
          details="Enter a name to identify this proactive chat (visible only to you)"
          value={draft.name}
          maxLength={100}
          onInput={(e) => {
            const name = e.currentTarget.value;
            setDraft((d) => ({ ...d, name }));
          }}
        />
      </SectionCard>

      <SectionCard heading="Trigger" collapsible>
        <s-stack gap="base">
          <s-text tone="neutral">{tpl?.triggerSummary}</s-text>
          {scopeCard}
          {cartValueCard}
          {timingCard}
        </s-stack>
      </SectionCard>

      <SectionCard heading="Conditions" collapsible>
        <s-stack gap="base">
          <s-stack gap="small">
            <s-text>Audience</s-text>
            <RadioGroup
              name="campaign-audience"
              selected={conditions.audience}
              onSelect={(audience) => setConditions({ audience })}
              options={[
                { value: "all", label: "All" },
                { value: "visitors", label: "Only visitors" },
                { value: "customers", label: "Only customers" },
              ]}
            />
          </s-stack>

          <s-stack gap="small">
            <s-text>Display time</s-text>
            <RadioGroup
              name="campaign-display-time"
              selected={conditions.displayTime}
              onSelect={(displayTime) => setConditions({ displayTime })}
              options={[
                { value: "all", label: "All time" },
                {
                  value: "business_hours",
                  label: "During business hour (including the time when agent is online if any)",
                },
              ]}
            />
          </s-stack>

          <s-stack gap="small">
            <s-text>Device</s-text>
            <RadioGroup
              name="campaign-device"
              selected={conditions.device}
              onSelect={(device) => setConditions({ device })}
              options={[
                { value: "all", label: "All" },
                { value: "desktop", label: "Desktop only" },
                { value: "mobile", label: "Mobile only" },
              ]}
            />
          </s-stack>

          <s-stack gap="small">
            <s-text>Display duration</s-text>
            <s-stack gap="small-300">
              <RadioOption
                name="campaign-duration"
                value="always"
                selected={conditions.displayDuration}
                label="Always"
                onSelect={() => setConditions({ displayDuration: "always" })}
              />
              <RadioOption
                name="campaign-duration"
                value="custom"
                selected={conditions.displayDuration}
                label="Custom"
                onSelect={() => setConditions({ displayDuration: "custom" })}
              >
                {/* s-date-field, not s-date-picker: two always-open calendars
                    would dwarf the condition rows. Values are ISO YYYY-MM-DD,
                    which is exactly what the save path validates. */}
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-date-field
                    label="Start date"
                    value={conditions.startDate}
                    onInput={(e) => setConditions({ startDate: e.currentTarget.value })}
                  />
                  <s-date-field
                    label="End date"
                    value={conditions.endDate}
                    onInput={(e) => setConditions({ endDate: e.currentTarget.value })}
                  />
                </s-grid>
              </RadioOption>
            </s-stack>
          </s-stack>

          <s-stack gap="small">
            <s-text>Countries</s-text>
            <s-stack gap="small-300">
              <RadioOption
                name="campaign-countries"
                value="all"
                selected={conditions.countryMode}
                label="All countries"
                onSelect={() => setConditions({ countryMode: "all" })}
              />
              <RadioOption
                name="campaign-countries"
                value="selected"
                selected={conditions.countryMode}
                label="Selected countries"
                onSelect={() => setConditions({ countryMode: "selected" })}
              >
                <s-stack gap="small">
                  {conditions.countries.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs + 2 }}>
                      {conditions.countries.map((code) => (
                        <span
                          key={code}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: SPACE.xs,
                            fontSize: 12,
                            fontWeight: 600,
                            padding: "3px 4px 3px 10px",
                            borderRadius: RADIUS.pill,
                            background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
                          }}
                        >
                          {countries.find((c) => c.code === code)?.name ?? code}
                          <s-button
                            icon="x"
                            variant="tertiary"
                            accessibilityLabel={`Remove ${code}`}
                            onClick={() =>
                              setConditions({ countries: conditions.countries.filter((c) => c !== code) })
                            }
                          />
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <s-search-field
                    label="Search countries"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search countries"
                    value={countryQuery}
                    onInput={(e) => setCountryQuery(e.currentTarget.value)}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs + 2 }}>
                    {filteredCountries
                      .filter((c) => !conditions.countries.includes(c.code))
                      .map((c) => (
                        <s-button
                          key={c.code}
                          variant="secondary"
                          onClick={() => setConditions({ countries: [...conditions.countries, c.code] })}
                        >
                          {c.name}
                        </s-button>
                      ))}
                  </div>
                </s-stack>
              </RadioOption>
            </s-stack>
          </s-stack>
        </s-stack>
      </SectionCard>

      <ProactiveMessageCard
        draft={draft}
        setDraft={setDraft}
        discounts={props.discounts}
        productMeta={props.productMeta}
        extraMeta={extraMeta}
        onExtraMeta={(m) => setExtraMeta((prev) => ({ ...prev, ...m }))}
        premiumAllowed={props.premiumAllowed}
      />

      <ProactiveAppearanceCard draft={draft} setDraft={setDraft} />
    </s-stack>
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
        <s-heading>{draft.id ? "Edit proactive chat" : "New proactive chat"}</s-heading>
      </s-stack>

      <s-section>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: SPACE.base,
          }}
        >
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-icon type="check-circle" />
            <s-text>Activate proactive chat</s-text>
          </s-stack>
          <s-switch
            label="Activate proactive chat"
            labelAccessibilityVisibility="exclusive"
            checked={draft.status === "active"}
            onInput={(e) =>
              setDraft((d) => ({ ...d, status: e.currentTarget.checked ? "active" : "inactive" }))
            }
          />
        </div>
      </s-section>

      <div className="cc-pc-grid">
        <style>{`
          .cc-pc-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:${SPACE.base}px;align-items:start;}
          .cc-pc-side{position:sticky;top:${SPACE.base}px;}
          @media (max-width: 1100px){
            .cc-pc-grid{grid-template-columns:minmax(0,1fr);}
            .cc-pc-side{position:static;}
          }
        `}</style>
        <div style={{ minWidth: 0 }}>{leftColumn}</div>
        <div className="cc-pc-side">
          <ProactiveCampaignPreview
            draft={draft}
            currency={props.currency}
            starters={props.starters}
            productMeta={previewMeta}
            rendererJs={props.rendererJs}
            widgetCss={props.widgetCss}
          />
        </div>
      </div>

      <BrowseProductsModal
        open={browseScopeProducts}
        onClose={() => setBrowseScopeProducts(false)}
        selectedIds={trigger.pageProductIds}
        onConfirm={(ids, newMeta) => {
          setTrigger({ pageProductIds: ids });
          if (newMeta) setExtraMeta((prev) => ({ ...prev, ...newMeta }));
          setBrowseScopeProducts(false);
        }}
      />
      <BrowseCollectionsModal
        open={browseScopeCollections}
        onClose={() => setBrowseScopeCollections(false)}
        selectedIds={trigger.pageCollectionIds}
        onConfirm={(ids, newMeta) => {
          setTrigger({ pageCollectionIds: ids });
          if (newMeta) setExtraMeta((prev) => ({ ...prev, ...newMeta }));
          setBrowseScopeCollections(false);
        }}
      />
    </s-stack>
  );
}
