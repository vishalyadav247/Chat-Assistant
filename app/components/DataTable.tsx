import { useId, useMemo, useState } from "react";
import { SPACE } from "./ui/tokens";

// Shared admin table (specs 07/09/11/12), rendered on the native Polaris
// s-table family (user directive 2026-08-12 — no hand-rolled <table> markup).
// Standard furniture per discount_screen_2.png, consistent app-wide:
//   toolbar (pills/chips) left · collapsible search icon right,
//   optional row selection + "N selected" bulk-action bar,
//   footer always visible: pager centered, items-per-page (10/25/50) right.
// Server-side pagination can replace the paging seam later without changing
// consumers' markup.

export interface Column<Row> {
  key: string;
  title: string;
  render: (row: Row) => React.ReactNode;
  align?: "start" | "end";
  /** Column width (e.g. "40%" or 120). Omitted columns share the rest. */
  width?: string | number;
}

export function DataTable<Row extends { id: string }>(props: {
  columns: Column<Row>[];
  rows: Row[];
  searchPlaceholder?: string;
  searchFn?: (row: Row, query: string) => boolean;
  /** Controlled search value — pass with onSearchChange when the query is
   *  needed outside the table (e.g. Contacts' "current page" CSV export). */
  search?: string;
  onSearchChange?: (value: string) => void;
  emptyMessage: string;
  /** Rich empty state (icon/title/action) — overrides emptyMessage rendering. */
  empty?: React.ReactNode;
  onRowClick?: (row: Row) => void;
  /** Whole-row hover highlight without a row action. Polaris only paints row
   *  hover for rows with a click delegate (the tr lives in shadow DOM, so no
   *  external CSS can), so this wires a no-op delegate. */
  hoverable?: boolean;
  /** Initial rows per page (default 10). */
  perPage?: number;
  toolbar?: React.ReactNode;
  /** Rendered at the far right of the toolbar row, after the search icon
   *  (e.g. Contacts' Export menu button). */
  toolbarEnd?: React.ReactNode;
  /** Render the opened search field on its own full-width row below the
   *  toolbar instead of inline next to the icon. */
  searchFieldBelow?: boolean;
  /** Rendered to the right of the below-toolbar search field (searchFieldBelow),
   *  e.g. Contacts' sort menu per contacts.png. */
  searchRowEnd?: React.ReactNode;
  /** Per-row action buttons in a trailing column, revealed on row hover. */
  rowActions?: (row: Row) => React.ReactNode;
  /** Rows are being re-fetched: keeps them visible under a centered spinner
   *  overlay (covers only the rows region, not toolbar/search/pager). */
  loading?: boolean;
  /** Always show the search field (no collapsible icon). */
  searchAlwaysOpen?: boolean;
  /** Optional controlled page (1-based) — e.g. Contacts export needs to know
   *  the visible page server-side. Omit for internal paging state. */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Optional footer content on the pagination row, left of items-per-page. */
  footerExtra?: React.ReactNode;
  /** Hide the built-in items-per-page select — for consumers whose page size
   *  is fixed server-side. */
  perPageSelector?: boolean;
  /** Makes perPage controlled — pass when the page size is needed outside the
   *  table (e.g. Contacts' "current page" CSV export). */
  onPerPageChange?: (perPage: number) => void;
  /** Enables the selection checkbox column. Renders the bulk-action buttons
   *  shown in the "N selected" bar. */
  bulkActions?: (selectedIds: string[], clearSelection: () => void) => React.ReactNode;
}) {
  const [queryState, setQueryState] = useState("");
  const [searchOpenState, setSearchOpen] = useState(false);
  const searchOpen = props.searchAlwaysOpen || searchOpenState;
  const [pageState, setPageState] = useState(1);
  const [perPageState, setPerPageState] = useState(props.perPage ?? 10);
  const query = props.onSearchChange ? (props.search ?? "") : queryState;
  const setQuery = (value: string) => {
    setQueryState(value);
    props.onSearchChange?.(value);
  };
  const perPage = props.onPerPageChange ? (props.perPage ?? 10) : perPageState;
  const setPerPage = (value: number) => {
    setPerPageState(value);
    props.onPerPageChange?.(value);
  };
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const page = props.page ?? pageState;
  const setPage = (next: number) => {
    setPageState(next);
    props.onPageChange?.(next);
  };
  const showPerPageSelector = props.perPageSelector ?? true;
  // hoverable → same delegate wiring as a real row click, with a no-op handler.
  const onRowClick = props.onRowClick ?? (props.hoverable ? () => {} : undefined);

  const filtered = useMemo(() => {
    if (!query.trim() || !props.searchFn) return props.rows;
    const q = query.trim().toLowerCase();
    return props.rows.filter((row) => props.searchFn!(row, q));
  }, [props.rows, query, props.searchFn]);

  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * perPage, current * perPage);

  const visibleSelected = visible.filter((r) => selected.has(r.id)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  const toggleVisible = (checked: boolean) => {
    const next = new Set(selected);
    for (const row of visible) {
      if (checked) next.add(row.id);
      else next.delete(row.id);
    }
    setSelected(next);
  };
  const toggleRow = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const clearSelection = () => setSelected(new Set());

  // Column widths: s-table-header takes no style/class prop, but the headers
  // are light-DOM elements, so a scoped stylesheet can size them (same
  // technique as row-hover CSS elsewhere). nth-child shifts by one when the
  // selection checkbox column is present.
  const scopeClass = "dt" + useId().replace(/[^a-zA-Z0-9-]/g, "");
  const widthCss = props.columns
    .map((col, i) => {
      if (col.width === undefined) return "";
      const width = typeof col.width === "number" ? `${col.width}px` : col.width;
      const nth = i + (props.bulkActions ? 2 : 1);
      return `.${scopeClass} s-table-header:nth-child(${nth}) { width: ${width}; }`;
    })
    .filter(Boolean)
    .join("\n");
  // No custom hover/cursor CSS for clickable rows: the s-* table hosts are
  // display:contents (the real tr/td live in shadow DOM), so external
  // backgrounds never paint. Polaris supplies whole-row hover + pointer
  // natively (.has-delegate:hover) when clickDelegate is set on the row.
  const scopedCss = [
    widthCss,
    props.rowActions
      ? `.${scopeClass} .dt-row-actions { opacity: 0; transition: opacity .12s ease; }
.${scopeClass} s-table-row:hover .dt-row-actions,
.${scopeClass} .dt-row-actions:focus-within { opacity: 1; }`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const searchField = (
    <s-search-field
      label={props.searchPlaceholder ?? "Search"}
      labelAccessibilityVisibility="exclusive"
      placeholder={props.searchPlaceholder ?? "Search"}
      value={query}
      onInput={(e) => {
        setQuery(e.currentTarget.value);
        setPage(1);
      }}
    />
  );

  return (
    <s-stack gap="base">
      {props.searchFn || props.toolbar || props.toolbarEnd ? (
        <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center", flexWrap: "wrap" }}>
          {props.toolbar}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: SPACE.xs,
              flex: searchOpen && !props.searchFieldBelow ? "1 1 220px" : undefined,
              justifyContent: "flex-end",
            }}
          >
            {props.searchFn && searchOpen && !props.searchFieldBelow ? (
              <div style={{ flex: 1, minWidth: 180 }}>{searchField}</div>
            ) : null}
            {props.searchFn && !props.searchAlwaysOpen ? (
              <s-button
                variant="tertiary"
                icon={searchOpen ? "x" : "search"}
                accessibilityLabel={searchOpen ? "Close search" : "Search"}
                onClick={() => {
                  if (searchOpen) {
                    setQuery("");
                    setPage(1);
                  }
                  setSearchOpen(!searchOpen);
                }}
              />
            ) : null}
            {props.toolbarEnd}
          </div>
        </div>
      ) : null}
      {props.searchFn && searchOpen && props.searchFieldBelow ? (
        // stretch → searchRowEnd controls (e.g. the sort button) match the
        // search field's height exactly.
        <div style={{ display: "flex", gap: SPACE.xs, alignItems: "stretch" }}>
          <div style={{ flex: 1 }}>{searchField}</div>
          {props.searchRowEnd}
        </div>
      ) : null}

      <div style={{ position: "relative" }}>
      {props.loading ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255,255,255,.6)",
            borderRadius: 8,
          }}
        >
          {/* Polaris has no medium spinner (base | large | large-100) — a
              scaled-down large reads as one. */}
          <span style={{ display: "inline-flex", transform: "scale(0.7)" }}>
            <s-spinner size="large" accessibilityLabel="Loading rows" />
          </span>
        </div>
      ) : null}
      {visible.length === 0 ? (
        (props.empty ?? (
          <s-box padding="large">
            <s-text tone="neutral">{props.emptyMessage}</s-text>
          </s-box>
        ))
      ) : (
        // position:relative so the selection bar can OVERLAY the header row
        // (Polaris IndexTable behavior) instead of inserting a row above the
        // table — no layout shift when rows are selected/deselected.
        <div className={scopeClass} style={{ position: "relative" }}>
          {scopedCss ? <style>{scopedCss}</style> : null}
          {props.bulkActions && selected.size > 0 ? (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                zIndex: 2,
                display: "flex",
                alignItems: "center",
                gap: SPACE.sm,
                padding: "4px 12px",
                background: "var(--s-color-bg-surface-secondary, #f7f7f8)",
                borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
                borderRadius: "8px 8px 0 0",
              }}
            >
              <s-checkbox
                label="Select all on this page"
                labelAccessibilityVisibility="exclusive"
                checked={allVisibleSelected}
                indeterminate={visibleSelected > 0 && !allVisibleSelected}
                onChange={(e) => toggleVisible(e.currentTarget.checked)}
              />
              <s-text>{selected.size} selected</s-text>
              {selected.size < filtered.length ? (
                <s-button
                  variant="tertiary"
                  onClick={() => setSelected(new Set(filtered.map((r) => r.id)))}
                >
                  Select all {filtered.length}
                </s-button>
              ) : null}
              <div style={{ marginLeft: "auto", display: "flex", gap: SPACE.xs }}>
                {props.bulkActions(Array.from(selected), clearSelection)}
              </div>
            </div>
          ) : null}
        <s-table>
          <s-table-header-row>
            {props.bulkActions ? (
              <s-table-header>
                <s-checkbox
                  label="Select all on this page"
                  labelAccessibilityVisibility="exclusive"
                  checked={allVisibleSelected}
                  indeterminate={visibleSelected > 0 && !allVisibleSelected}
                  onChange={(e) => toggleVisible(e.currentTarget.checked)}
                />
              </s-table-header>
            ) : null}
            {props.columns.map((col) => (
              <s-table-header key={col.key} format={col.align === "end" ? "numeric" : "base"}>
                {/* The shadow th's padding/height are fixed (28px), so padded
                    light-DOM content is what makes the header row taller. */}
                <span style={{ display: "inline-block", padding: "6px 0", whiteSpace: "nowrap" }}>
                  {col.title}
                </span>
              </s-table-header>
            ))}
            {props.rowActions ? <s-table-header /> : null}
          </s-table-header-row>
          <s-table-body>
            {visible.map((row) => (
              // clickDelegate provides the native whole-row hover styling
              // (.has-delegate:hover) — but its click forwarding doesn't fire
              // reliably, so a native listener (via ref; the React typing has
              // no onClick) handles clicks outside the first cell. The guard
              // skips interactive children (row actions, the s-clickable) so
              // nothing double-fires.
              <s-table-row
                key={row.id}
                clickDelegate={onRowClick ? `dtrow-${row.id}` : undefined}
                ref={
                  onRowClick
                    ? (el: HTMLElement | null) => {
                        if (!el) return;
                        el.onclick = (e) => {
                          const target = e.target as HTMLElement;
                          if (
                            target.closest(
                              "button, a, input, label, s-button, s-checkbox, s-clickable, s-link, s-switch, .dt-row-actions",
                            )
                          )
                            return;
                          onRowClick(row);
                        };
                      }
                    : undefined
                }
              >
                {props.bulkActions ? (
                  <s-table-cell>
                    <s-checkbox
                      label="Select row"
                      labelAccessibilityVisibility="exclusive"
                      checked={selected.has(row.id)}
                      onChange={(e) => toggleRow(row.id, e.currentTarget.checked)}
                    />
                  </s-table-cell>
                ) : null}
                {props.columns.map((col, i) => (
                  <s-table-cell key={col.key}>
                    {i === 0 && onRowClick ? (
                      <s-clickable id={`dtrow-${row.id}`} onClick={() => onRowClick(row)}>
                        {col.render(row)}
                      </s-clickable>
                    ) : (
                      col.render(row)
                    )}
                  </s-table-cell>
                ))}
                {props.rowActions ? (
                  <s-table-cell>
                    <div
                      className="dt-row-actions"
                      style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}
                    >
                      {props.rowActions(row)}
                    </div>
                  </s-table-cell>
                ) : null}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        </div>
      )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
        }}
      >
        <span />
        <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center" }}>
          <s-button
            variant="tertiary"
            icon="chevron-left"
            accessibilityLabel="Previous page"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
          />
          <s-text tone="neutral">
            Page {current} / {pages}
          </s-text>
          <s-button
            variant="tertiary"
            icon="chevron-right"
            accessibilityLabel="Next page"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
          />
        </div>
        <div
          style={{
            justifySelf: "end",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            whiteSpace: "nowrap",
          }}
        >
          {props.footerExtra}
          {showPerPageSelector ? (
            <>
              <s-text tone="neutral">Items per page</s-text>
              <s-select
                label="Items per page"
                labelAccessibilityVisibility="exclusive"
                value={String(perPage)}
                onChange={(e) => {
                  setPerPage(Number(e.currentTarget.value));
                  setPage(1);
                }}
              >
                <s-option value="10">10</s-option>
                <s-option value="25">25</s-option>
                <s-option value="50">50</s-option>
              </s-select>
            </>
          ) : null}
        </div>
      </div>
    </s-stack>
  );
}
