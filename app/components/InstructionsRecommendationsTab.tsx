import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
import type {
  CrossSellPairRowData,
  InstructionsActionResult,
  ProductMeta,
  RecommendationRowData,
} from "../routes/app.ai-agent.instructions";
import { DataTable, type Column } from "./DataTable";
import { BrowseProductsModal, BrowseThumb, type BrowseItemMeta } from "./BrowseProductsModal";
import { PlanMeter } from "./ui/PlanGate";
import { ConfirmDeleteModal } from "./ui/ConfirmDeleteModal";
import { useDateTime } from "../lib/format/context";

/** Line clamp for table cells — full text stays available on hover (title). */
const CLAMP: React.CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  overflowWrap: "anywhere",
};

// Instructions → Product recommendations tab (spec 08, design #viewInstructions
// prod panel): Rules card, ONE merged App recommendations table (the
// former Custom recommendations section folded in; a rule
// answers instantly on a whole-message match and steers shopping results when
// a trigger word appears inside a request, over products AND collections,
// with shuffled picks), Cross-sell pairs. Detail view opens via onOpenRec
// (?rec= search param on the route).
//
// Rules card deltas (spec 08 noted in the feature report):
// - "Never recommend out-of-stock" is functional (a product decision that
//   diverges from spec 08's always-on exclusion): stored in
//   shopSettings.recommendationRules, enforced across search + card assembly.
//   OFF lets unavailable products appear in recommendation cards.
// - "Cross-sell companions" toggle: every plan; OFF stops
//   companion products being appended to recommendation cards.


export function InstructionsRecommendationsTab(props: {
  recommendations: RecommendationRowData[];
  pairs: CrossSellPairRowData[];
  productMeta: Record<string, ProductMeta>;
  rules: { excludeOutOfStock: boolean; crossSellEnabled: boolean };
  /** How many recommendation rules this shop's plan allows (recommendation_rules quota). */
  recommendationQuota: number;
  /** Plan that raises the rules quota (null at the top tier) — the PlanMeter upgrade link. */
  recommendationNextPlan: string | null;
  onOpenRec: (id: string) => void;
}) {
  const dt = useDateTime();
  const shopify = useAppBridge();
  const fetcher = useFetcher<InstructionsActionResult>();
  const busy = fetcher.state !== "idle";

  // Cross-sell "Add pair" two-step picker: anchor first, then companions.
  // `anchorId` on the anchor stage is the pick to restore when coming Back.
  const [pairStage, setPairStage] = useState<
    | { stage: "closed" }
    | { stage: "anchor"; anchorId?: string }
    // viaAnchor: reached from step 1 (shows Back); a row's Edit opens step 2 alone.
    | { stage: "companions"; anchorId: string; anchorMeta?: BrowseItemMeta; viaAnchor?: boolean }
  >({ stage: "closed" });

  // Delete confirmation (shared ConfirmDeleteModal). Stays open with a spinner
  // while the delete runs; the effect below closes it when the result lands.
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "recommendation" | "pair";
    id: string;
    label: string;
  } | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.intent === "delete-recommendation" || fetcher.data.intent === "delete-pair") {
      setDeleteTarget(null);
    }
    if (fetcher.data.ok) {
      const messages: Record<string, string> = {
        "save-rules": "Recommendation rules saved",
        "toggle-recommendation": "Recommendation updated",
        "delete-recommendation": "Recommendation deleted",
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
            {row.triggerQuestions.length
              ? `Triggers on: ${row.triggerQuestions.slice(0, 3).join(", ")}${row.triggerQuestions.length > 3 ? "…" : ""}`
              : "No trigger phrases yet"}
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
          label={`${row.title} status`}
          labelAccessibilityVisibility="exclusive"
          checked={row.status === "active"}
          disabled={busy}
          onInput={(e) =>
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
        // Icon-only, matching the Cross-sell pairs table (user request
        // 2026-09-11 — the labeled buttons were the odd ones out).
        <s-stack direction="inline" gap="small-300" justifyContent="end">
          <s-button
            variant="tertiary"
            icon="edit"
            accessibilityLabel={`Edit ${row.title}`}
            onClick={() => props.onOpenRec(row.id)}
          />
          <s-button
            variant="tertiary"
            tone="critical"
            icon="delete"
            accessibilityLabel={`Delete ${row.title}`}
            disabled={busy}
            onClick={() => setDeleteTarget({ kind: "recommendation", id: row.id, label: row.title })}
          />
        </s-stack>
      ),
    },
  ];

  const productTitle = (gid: string) => props.productMeta[gid]?.title ?? "Unavailable product";

  const pairColumns: Column<CrossSellPairRowData>[] = [
    {
      key: "product",
      title: "Product",
      render: (pair) => (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <BrowseThumb
            imageUrl={props.productMeta[pair.productId]?.imageUrl ?? null}
            title={productTitle(pair.productId)}
          />
          <div title={productTitle(pair.productId)} style={{ ...CLAMP, WebkitLineClamp: 2, maxWidth: 240 }}>
            <s-text type="strong">{productTitle(pair.productId)}</s-text>
          </div>
        </s-stack>
      ),
    },
    {
      key: "companions",
      title: "Companions",
      render: (pair) => {
        const names = pair.companionIds.map((id) => productTitle(id)).join(", ");
        return (
          <s-stack gap="small-500">
            <s-text>
              {pair.companionIds.length} companion{pair.companionIds.length === 1 ? "" : "s"}
            </s-text>
            {/* One line, full list on hover — up to 20 names per pair. */}
            <div title={names} style={{ ...CLAMP, WebkitLineClamp: 1, maxWidth: 280 }}>
              <s-text color="subdued">{names}</s-text>
            </div>
          </s-stack>
        );
      },
    },
    { key: "modified", title: "Last modified", render: (pair) => dt.dateTime(pair.updatedAt) },
    {
      key: "actions",
      title: "Actions",
      align: "end",
      render: (pair) => (
        <s-stack direction="inline" gap="small-300" justifyContent="end">
          <s-button
            variant="tertiary"
            icon="edit"
            accessibilityLabel={`Edit companions for ${productTitle(pair.productId)}`}
            disabled={busy}
            onClick={() => setPairStage({ stage: "companions", anchorId: pair.productId })}
          />
          <s-button
            variant="tertiary"
            tone="critical"
            icon="delete"
            accessibilityLabel={`Remove pair for ${productTitle(pair.productId)}`}
            disabled={busy}
            onClick={() =>
              setDeleteTarget({ kind: "pair", id: pair.id, label: productTitle(pair.productId) })
            }
          />
        </s-stack>
      ),
    },
  ];

  // A product has at most one pair (saves upsert on shop + product), so picking
  // an anchor that already has one EDITS it: step 2 opens with its companions
  // ticked. Starting empty would have replaced them on save without a word.
  const companionStage = pairStage.stage === "companions" ? pairStage : null;
  const existingPair = companionStage
    ? props.pairs.find((p) => p.productId === companionStage.anchorId)
    : undefined;
  const anchorTitle = companionStage
    ? (companionStage.anchorMeta?.title ?? productTitle(companionStage.anchorId))
    : "";

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
            onInput={(e) =>
              submit("save-rules", { ...props.rules, excludeOutOfStock: e.currentTarget.checked })
            }
          />
          <s-switch
            label="Cross-sell companion products"
            details="When on, products from your cross-sell pairs are appended to recommendation cards."
            checked={props.rules.crossSellEnabled}
            disabled={busy}
            onInput={(e) =>
              submit("save-rules", { ...props.rules, crossSellEnabled: e.currentTarget.checked })
            }
          />
        </s-stack>
      </s-section>

      {/* Same layout as the FAQ tab: description
          left + Add button right, then the full-width PlanMeter row. */}
      <s-section heading="App recommendations">
        <s-stack gap="base">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <s-paragraph color="subdued">
                One rule does both jobs: when a shopper&apos;s message matches a trigger phrase,
                the products show instantly; when a trigger word appears inside a shopping
                request (&quot;wedding gift&quot;, &quot;new year&quot;), results come from this
                rule&apos;s products and collections.
              </s-paragraph>
            </div>
            <s-button
              variant="primary"
              icon="plus"
              disabled={props.recommendations.length >= props.recommendationQuota}
              onClick={() => props.onOpenRec("new")}
            >
              Add new
            </s-button>
          </div>
          <PlanMeter
            used={props.recommendations.length}
            quota={props.recommendationQuota}
            label="rules"
            nextPlan={props.recommendationNextPlan}
          />
          <DataTable
            columns={recColumns}
            rows={props.recommendations}
            onRowClick={(row) => props.onOpenRec(row.id)}
            emptyMessage="No recommendations yet. Add one for common questions or occasions like gifts and seasonal campaigns."
          />
        </s-stack>
      </s-section>

      {/* Same layout as the FAQ tab: description
          left + Add button right, then the full-width PlanMeter row. */}
      <s-section heading="Cross-sell pairs">
        <s-stack gap="base">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <s-paragraph color="subdued">
                When recommending a specific product, also suggest its companions — e.g. a tent →
                sleeping bag.
              </s-paragraph>
            </div>
            <s-button
              variant="primary"
              icon="plus"
              onClick={() => setPairStage({ stage: "anchor" })}
            >
              Add pair
            </s-button>
          </div>
          {/* No limit since 2026-09-11 — a count, not a meter; it sits at the
              LEFT of the table footer (user request 2026-09-11 — above the
              search it held too much vertical space). */}
          <DataTable
            columns={pairColumns}
            rows={props.pairs}
            perPage={10}
            footerStart={
              <s-text tone="neutral">
                {props.pairs.length} pair{props.pairs.length === 1 ? "" : "s"} added
              </s-text>
            }
            searchAlwaysOpen
            searchPlaceholder="Search pairs"
            searchFn={(pair, q) =>
              [pair.productId, ...pair.companionIds].some((id) =>
                productTitle(id).toLowerCase().includes(q),
              )
            }
            onRowClick={(pair) => setPairStage({ stage: "companions", anchorId: pair.productId })}
            emptyMessage="No pairs yet. Add one to attach companions to a product."
          />
        </s-stack>
      </s-section>

      {/* Step 1 — the product the pair belongs to. The modal titles carry the
          step, so no page banner (it sat behind the overlay, unseen). */}
      <BrowseProductsModal
        open={pairStage.stage === "anchor"}
        single
        title="Step 1 of 2 · Choose a product to pair"
        confirmLabel="Next"
        requireSelection
        selectedIds={pairStage.stage === "anchor" && pairStage.anchorId ? [pairStage.anchorId] : []}
        onClose={() => setPairStage({ stage: "closed" })}
        onConfirm={(ids, meta) => {
          const anchorId = ids[0];
          if (!anchorId) return;
          setPairStage({ stage: "companions", anchorId, anchorMeta: meta?.[anchorId], viaAnchor: true });
        }}
      />
      {/* Step 2 — its companions. Opened directly (no Back) from a row's Edit. */}
      <BrowseProductsModal
        open={pairStage.stage === "companions"}
        title={
          existingPair
            ? `Edit companions for ${anchorTitle}`
            : `Step 2 of 2 · Choose companions for ${anchorTitle}`
        }
        noun="companions"
        confirmLabel="Save pair"
        requireSelection
        selectedIds={existingPair?.companionIds ?? []}
        disabledIds={companionStage ? { [companionStage.anchorId]: "The product being paired" } : undefined}
        // Mirrors crossSellSchema.companionIds.max(20).
        maxSelected={20}
        onBack={
          companionStage?.viaAnchor
            ? () => setPairStage({ stage: "anchor", anchorId: companionStage.anchorId })
            : undefined
        }
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

      <ConfirmDeleteModal
        open={deleteTarget !== null}
        title={
          deleteTarget?.kind === "pair"
            ? `Remove the cross-sell pair for ${deleteTarget.label}?`
            : `Delete ${deleteTarget?.label || "this recommendation"}?`
        }
        body={
          deleteTarget?.kind === "pair"
            ? "Its companions will no longer be suggested with this product. This can't be undone."
            : "The AI stops using this rule immediately. This can't be undone."
        }
        confirmLabel={deleteTarget?.kind === "pair" ? "Remove pair" : "Delete"}
        loading={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          submit(deleteTarget.kind === "pair" ? "delete-pair" : "delete-recommendation", {
            id: deleteTarget.id,
          });
        }}
      />
    </s-stack>
  );
}
