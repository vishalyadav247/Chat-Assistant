import {
  mappingProblem,
  ROLE_LABEL,
  COLUMN_ROLES,
  type ColumnRole,
} from "../lib/lookup/lookup-shared";

// Column mapping for a lookup table (spec 28): one row per CSV column with a
// few sample values and a "Use as" select. Shared by the upload and edit modals.

export interface MappingColumn {
  key: string;
  name: string;
  samples: string[];
  role: ColumnRole;
}

export function LookupTableMapping(props: {
  columns: MappingColumn[];
  /** Column-pair ranges detected from the headers, e.g. "Year" from Year From/To. */
  ranges: string[];
  onChange: (key: string, role: ColumnRole) => void;
}) {
  const problem = mappingProblem(props.columns.map((c) => c.role));
  return (
    <s-stack gap="small-200">
      <s-stack gap="small-500">
        <s-text type="strong">How should the AI use each column?</s-text>
        <s-text color="subdued">
          Filters are the details a shopper gives the AI to find the right rows. Shown columns
          are included in answers. A product link column (SKU, handle or title) turns matching
          rows into product cards.
        </s-text>
      </s-stack>
      <div
        style={{
          maxHeight: 340,
          overflowY: "auto",
          border: "1px solid var(--s-color-border, #e3e3e3)",
          borderRadius: 8,
        }}
      >
        {props.columns.map((column) => (
          <div
            key={column.key}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(150px, 210px)",
              gap: 12,
              alignItems: "center",
              padding: "8px 12px",
              borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, overflowWrap: "anywhere" }}>{column.name}</div>
              <div
                title={column.samples.join(", ")}
                style={{
                  fontSize: 12,
                  color: "var(--s-color-text-secondary, #6d7175)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {column.samples.length > 0 ? column.samples.join(", ") : "(empty)"}
              </div>
            </div>
            <s-select
              label={`Use ${column.name} as`}
              labelAccessibilityVisibility="exclusive"
              value={column.role}
              onInput={(e) => {
                const value = e.currentTarget.value as ColumnRole;
                if (COLUMN_ROLES.includes(value)) props.onChange(column.key, value);
              }}
            >
              {COLUMN_ROLES.map((role) => (
                <s-option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </s-option>
              ))}
            </s-select>
          </div>
        ))}
      </div>
      {props.ranges.length > 0 ? (
        <s-text color="subdued">
          {props.ranges.map((r) => `${r} from/to`).join(", ")} columns are also searched together as a
          range — a shopper&apos;s {props.ranges[0].toLowerCase()} matches rows whose range includes it.
        </s-text>
      ) : null}
      {problem ? <s-text tone="critical">{problem}</s-text> : null}
    </s-stack>
  );
}
