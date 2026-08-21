import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { BrowseData } from "../routes/app.browse-data";
import { SCROLLBAR_CSS } from "./ui/tokens";

// Shared "Browse products" picker (specs 08/09/12): search + Vendor/Tag/
// Collection filter chips + paginated table (10/page) served by the
// /app/browse-data resource route. Selection values are shopify product gids.
// Rendered as a controlled overlay (design ai-agent.html #mBrowse) — s-modal's
// imperative overlay API doesn't surface close events for controlled state.

export interface BrowseItemMeta {
  title: string;
  imageUrl: string | null;
}

/** Overlay shell shared with BrowseCollectionsModal. */
export function BrowseModalShell(props: {
  open: boolean;
  title: string;
  /** Small subdued text on the heading row, right after the title (e.g. "Last synced …"). */
  headerMeta?: React.ReactNode;
  /** Lock the dialog to its max height (85vh) so filtering/tab changes never resize it. */
  fixedHeight?: boolean;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);

  if (!props.open) return null;
  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 400,
        background: "rgba(20,20,25,.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        style={{
          background: "var(--s-color-bg, #fff)",
          borderRadius: 16,
          boxShadow: "0 6px 20px rgba(20,20,25,.2)",
          width: "100%",
          maxWidth: 640,
          maxHeight: "85vh",
          minHeight: props.fixedHeight ? "85vh" : undefined,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
          }}
        >
          <s-stack direction="inline" gap="base" alignItems="baseline">
            <s-heading>{props.title}</s-heading>
            {props.headerMeta ? <s-text color="subdued">{props.headerMeta}</s-text> : null}
          </s-stack>
          <s-button
            icon="x"
            variant="tertiary"
            accessibilityLabel="Close"
            onClick={props.onClose}
          />
        </div>
        {/* App-standard slim scrollbar (tokens.ts) — FAQ modal, product view,
            browse pickers all render through this shell. */}
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
        <div className="cc-scroll" style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {props.children}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 20px",
            borderTop: "1px solid var(--s-color-border, #e3e3e3)",
          }}
        >
          {props.footer}
        </div>
      </div>
    </div>
  );
}

export function BrowsePager(props: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const current = Math.min(props.page, pages);
  if (pages <= 1) return null;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 8 }}>
      <s-text tone="neutral">
        Page {current} / {pages}
      </s-text>
      <s-button variant="tertiary" disabled={current <= 1} onClick={() => props.onPage(current - 1)}>
        Prev
      </s-button>
      <s-button variant="tertiary" disabled={current >= pages} onClick={() => props.onPage(current + 1)}>
        Next
      </s-button>
    </div>
  );
}

export function BrowseThumb(props: { imageUrl: string | null; title: string }) {
  return props.imageUrl ? (
    <img
      src={props.imageUrl}
      alt={props.title}
      style={{ width: 36, height: 36, borderRadius: 8, objectFit: "cover", flex: "none" }}
    />
  ) : (
    <span
      aria-hidden="true"
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

export function BrowseProductsModal(props: {
  open: boolean;
  onClose: () => void;
  selectedIds: string[]; // shopify product gids
  /**
   * Server-side selection cap for the calling feature (curated answers 20, app
   * recommendations 50 …). Selecting past it is blocked here so the merchant
   * sees the limit while picking instead of a rejected save (QA D12a).
   */
  maxSelected?: number;
  onConfirm: (ids: string[], meta?: Record<string, BrowseItemMeta>) => void;
}) {
  const fetcher = useFetcher<BrowseData>();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [vendor, setVendor] = useState("");
  const [tag, setTag] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // gid → meta for every row seen while the modal is open, so the caller can
  // render thumbnails/titles for newly added products without a refetch.
  const seenMeta = useRef<Record<string, BrowseItemMeta>>({});

  const { open } = props;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setSelected(new Set(props.selectedIds));
      setQ("");
      setDebouncedQ("");
      setVendor("");
      setTag("");
      setCollectionId("");
      setPage(1);
    }
    wasOpen.current = open;
  }, [open, props.selectedIds]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = fetcher.load;
  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams({ kind: "products", page: String(page) });
    if (debouncedQ) params.set("q", debouncedQ);
    if (vendor) params.set("vendor", vendor);
    if (tag) params.set("tag", tag);
    if (collectionId) params.set("collectionId", collectionId);
    load(`/app/browse-data?${params.toString()}`);
  }, [open, debouncedQ, vendor, tag, collectionId, page, load]);

  const data = fetcher.data;
  useEffect(() => {
    for (const item of data?.products ?? []) {
      seenMeta.current[item.id] = { title: item.title, imageUrl: item.imageUrl };
    }
  }, [data]);

  const cap = props.maxSelected;
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (cap === undefined || next.size < cap) next.add(id);
      else return prev; // at cap — selecting more is blocked, not silently lost
      return next;
    });
  };

  const formatPrice = (price: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: data?.currency ?? "USD",
    }).format(price);

  const count = selected.size;
  const atCap = cap !== undefined && count >= cap;

  return (
    <BrowseModalShell
      open={props.open}
      title="Browse products"
      onClose={props.onClose}
      footer={
        <>
          <span style={{ marginRight: "auto" }}>
            <s-text tone={atCap ? "critical" : "neutral"}>
              {cap === undefined
                ? `${count} product${count === 1 ? "" : "s"} selected`
                : `${count} of ${cap} products selected${atCap ? " — limit reached" : ""}`}
            </s-text>
          </span>
          <s-button onClick={props.onClose}>Cancel</s-button>
          <s-button
            variant="primary"
            onClick={() => props.onConfirm(Array.from(selected), { ...seenMeta.current })}
          >
            Add
          </s-button>
        </>
      }
    >
      <s-stack gap="small">
        <input
          type="search"
          value={q}
          placeholder="Search products"
          onChange={(e) => {
            setQ(e.currentTarget.value);
            setPage(1);
          }}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid var(--s-color-border, #d4d4d4)",
            font: "inherit",
            boxSizing: "border-box",
          }}
        />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <s-select
            label="Vendor"
            labelAccessibilityVisibility="exclusive"
            value={vendor}
            onChange={(e) => {
              setVendor(e.currentTarget.value);
              setPage(1);
            }}
          >
            <s-option value="">All vendors</s-option>
            {(data?.filters.vendors ?? []).map((v) => (
              <s-option key={v} value={v}>
                {v}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Tag"
            labelAccessibilityVisibility="exclusive"
            value={tag}
            onChange={(e) => {
              setTag(e.currentTarget.value);
              setPage(1);
            }}
          >
            <s-option value="">All tags</s-option>
            {(data?.filters.tags ?? []).map((t) => (
              <s-option key={t} value={t}>
                {t}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Collection"
            labelAccessibilityVisibility="exclusive"
            value={collectionId}
            onChange={(e) => {
              setCollectionId(e.currentTarget.value);
              setPage(1);
            }}
          >
            <s-option value="">All collections</s-option>
            {(data?.filters.collections ?? []).map((c) => (
              <s-option key={c.id} value={c.id}>
                {c.title}
              </s-option>
            ))}
          </s-select>
        </div>

        {!data && fetcher.state !== "idle" ? (
          <s-box padding="large">
            <s-text tone="neutral">Loading products…</s-text>
          </s-box>
        ) : (data?.products.length ?? 0) === 0 ? (
          <s-box padding="large">
            <s-text tone="neutral">No products found.</s-text>
          </s-box>
        ) : (
          <div>
            {(data?.products ?? []).map((item) => (
              <label
                key={item.id}
                htmlFor={`browse-product-${item.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 4px",
                  borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                  cursor: "pointer",
                }}
              >
                <input
                  id={`browse-product-${item.id}`}
                  type="checkbox"
                  checked={selected.has(item.id)}
                  disabled={atCap && !selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <BrowseThumb imageUrl={item.imageUrl} title={item.title} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>
                    {item.title}
                  </span>
                  <s-text tone="neutral">{item.stockLabel}</s-text>
                </span>
                <span style={{ fontSize: 13, whiteSpace: "nowrap" }}>{formatPrice(item.price)}</span>
              </label>
            ))}
          </div>
        )}

        <BrowsePager
          page={data?.page ?? page}
          total={data?.total ?? 0}
          pageSize={data?.pageSize ?? 10}
          onPage={setPage}
        />
      </s-stack>
    </BrowseModalShell>
  );
}
