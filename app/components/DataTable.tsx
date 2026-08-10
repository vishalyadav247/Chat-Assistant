import { useMemo, useState } from "react";

// Shared admin table (specs 07/09/11/12): client-side search + filter chips +
// pagination (10/page) over loader-provided rows. Server-side pagination can
// replace the paging seam later without changing consumers' markup.

export interface Column<Row> {
  key: string;
  title: string;
  render: (row: Row) => React.ReactNode;
  align?: "start" | "end";
}

export function DataTable<Row extends { id: string }>(props: {
  columns: Column<Row>[];
  rows: Row[];
  searchPlaceholder?: string;
  searchFn?: (row: Row, query: string) => boolean;
  emptyMessage: string;
  onRowClick?: (row: Row) => void;
  perPage?: number;
  toolbar?: React.ReactNode;
  /** Optional controlled page (1-based) — e.g. Contacts export needs to know
   *  the visible page server-side. Omit for internal paging state. */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Optional footer rendered on the pagination row (e.g. rows-per-page). */
  footerExtra?: React.ReactNode;
}) {
  const perPage = props.perPage ?? 10;
  const [query, setQuery] = useState("");
  const [pageState, setPageState] = useState(1);
  const page = props.page ?? pageState;
  const setPage = (next: number) => {
    setPageState(next);
    props.onPageChange?.(next);
  };

  const filtered = useMemo(() => {
    if (!query.trim() || !props.searchFn) return props.rows;
    const q = query.trim().toLowerCase();
    return props.rows.filter((row) => props.searchFn!(row, q));
  }, [props.rows, query, props.searchFn]);

  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * perPage, current * perPage);

  return (
    <s-stack gap="base">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {props.searchFn ? (
          <input
            type="search"
            value={query}
            placeholder={props.searchPlaceholder ?? "Search"}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setPage(1);
            }}
            style={{
              flex: 1,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--s-color-border, #d4d4d4)",
              font: "inherit",
            }}
          />
        ) : null}
        {props.toolbar}
      </div>

      {visible.length === 0 ? (
        <s-box padding="large">
          <s-text tone="neutral">{props.emptyMessage}</s-text>
        </s-box>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {props.columns.map((col) => (
                <th
                  key={col.key}
                  style={{
                    textAlign: col.align === "end" ? "right" : "left",
                    padding: "8px 12px",
                    borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {col.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={row.id}
                onClick={props.onRowClick ? () => props.onRowClick!(row) : undefined}
                style={{ cursor: props.onRowClick ? "pointer" : undefined }}
              >
                {props.columns.map((col) => (
                  <td
                    key={col.key}
                    style={{
                      textAlign: col.align === "end" ? "right" : "left",
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
                      fontSize: 13,
                    }}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pages > 1 || props.footerExtra ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            justifyContent: props.footerExtra ? "space-between" : "flex-end",
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <s-button
              variant="tertiary"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              Prev
            </s-button>
            <s-text tone="neutral">
              Page {current} / {pages}
            </s-text>
            <s-button
              variant="tertiary"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              Next
            </s-button>
          </div>
          {props.footerExtra}
        </div>
      ) : null}
    </s-stack>
  );
}
