import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
import type {
  CrossSellPairRowData,
  CustomRecommendationRowData,
  InstructionsActionResult,
  ProductMeta,
  RecommendationRowData,
} from "../routes/app.ai-agent.instructions";
import { DataTable, type Column } from "./DataTable";
import { BrowseProductsModal, BrowseThumb, type BrowseItemMeta } from "./BrowseProductsModal";
import { useDateTime } from "../lib/format/context";

// Instructions → Product recommendations tab (spec 08, design #viewInstructions
// prod panel): Rules card, App recommendations table, Custom recommendations
// table, Cross-sell pairs. Detail views open via onOpenRec/onOpenCustom
// (?rec= / ?custom= search params on the route).
//
// Rules card deltas (spec 08 noted in the feature report):
// - "Never recommend out-of-stock" is functional (product decision 2026-08-10,
//   diverges from spec 08's always-on exclusion): stored in
//   shopSettings.recommendationRules, enforced across search + card assembly.
//   OFF lets unavailable products appear in recommendation cards.
// - "Push overstock" renders OFF + disabled — coming soon, no storage in v1.


export function InstructionsRecommendationsTab(props: {
  recommendations: RecommendationRowData[];
  customRecs: CustomRecommendationRowData[];
  pairs: CrossSellPairRowData[];
  productMeta: Record<string, ProductMeta>;
  rules: { excludeOutOfStock: boolean };
  onOpenRec: (id: string) => void;
  onOpenCustom: (id: string) => void;
}) {
  const dt = useDateTime();
  const shopify = useAppBridge();
  const fetcher = useFetcher<InstructionsActionResult>();
  const busy = fetcher.state !== "idle";

  // Cross-sell "Add pair" two-step picker: anchor first, then companions.
  const [pairStage, setPairStage] = useState<
    | { stage: "closed" }
    | { stage: "anchor" }
    | { stage: "companions"; anchorId: string; anchorMeta?: BrowseItemMeta }
  >({ stage: "closed" });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      const messages: Record<string, string> = {
        "save-rules": "Recommendation rules saved",
        "toggle-recommendation": "Recommendation updated",
        "delete-recommendation": "Recommendation deleted",
        "toggle-custom": "Custom recommendation updated",
        "delete-custom": "Custom recommendation deleted",
        "save-pair": "Cross-sell pair saved",
        "delete-pair": "Cross-sell pair removed",
      };
      const msg = messages[fetcher.data.intent];
      if (msg) shopify.toast.show(msg);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent: string, payload: unknown) =>
    fetcher.submit({ intent, payload: JSON.stringify(payload) }, { method: "post" });

  const recColumns: Column<RecommendationRowData>[] = [
    {
      key: "title",
      title: "Title",
      render: (row) => (
        <s-stack gap="small-500">
          <s-text type="strong">{row.title}</s-text>
          <s-text color="subdued">
            {row.triggerQuestions[0]
              ? `Product recommendations for "${row.triggerQuestions[0]}"`
              : "No trigger questions yet"}
          </s-text>
        </s-stack>
      ),
    },
    { key: "products", title: "Products", render: (row) => String(row.productIds.length) },
    { key: "modified", title: "Last modified", render: (row) => dt.dateTime(row.updatedAt) },
    {
      key: "status",
      title: "Status",
      render: (row) => (
        <s-switch
          label={`${row.title} status`}
          labelAccessibilityVisibility="exclusive"
          checked={row.status === "active"}
          disabled={busy}
          onChange={(e) =>
            submit("toggle-recommendation", {
              id: row.id,
              status: e.currentTarget.checked ? "active" : "inactive",
            })
          }
        />
      ),
    },
    {
      key: "actions",
      title: "Actions",
      align: "end",
      render: (row) => (
        <s-stack direction="inline" gap="small-300" justifyContent="end">
          <s-button variant="tertiary" icon="edit" accessibilityLabel={`Edit ${row.title}`} onClick={() => props.onOpenRec(row.id)}>
            Edit
          </s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            accessibilityLabel={`Delete ${row.title}`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete recommendation "${row.title}"?`)) {
                submit("delete-recommendation", { id: row.id });
              }
            }}
          >
            Delete
          </s-button>
        </s-stack>
      ),
    },
  ];

  const customColumns: Column<CustomRecommendationRowData>[] = [
    {
      key: "title",
      title: "Title",
      render: (row) => (
        <s-stack gap="small-500">
          <s-text type="strong">{row.name}</s-text>
          <s-text color="subdued">
            {row.searchTerms.length
              ? `Triggers on: ${row.searchTerms.slice(0, 3).join(", ")}${row.searchTerms.length > 3 ? "…" : ""}`
              : "No search terms yet"}
          </s-text>
        </s-stack>
      ),
    },
    {
      key: "products",
      title: "Products",
      render: (row) =>
        row.collectionIds.length
          ? `${row.productIds.length} + ${row.collectionIds.length} collection${row.collectionIds.length === 1 ? "" : "s"}`
          : String(row.productIds.length),
    },
    { key: "modified", title: "Last modified", render: (row) => dt.dateTime(row.updatedAt) },
    {
      key: "status",
      title: "Status",
      render: (row) => (
        <s-switch
          label={`${row.name} status`}
          labelAccessibilityVisibility="exclusive"
          checked={row.status === "active"}
          disabled={busy}
          onChange={(e) =>
            submit("toggle-custom", {
              id: row.id,
              status: e.currentTarget.checked ? "active" : "inactive",
            })
          }
        />
      ),
    },
    {
      key: "actions",
      title: "Actions",
      align: "end",
      render: (row) => (
        <s-stack direction="inline" gap="small-300" justifyContent="end">
          <s-button variant="tertiary" icon="edit" accessibilityLabel={`Edit ${row.name}`} onClick={() => props.onOpenCustom(row.id)}>
            Edit
          </s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            accessibilityLabel={`Delete ${row.name}`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete custom recommendation "${row.name}"?`)) {
                submit("delete-custom", { id: row.id });
              }
            }}
          >
            Delete
          </s-button>
        </s-stack>
      ),
    },
  ];

  const productTitle = (gid: string) => props.productMeta[gid]?.title ?? "Unavailable product";

  return (
    <s-stack gap="base">
      <s-section heading="Rules">
        <s-stack gap="base">
          <s-paragraph color="subdued">How the AI recommends by default.</s-paragraph>
          <s-switch
            label="Never recommend out-of-stock items"
            details="When off, unavailable products can appear in recommendations."
            checked={props.rules.excludeOutOfStock}
            disabled={busy}
            onChange={(e) => submit("save-rules", { excludeOutOfStock: e.currentTarget.checked })}
          />
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-switch
              label="Push overstock"
              details="Favor the products you're holding the most stock of, so high-inventory items sell through first."
              checked={false}
              disabled
            />
            <s-badge tone="neutral">Coming soon</s-badge>
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="App recommendations">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Pre-configured recommendations that automatically respond to common customer intents.
          </s-paragraph>
          <DataTable
            columns={recColumns}
            rows={props.recommendations}
            onRowClick={(row) => props.onOpenRec(row.id)}
            emptyMessage="No app recommendations yet. Add one to answer common intents deterministically."
            toolbar={
              <s-button variant="primary" icon="plus" onClick={() => props.onOpenRec("new")}>
                Add new
              </s-button>
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Custom recommendations">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Create custom recommendation rules for specific use cases like gifts, occasions, or
            seasonal campaigns.
          </s-paragraph>
          <DataTable
            columns={customColumns}
            rows={props.customRecs}
            onRowClick={(row) => props.onOpenCustom(row.id)}
            emptyMessage="No custom recommendations yet. Add one for occasions like gifts or seasonal campaigns."
            toolbar={
              <s-button variant="primary" icon="plus" onClick={() => props.onOpenCustom("new")}>
                Add new
              </s-button>
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Cross-sell pairs">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-paragraph color="subdued">
              When recommending a specific product, also suggest its companions — e.g. a tent →
              sleeping bag.
            </s-paragraph>
            <s-button icon="plus" onClick={() => setPairStage({ stage: "anchor" })}>
              Add pair
            </s-button>
          </s-grid>
          {props.pairs.length === 0 ? (
            <s-text color="subdued">No pairs yet. Add one to attach companions to a product.</s-text>
          ) : (
            <s-stack gap="small-200">
              {props.pairs.map((pair) => (
                <s-stack key={pair.id} gap="small-200">
                  <s-grid gridTemplateColumns="auto 1fr auto" gap="small-200" alignItems="center">
                    <BrowseThumb
                      imageUrl={props.productMeta[pair.productId]?.imageUrl ?? null}
                      title={productTitle(pair.productId)}
                    />
                    <s-stack gap="small-500">
                      <s-stack direction="inline" gap="small-300" alignItems="center">
                        <s-text type="strong">{productTitle(pair.productId)}</s-text>
                        <s-icon type="arrow-right" size="small" tone="neutral" />
                        <s-text>
                          {pair.companionIds.length} companion
                          {pair.companionIds.length === 1 ? "" : "s"}
                        </s-text>
                      </s-stack>
                      <s-text color="subdued">
                        {pair.companionIds.map((id) => productTitle(id)).join(", ")}
                      </s-text>
                    </s-stack>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      icon="delete"
                      accessibilityLabel={`Remove pair for ${productTitle(pair.productId)}`}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("Remove this cross-sell pair?")) {
                          submit("delete-pair", { id: pair.id });
                        }
                      }}
                    />
                  </s-grid>
                  <s-divider />
                </s-stack>
              ))}
            </s-stack>
          )}
          {pairStage.stage === "anchor" ? (
            <s-banner tone="info">
              Step 1 of 2 — pick the anchor product (the first selected product is used).
            </s-banner>
          ) : null}
          {pairStage.stage === "companions" ? (
            <s-banner tone="info">
              Step 2 of 2 — pick companion products for{" "}
              {pairStage.anchorMeta?.title ?? productTitle(pairStage.anchorId)}.
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>

      <BrowseProductsModal
        open={pairStage.stage === "anchor"}
        selectedIds={[]}
        onClose={() => setPairStage({ stage: "closed" })}
        onConfirm={(ids, meta) => {
          const anchorId = ids[0];
          if (!anchorId) {
            setPairStage({ stage: "closed" });
            return;
          }
          setPairStage({ stage: "companions", anchorId, anchorMeta: meta?.[anchorId] });
        }}
      />
      <BrowseProductsModal
        open={pairStage.stage === "companions"}
        selectedIds={[]}
        onClose={() => setPairStage({ stage: "closed" })}
        onConfirm={(ids) => {
          if (pairStage.stage !== "companions") return;
          const companionIds = ids.filter((id) => id !== pairStage.anchorId);
          if (companionIds.length === 0) {
            shopify.toast.show("Pick at least one companion product", { isError: true });
            return;
          }
          submit("save-pair", { productId: pairStage.anchorId, companionIds });
          setPairStage({ stage: "closed" });
        }}
      />
    </s-stack>
  );
}
