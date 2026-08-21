import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
import type {
  InstructionsActionResult,
  ProductMeta,
  RecommendationRowData,
} from "../routes/app.ai-agent.instructions";
import { BrowseProductsModal, BrowseThumb, type BrowseItemMeta } from "./BrowseProductsModal";
import { ChipInput } from "./ChipInput";
import { SaveBar } from "./SaveBar";

// App recommendation detail (spec 08, design ai-agent.html #viewRec): title,
// trigger-question chips, status, product picker. Save upserts the row only —
// the runtime matcher (app/lib/search/recommendation-match.server.ts) embeds
// trigger questions lazily, keyed by a per-row trigger fingerprint, so no
// embedding write happens here.

export function RecommendationDetail(props: {
  recommendation: RecommendationRowData | null; // null = create new
  productMeta: Record<string, ProductMeta>;
  onClose: () => void;
}) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<InstructionsActionResult>();
  const existing = props.recommendation;

  const [title, setTitle] = useState(existing?.title ?? "");
  const [triggers, setTriggers] = useState<string[]>(existing?.triggerQuestions ?? []);
  const [status, setStatus] = useState(existing?.status ?? "active");
  const [productIds, setProductIds] = useState<string[]>(existing?.productIds ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Meta captured from the browse modal for products added this session.
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

  const dirty =
    title !== (existing?.title ?? "") ||
    status !== (existing?.status ?? "active") ||
    JSON.stringify(triggers) !== JSON.stringify(existing?.triggerQuestions ?? []) ||
    JSON.stringify(productIds) !== JSON.stringify(existing?.productIds ?? []);

  const discard = () => {
    setTitle(existing?.title ?? "");
    setTriggers(existing?.triggerQuestions ?? []);
    setStatus(existing?.status ?? "active");
    setProductIds(existing?.productIds ?? []);
  };

  const save = () => {
    if (!title.trim()) {
      shopify.toast.show("Give the recommendation a title", { isError: true });
      return;
    }
    if (triggers.length === 0) {
      shopify.toast.show("Add at least one trigger question", { isError: true });
      return;
    }
    fetcher.submit(
      {
        intent: "save-recommendation",
        payload: JSON.stringify({
          ...(existing ? { id: existing.id } : {}),
          title: title.trim(),
          triggerQuestions: triggers,
          productIds,
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
            Recommendations
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
            label="Trigger questions"
            values={triggers}
            onChange={setTriggers}
            placeholder="e.g. What are your best sellers?"
            maxLength={150}
          />
          <s-select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
          >
            <s-option value="active">Active</s-option>
            <s-option value="inactive">Inactive</s-option>
          </s-select>
        </s-section>

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
      </s-stack>

      <BrowseProductsModal
        open={pickerOpen}
        selectedIds={productIds}
        // Mirrors recommendationSchema.productIds.max(50) (instructions/save.server.ts).
        maxSelected={50}
        onClose={() => setPickerOpen(false)}
        onConfirm={(ids, newMeta) => {
          setProductIds(ids);
          if (newMeta) setLocalMeta((prev) => ({ ...prev, ...newMeta }));
          setPickerOpen(false);
        }}
      />
    </s-page>
  );
}
