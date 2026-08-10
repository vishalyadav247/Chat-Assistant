import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type {
  CrossSellPairRowData,
  CustomRecommendationRowData,
  InstructionsActionResult,
  ProductMeta,
  RecommendationRowData,
} from "../routes/app.ai-agent.instructions";
import { DataTable, type Column } from "./DataTable";
import { BrowseProductsModal, BrowseThumb, type BrowseItemMeta } from "./BrowseProductsModal";

// Instructions → Product recommendations tab (spec 08, design #viewInstructions
// prod panel): Rules card, App recommendations table, Custom recommendations
// table, Cross-sell pairs. Detail views open via onOpenRec/onOpenCustom
// (?rec= / ?custom= search params on the route).
//
// Rules card deltas (spec 08 noted in the feature report):
// - "Never recommend out-of-stock" renders ON + disabled — OOS exclusion is
//   hard-enforced in search SQL (stock > 0) and card assembly; the optional
//   substitution behaviour has no storage/runtime yet.
// - "Push overstock" renders OFF + disabled — coming soon, no storage in v1.

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function InstructionsRecommendationsTab(props: {
  recommendations: RecommendationRowData[];
  customRecs: CustomRecommendationRowData[];
  pairs: CrossSellPairRowData[];
  productMeta: Record<string, ProductMeta>;
  onOpenRec: (id: string) => void;
  onOpenCustom: (id: string) => void;
}) {
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
        <span>
          <button
            type="button"
            onClick={() => props.onOpenRec(row.id)}
            style={{
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
              font: "inherit",
              fontWeight: 600,
              textAlign: "left",
            }}
          >
            {row.title}
          </button>
          <span style={{ display: "block" }}>
            <s-text tone="neutral">
              {row.triggerQuestions[0]
                ? `Product recommendations for "${row.triggerQuestions[0]}"`
                : "No trigger questions yet"}
            </s-text>
          </span>
        </span>
      ),
    },
    { key: "products", title: "Products", render: (row) => String(row.productIds.length) },
    { key: "modified", title: "Last modified", render: (row) => formatDate(row.updatedAt) },
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
        <span style={{ display: "inline-flex", gap: 6 }}>
          <s-button variant="tertiary" accessibilityLabel={`Edit ${row.title}`} onClick={() => props.onOpenRec(row.id)}>
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
        </span>
      ),
    },
  ];

  const customColumns: Column<CustomRecommendationRowData>[] = [
    {
      key: "title",
      title: "Title",
      render: (row) => (
        <span>
          <button
            type="button"
            onClick={() => props.onOpenCustom(row.id)}
            style={{
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
              font: "inherit",
              fontWeight: 600,
              textAlign: "left",
            }}
          >
            {row.name}
          </button>
          <span style={{ display: "block" }}>
            <s-text tone="neutral">
              {row.searchTerms.length
                ? `Triggers on: ${row.searchTerms.slice(0, 3).join(", ")}${row.searchTerms.length > 3 ? "…" : ""}`
                : "No search terms yet"}
            </s-text>
          </span>
        </span>
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
    { key: "modified", title: "Last modified", render: (row) => formatDate(row.updatedAt) },
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
        <span style={{ display: "inline-flex", gap: 6 }}>
          <s-button variant="tertiary" accessibilityLabel={`Edit ${row.name}`} onClick={() => props.onOpenCustom(row.id)}>
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
        </span>
      ),
    },
  ];

  const productTitle = (gid: string) => props.productMeta[gid]?.title ?? "Unavailable product";

  return (
    <s-stack gap="base">
      <s-section heading="Rules">
        <s-paragraph>How the AI recommends by default.</s-paragraph>
        <div
          style={{ display: "flex", alignItems: "center", gap: 10 }}
          title="Always on — out-of-stock products are never recommended"
        >
          <s-switch
            label="Never recommend out-of-stock items"
            details="Out-of-stock products are always excluded from recommendations."
            checked
            disabled
          />
          <s-badge tone="success">Always on</s-badge>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <s-switch
            label="Push overstock"
            details="Favor the products you're holding the most stock of, so high-inventory items sell through first."
            checked={false}
            disabled
          />
          <s-badge tone="neutral">Coming soon</s-badge>
        </div>
      </s-section>

      <s-section heading="App recommendations">
        <s-paragraph>
          Pre-configured recommendations that automatically respond to common customer intents
        </s-paragraph>
        <DataTable
          columns={recColumns}
          rows={props.recommendations}
          emptyMessage="No app recommendations yet. Add one to answer common intents deterministically."
          toolbar={
            <s-button variant="primary" onClick={() => props.onOpenRec("new")}>
              Add new
            </s-button>
          }
        />
      </s-section>

      <s-section heading="Custom recommendations">
        <s-paragraph>
          Create custom recommendation rules for specific use cases like gifts, occasions, or
          seasonal campaigns
        </s-paragraph>
        <DataTable
          columns={customColumns}
          rows={props.customRecs}
          emptyMessage="No custom recommendations yet. Add one for occasions like gifts or seasonal campaigns."
          toolbar={
            <s-button variant="primary" onClick={() => props.onOpenCustom("new")}>
              Add new
            </s-button>
          }
        />
      </s-section>

      <s-section heading="Cross-sell pairs">
        <s-paragraph>
          When recommending a specific product, also suggest its companions — e.g. a tent → sleeping
          bag.
        </s-paragraph>
        <div>
          <s-button onClick={() => setPairStage({ stage: "anchor" })}>Add pair</s-button>
        </div>
        {props.pairs.length === 0 ? (
          <s-text tone="neutral">No pairs yet. Add one to attach companions to a product.</s-text>
        ) : (
          <s-stack gap="small">
            {props.pairs.map((pair) => (
              <div
                key={pair.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                }}
              >
                <BrowseThumb
                  imageUrl={props.productMeta[pair.productId]?.imageUrl ?? null}
                  title={productTitle(pair.productId)}
                />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                  <strong>{productTitle(pair.productId)}</strong>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      verticalAlign: "middle",
                      padding: "0 4px",
                    }}
                  >
                    <s-icon type="arrow-right" size="small" tone="neutral" />
                  </span>
                  {pair.companionIds.length} companion{pair.companionIds.length === 1 ? "" : "s"}
                  <span style={{ display: "block" }}>
                    <s-text tone="neutral">
                      {pair.companionIds.map((id) => productTitle(id)).join(", ")}
                    </s-text>
                  </span>
                </span>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel={`Remove pair for ${productTitle(pair.productId)}`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Remove this cross-sell pair?")) {
                      submit("delete-pair", { id: pair.id });
                    }
                  }}
                >
                  Delete
                </s-button>
              </div>
            ))}
          </s-stack>
        )}
        {pairStage.stage === "anchor" ? (
          <s-text tone="neutral">
            Step 1 of 2 — pick the anchor product (the first selected product is used).
          </s-text>
        ) : null}
        {pairStage.stage === "companions" ? (
          <s-text tone="neutral">
            Step 2 of 2 — pick companion products for{" "}
            {pairStage.anchorMeta?.title ?? productTitle(pairStage.anchorId)}.
          </s-text>
        ) : null}
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
