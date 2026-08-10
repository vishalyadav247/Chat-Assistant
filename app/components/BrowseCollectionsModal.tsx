import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { BrowseData } from "../routes/app.browse-data";
import type { BrowseItemMeta } from "./BrowseProductsModal";
import { BrowseModalShell, BrowsePager, BrowseThumb } from "./BrowseProductsModal";

// Shared "Browse collections" picker (specs 08/12; same pattern as
// BrowseProductsModal — design ai-agent.html #mBrowseColl). Rows show the
// collection title + "N products"; selection values are collection gids.

export function BrowseCollectionsModal(props: {
  open: boolean;
  onClose: () => void;
  selectedIds: string[]; // shopify collection gids
  onConfirm: (ids: string[], meta?: Record<string, BrowseItemMeta>) => void;
}) {
  const fetcher = useFetcher<BrowseData>();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const seenMeta = useRef<Record<string, BrowseItemMeta>>({});

  const { open } = props;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setSelected(new Set(props.selectedIds));
      setQ("");
      setDebouncedQ("");
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
    const params = new URLSearchParams({ kind: "collections", page: String(page) });
    if (debouncedQ) params.set("q", debouncedQ);
    load(`/app/browse-data?${params.toString()}`);
  }, [open, debouncedQ, page, load]);

  const data = fetcher.data;
  useEffect(() => {
    for (const item of data?.collections ?? []) {
      seenMeta.current[item.id] = { title: item.title, imageUrl: null };
    }
  }, [data]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const count = selected.size;

  return (
    <BrowseModalShell
      open={props.open}
      title="Browse collections"
      onClose={props.onClose}
      footer={
        <>
          <span style={{ marginRight: "auto" }}>
            <s-text tone="neutral">
              {count} collection{count === 1 ? "" : "s"} selected
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
          placeholder="Search collections"
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

        {!data && fetcher.state !== "idle" ? (
          <s-box padding="large">
            <s-text tone="neutral">Loading collections…</s-text>
          </s-box>
        ) : (data?.collections.length ?? 0) === 0 ? (
          <s-box padding="large">
            <s-text tone="neutral">No collections found.</s-text>
          </s-box>
        ) : (
          <div>
            {(data?.collections ?? []).map((item) => (
              <label
                key={item.id}
                htmlFor={`browse-collection-${item.id}`}
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
                  id={`browse-collection-${item.id}`}
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <BrowseThumb imageUrl={null} title={item.title} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>
                    {item.title}
                  </span>
                  <s-text tone="neutral">
                    {item.productCount} product{item.productCount === 1 ? "" : "s"}
                  </s-text>
                </span>
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
