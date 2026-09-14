import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
import type {
  CollectionMeta,
  InstructionsActionResult,
  ProductMeta,
  RecommendationRowData,
} from "../routes/app.ai-agent.instructions";
import { BrowseProductsModal, BrowseThumb, type BrowseItemMeta } from "./BrowseProductsModal";
import { BrowseCollectionsModal } from "./BrowseCollectionsModal";
import { ChipInput } from "./ChipInput";
import { SaveBar } from "./SaveBar";

// App recommendation detail (spec 08, design ai-agent.html #viewRec — merged
// rule): title, trigger-phrase chips, status, product AND
// collection pickers. A trigger fires two ways at runtime: whole message ≈
// phrase → instant answer with shuffled picks; phrase contained in a shopping
// message → the buy lane recommends from this rule's pool. Save upserts the
// row only — the runtime matcher (recommendation-match.server.ts) embeds
// trigger phrases lazily, keyed by a per-row fingerprint.

export function RecommendationDetail(props: {
  recommendation: RecommendationRowData | null; // null = create new
  productMeta: Record<string, ProductMeta>;
  collectionMeta: Record<string, CollectionMeta>;
  onClose: () => void;
}) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<InstructionsActionResult>();
  const existing = props.recommendation;

  const [title, setTitle] = useState(existing?.title ?? "");
  const [triggers, setTriggers] = useState<string[]>(existing?.triggerQuestions ?? []);
  const [status, setStatus] = useState(existing?.status ?? "active");
  const [productIds, setProductIds] = useState<string[]>(existing?.productIds ?? []);
  const [collectionIds, setCollectionIds] = useState<string[]>(existing?.collectionIds ?? []);
  // Products XOR collections via a source dropdown —
  // only the chosen source's picker renders. Both lists stay in local state so
  // switching back restores; the SAVE sends only the active source's ids.
  const [source, setSource] = useState<"products" | "collections">(
    (existing?.collectionIds?.length ?? 0) > 0 ? "collections" : "products",
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false);
  // Meta captured from the browse modals for items added this session.
  const [localMeta, setLocalMeta] = useState<Record<string, BrowseItemMeta>>({});

  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.intent !== "save-recommendation") return;
    if (fetcher.data.ok) {
      shopify.toast.show("Recommendation saved");
      props.onClose();
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const meta = (gid: string): BrowseItemMeta =>
    localMeta[gid] ?? props.productMeta[gid] ?? { title: "Unavailable product", imageUrl: null };
  const collectionLabel = (gid: string): string =>
    localMeta[gid]?.title ?? props.collectionMeta[gid]?.title ?? "Unavailable collection";

  // What a save would actually persist: the active source only.
  const effectiveProductIds = source === "products" ? productIds : [];
  const effectiveCollectionIds = source === "collections" ? collectionIds : [];

  const dirty =
    title !== (existing?.title ?? "") ||
    status !== (existing?.status ?? "active") ||
    JSON.stringify(triggers) !== JSON.stringify(existing?.triggerQuestions ?? []) ||
    JSON.stringify(effectiveProductIds) !== JSON.stringify(existing?.productIds ?? []) ||
    JSON.stringify(effectiveCollectionIds) !== JSON.stringify(existing?.collectionIds ?? []);

  const discard = () => {
    setTitle(existing?.title ?? "");
    setTriggers(existing?.triggerQuestions ?? []);
    setStatus(existing?.status ?? "active");
    setProductIds(existing?.productIds ?? []);
    setCollectionIds(existing?.collectionIds ?? []);
    setSource((existing?.collectionIds?.length ?? 0) > 0 ? "collections" : "products");
  };

  const save = () => {
    if (!title.trim()) {
      shopify.toast.show("Give the recommendation a title", { isError: true });
      return;
    }
    if (triggers.length === 0) {
      shopify.toast.show("Add at least one trigger phrase", { isError: true });
      return;
    }
    if (effectiveProductIds.length === 0 && effectiveCollectionIds.length === 0) {
      shopify.toast.show(
        source === "products" ? "Add at least one product" : "Add at least one collection",
        { isError: true },
      );
      return;
    }
    fetcher.submit(
      {
        intent: "save-recommendation",
        payload: JSON.stringify({
          ...(existing ? { id: existing.id } : {}),
          title: title.trim(),
          triggerQuestions: triggers,
          productIds: effectiveProductIds,
          collectionIds: effectiveCollectionIds,
          status,
        }),
      },
      { method: "post" },
    );
  };

  return (
    <s-page heading={existing ? existing.title : "New recommendation"}>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
      <s-stack gap="base">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <s-button
            icon="arrow-left"
            variant="tertiary"
            accessibilityLabel="Back to recommendations"
            onClick={props.onClose}
          >
            Product Recommendations
          </s-button>
          {triggers[0] ? (
            <s-text tone="neutral">Product recommendations for &quot;{triggers[0]}&quot;</s-text>
          ) : null}
        </div>

        <s-section heading="Recommendation details">
          <s-text-field
            label="Title"
            value={title}
            placeholder="e.g. Trending now"
            maxLength={100}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
          <ChipInput
            label="Trigger phrases"
            values={triggers}
            onChange={setTriggers}
            placeholder='e.g. "What are your best sellers?" or "wedding gift"'
            maxLength={150}
          />
          <s-text tone="neutral">
            A full question answers instantly when a shopper asks it. A short phrase
            (&quot;wedding gift&quot;, &quot;rakhi&quot;) also steers shopping results whenever it
            appears inside a request.
          </s-text>
          <s-select
            label="Status"
            value={status}
            onInput={(e) => setStatus(e.currentTarget.value)}
          >
            <s-option value="active">Active</s-option>
            <s-option value="inactive">Inactive</s-option>
          </s-select>
          <s-select
            label="Recommend from"
            details="Hand-picked products, or everything in chosen collections. Only the selected source is saved."
            value={source}
            onInput={(e) => setSource(e.currentTarget.value === "collections" ? "collections" : "products")}
          >
            <s-option value="products">Products</s-option>
            <s-option value="collections">Collections</s-option>
          </s-select>
        </s-section>

        {source === "products" ? (
        <s-section heading="Products">
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <s-button variant="primary" onClick={() => setPickerOpen(true)}>
              Add products
            </s-button>
          </div>
          {productIds.length === 0 ? (
            <s-text tone="neutral">
              No products yet. Add the products this recommendation should show.
            </s-text>
          ) : (
            <div>
              {productIds.map((gid) => {
                const m = meta(gid);
                return (
                  <div
                    key={gid}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 0",
                      borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                    }}
                  >
                    <BrowseThumb imageUrl={m.imageUrl} title={m.title} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
                      {m.title}
                    </span>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      accessibilityLabel={`Remove ${m.title}`}
                      onClick={() => setProductIds((prev) => prev.filter((id) => id !== gid))}
                    >
                      Remove
                    </s-button>
                  </div>
                );
              })}
            </div>
          )}
        </s-section>
        ) : (
        <s-section heading="Collections">
          <s-text tone="neutral">
            Every product in the chosen collections joins this rule automatically, and picks
            rotate so shoppers don&apos;t see the same products every time.
          </s-text>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <s-button variant="primary" onClick={() => setCollectionPickerOpen(true)}>
              Add collections
            </s-button>
          </div>
          {collectionIds.length === 0 ? (
            <s-text tone="neutral">No collections yet.</s-text>
          ) : (
            <div>
              {collectionIds.map((gid) => (
                <div
                  key={gid}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 0",
                    borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
                    {collectionLabel(gid)}
                    {props.collectionMeta[gid] ? (
                      <s-text tone="neutral"> · {props.collectionMeta[gid].productCount} products</s-text>
                    ) : null}
                  </span>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    accessibilityLabel={`Remove ${collectionLabel(gid)}`}
                    onClick={() => setCollectionIds((prev) => prev.filter((id) => id !== gid))}
                  >
                    Remove
                  </s-button>
                </div>
              ))}
            </div>
          )}
        </s-section>
        )}
      </s-stack>

      <BrowseProductsModal
        open={pickerOpen}
        selectedIds={productIds}
        // Mirrors recommendationSchema.productIds.max(100) (instructions/save.server.ts).
        maxSelected={100}
        onClose={() => setPickerOpen(false)}
        onConfirm={(ids, newMeta) => {
          setProductIds(ids);
          if (newMeta) setLocalMeta((prev) => ({ ...prev, ...newMeta }));
          setPickerOpen(false);
        }}
      />
      <BrowseCollectionsModal
        open={collectionPickerOpen}
        selectedIds={collectionIds}
        onClose={() => setCollectionPickerOpen(false)}
        onConfirm={(ids, newMeta) => {
          setCollectionIds(ids);
          if (newMeta) setLocalMeta((prev) => ({ ...prev, ...newMeta }));
          setCollectionPickerOpen(false);
        }}
      />
    </s-page>
  );
}
