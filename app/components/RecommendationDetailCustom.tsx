import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type {
  CollectionMeta,
  CustomRecommendationRowData,
  InstructionsActionResult,
  ProductMeta,
} from "../routes/app.ai-agent.instructions";
import { BrowseProductsModal, BrowseThumb, type BrowseItemMeta } from "./BrowseProductsModal";
import { BrowseCollectionsModal } from "./BrowseCollectionsModal";
import { SaveBar } from "./SaveBar";

// Custom recommendation detail (spec 08, design ai-agent.html #viewCustomRec):
// search-term rows (min 1) + View-examples panel, Add by Product / Add by
// Collection with expandable selected lists. Persists config only — the
// runtime constraint/boost lands with a pipeline enhancement (spec delta).

const EXAMPLE_TERMS = ["wedding gift", "mother's day", "graduation", "valentine", "christmas"];

export function RecommendationDetailCustom(props: {
  recommendation: CustomRecommendationRowData | null; // null = create new
  productMeta: Record<string, ProductMeta>;
  collectionMeta: Record<string, CollectionMeta>;
  onClose: () => void;
}) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<InstructionsActionResult>();
  const existing = props.recommendation;

  const [name, setName] = useState(existing?.name ?? "");
  const [terms, setTerms] = useState<string[]>(
    existing?.searchTerms.length ? existing.searchTerms : [""],
  );
  const [status, setStatus] = useState(existing?.status ?? "inactive");
  const [productIds, setProductIds] = useState<string[]>(existing?.productIds ?? []);
  const [collectionIds, setCollectionIds] = useState<string[]>(existing?.collectionIds ?? []);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [productsExpanded, setProductsExpanded] = useState(false);
  const [collectionsExpanded, setCollectionsExpanded] = useState(false);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false);
  const [localMeta, setLocalMeta] = useState<Record<string, BrowseItemMeta>>({});

  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.intent !== "save-custom") return;
    if (fetcher.data.ok) {
      shopify.toast.show("Custom recommendation saved");
      props.onClose();
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const productLabel = (gid: string): BrowseItemMeta =>
    localMeta[gid] ?? props.productMeta[gid] ?? { title: "Unavailable product", imageUrl: null };
  const collectionLabel = (gid: string): string =>
    localMeta[gid]?.title ?? props.collectionMeta[gid]?.title ?? "Unavailable collection";

  const setTerm = (index: number, value: string) =>
    setTerms((prev) => prev.map((t, i) => (i === index ? value : t)));

  const initialTerms = existing?.searchTerms.length ? existing.searchTerms : [""];
  const dirty =
    name !== (existing?.name ?? "") ||
    status !== (existing?.status ?? "inactive") ||
    JSON.stringify(terms) !== JSON.stringify(initialTerms) ||
    JSON.stringify(productIds) !== JSON.stringify(existing?.productIds ?? []) ||
    JSON.stringify(collectionIds) !== JSON.stringify(existing?.collectionIds ?? []);

  const discard = () => {
    setName(existing?.name ?? "");
    setTerms(initialTerms);
    setStatus(existing?.status ?? "inactive");
    setProductIds(existing?.productIds ?? []);
    setCollectionIds(existing?.collectionIds ?? []);
  };

  const fillExample = (term: string) => {
    setTerms((prev) => {
      if (prev.some((t) => t.trim().toLowerCase() === term)) return prev;
      const emptyIndex = prev.findIndex((t) => !t.trim());
      if (emptyIndex >= 0) return prev.map((t, i) => (i === emptyIndex ? term : t));
      return [...prev, term];
    });
  };

  const save = () => {
    const cleanTerms = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
    if (!name.trim()) {
      shopify.toast.show("Give the recommendation a title", { isError: true });
      return;
    }
    if (cleanTerms.length === 0) {
      shopify.toast.show("Add at least one search term", { isError: true });
      return;
    }
    if (productIds.length === 0 && collectionIds.length === 0) {
      shopify.toast.show("Add at least one product or collection", { isError: true });
      return;
    }
    fetcher.submit(
      {
        intent: "save-custom",
        payload: JSON.stringify({
          ...(existing ? { id: existing.id } : {}),
          name: name.trim(),
          searchTerms: cleanTerms,
          productIds,
          collectionIds,
          status,
        }),
      },
      { method: "post" },
    );
  };

  return (
    <s-page heading={existing ? existing.name : "New custom recommendation"}>
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
        </div>

        <s-section heading="Details">
          <s-text-field
            label="Title"
            value={name}
            placeholder="e.g. Special occasions"
            maxLength={100}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <s-select label="Status" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            <s-option value="active">Active</s-option>
            <s-option value="inactive">Inactive</s-option>
          </s-select>
        </s-section>

        <s-section heading="Search terms">
          <s-paragraph>
            When customers mention these terms, ChatConvert will suggest products from this
            recommendation
          </s-paragraph>
          <s-stack gap="small">
            {terms.map((term, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={index} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={term}
                  maxLength={100}
                  placeholder="e.g. wedding gift"
                  aria-label={`Search term ${index + 1}`}
                  onChange={(e) => setTerm(index, e.currentTarget.value)}
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--s-color-border, #d4d4d4)",
                    font: "inherit",
                  }}
                />
                <s-button
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel={`Delete search term ${index + 1}`}
                  disabled={terms.length <= 1}
                  onClick={() => setTerms((prev) => prev.filter((_, i) => i !== index))}
                >
                  Delete
                </s-button>
              </div>
            ))}
          </s-stack>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <s-button onClick={() => setTerms((prev) => [...prev, ""])}>Add search term</s-button>
            <s-button variant="tertiary" onClick={() => setExamplesOpen((v) => !v)}>
              {examplesOpen ? "Hide examples" : "View examples"}
            </s-button>
          </div>
          {examplesOpen ? (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="small">
                <s-heading>Best practices</s-heading>
                <s-unordered-list>
                  <s-list-item>
                    Include specific holidays (Christmas, Valentine&apos;s, Mother&apos;s Day)
                  </s-list-item>
                  <s-list-item>Add occasion types (wedding, graduation, anniversary)</s-list-item>
                  <s-list-item>
                    Consider recipient types (mom, dad, boyfriend, girlfriend)
                  </s-list-item>
                </s-unordered-list>
                <s-heading>Example terms</s-heading>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {EXAMPLE_TERMS.map((term) => (
                    <button
                      key={term}
                      type="button"
                      onClick={() => fillExample(term)}
                      style={{
                        cursor: "pointer",
                        font: "inherit",
                        fontSize: 12.5,
                        padding: "3px 10px",
                        borderRadius: 999,
                        border: "1px solid var(--s-color-border, #d4d4d4)",
                        background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
                      }}
                    >
                      {term}
                    </button>
                  ))}
                </div>
              </s-stack>
            </s-box>
          ) : null}
        </s-section>

        <s-section heading="Products conditions">
          <s-paragraph>
            Select which products ChatConvert should recommend when these terms are triggered
          </s-paragraph>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 14,
            }}
          >
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="small">
                <s-heading>Add by Product</s-heading>
                <s-text tone="neutral">
                  Choose individual products to include in recommendations
                </s-text>
                <div>
                  <s-button onClick={() => setProductPickerOpen(true)}>Browse products</s-button>
                </div>
                <button
                  type="button"
                  onClick={() => setProductsExpanded((v) => !v)}
                  style={{
                    border: "none",
                    background: "none",
                    padding: 0,
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 13,
                    fontWeight: 600,
                    textAlign: "left",
                  }}
                >
                  {productIds.length} product{productIds.length === 1 ? "" : "s"} selected{" "}
                  <s-icon
                    type={productsExpanded ? "chevron-up" : "chevron-down"}
                    size="small"
                  />
                </button>
                {productsExpanded && productIds.length > 0 ? (
                  <div>
                    {productIds.map((gid) => {
                      const m = productLabel(gid);
                      return (
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
                          <BrowseThumb imageUrl={m.imageUrl} title={m.title} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{m.title}</span>
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            accessibilityLabel={`Remove ${m.title}`}
                            onClick={() =>
                              setProductIds((prev) => prev.filter((id) => id !== gid))
                            }
                          >
                            Remove
                          </s-button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </s-stack>
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="small">
                <s-heading>Add by Collection</s-heading>
                <s-text tone="neutral">
                  Add all products from existing collections automatically
                </s-text>
                <div>
                  <s-button onClick={() => setCollectionPickerOpen(true)}>
                    Browse collections
                  </s-button>
                </div>
                <button
                  type="button"
                  onClick={() => setCollectionsExpanded((v) => !v)}
                  style={{
                    border: "none",
                    background: "none",
                    padding: 0,
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 13,
                    fontWeight: 600,
                    textAlign: "left",
                  }}
                >
                  {collectionIds.length} collection{collectionIds.length === 1 ? "" : "s"} selected{" "}
                  <s-icon
                    type={collectionsExpanded ? "chevron-up" : "chevron-down"}
                    size="small"
                  />
                </button>
                {collectionsExpanded && collectionIds.length > 0 ? (
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
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                          {collectionLabel(gid)}
                          {props.collectionMeta[gid] ? (
                            <s-text tone="neutral">
                              {" "}
                              · {props.collectionMeta[gid].productCount} products
                            </s-text>
                          ) : null}
                        </span>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          accessibilityLabel={`Remove ${collectionLabel(gid)}`}
                          onClick={() =>
                            setCollectionIds((prev) => prev.filter((id) => id !== gid))
                          }
                        >
                          Remove
                        </s-button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </s-stack>
            </s-box>
          </div>
        </s-section>
      </s-stack>

      <BrowseProductsModal
        open={productPickerOpen}
        selectedIds={productIds}
        onClose={() => setProductPickerOpen(false)}
        onConfirm={(ids, newMeta) => {
          setProductIds(ids);
          if (newMeta) setLocalMeta((prev) => ({ ...prev, ...newMeta }));
          setProductPickerOpen(false);
          setProductsExpanded(true);
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
          setCollectionsExpanded(true);
        }}
      />
    </s-page>
  );
}
