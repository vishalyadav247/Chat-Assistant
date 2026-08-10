import { useMemo, useState } from "react";
import type { ProductDetail, ProductRow, TrainingActionResult } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import { BrowseModalShell, BrowseThumb } from "./BrowseProductsModal";
import { LearnCard, StatusBadge, SubTabs, formatDateTime, useTrainingFetcher } from "./TrainingShared";

// Products tab (spec 07, design #viewTraining → Products): learn card with
// master switch, manage card (Sync / disabled Manage metafields), sub-tabs
// All/Active/Inactive, table with per-row learn toggle + read-only view modal.

type SubTab = "all" | "active" | "inactive";

export function TrainingProductsTab(props: {
  rows: ProductRow[];
  total: number;
  learned: number;
  lastSyncedAt: string | null;
  syncStatus: string;
  currency: string;
}) {
  const { submit, busy } = useTrainingFetcher();
  const [subTab, setSubTab] = useState<SubTab>("all");
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailFetcher = useTrainingFetcher((result: TrainingActionResult) => {
    if (result.intent === "product-detail" && result.ok && result.detail) {
      setDetail(result.detail);
    }
  });

  const rows = useMemo(() => {
    if (subTab === "all") return props.rows;
    return props.rows.filter((row) =>
      subTab === "active" ? row.status === "active" : row.status !== "active",
    );
  }, [props.rows, subTab]);

  const allLearned = props.total > 0 && props.learned === props.total;

  const openDetail = (row: ProductRow) => {
    setDetail(null);
    setDetailOpen(true);
    detailFetcher.submit("product-detail", { id: row.id });
  };

  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: props.currency }).format(value);

  return (
    <s-stack gap="base">
      <LearnCard
        title="Products"
        chip={`${props.learned} of ${props.total} products learned`}
        description="Help customers discover products, get details about features and pricing, and find what they're looking for."
        switchChecked={allLearned}
        switchLabel="Learn all products"
        switchDisabled={busy || props.total === 0}
        onSwitch={(checked) =>
          submit("products-learn-all", { enabled: checked ? "true" : "false" })
        }
      />

      <s-section heading="Manage data">
        <s-stack gap="base">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <s-text tone="neutral">
                Auto sync: Daily · Last updated: {formatDateTime(props.lastSyncedAt)}
                {props.syncStatus === "running" ? " · Sync running…" : ""}
              </s-text>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <s-button disabled={true}>
                Manage metafields
                <s-tooltip>Coming soon</s-tooltip>
              </s-button>
              <s-button variant="primary" disabled={busy} onClick={() => submit("sync-products")}>
                Sync products
              </s-button>
            </div>
          </div>

          <SubTabs
            tabs={[
              { id: "all", label: "All" },
              { id: "active", label: "Active" },
              { id: "inactive", label: "Inactive" },
            ]}
            active={subTab}
            onChange={setSubTab}
          />

          <DataTable
            rows={rows}
            searchPlaceholder="Search products by title or tag"
            searchFn={(row, q) =>
              row.title.toLowerCase().includes(q) ||
              row.tags.some((tag) => tag.toLowerCase().includes(q))
            }
            emptyMessage="No products found. Run a sync to import your catalog."
            perPage={10}
            columns={[
              {
                key: "product",
                title: "Product",
                render: (row) => (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <BrowseThumb imageUrl={row.imageUrl} title={row.title} />
                    <span style={{ fontWeight: 600 }}>{row.title}</span>
                  </span>
                ),
              },
              {
                key: "collections",
                title: "Collections",
                render: () => <s-text tone="neutral">—</s-text>,
              },
              {
                key: "tags",
                title: "Tags",
                render: (row) => (
                  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                    {row.tags.slice(0, 3).map((tag) => (
                      <s-badge key={tag} tone="neutral">
                        {tag}
                      </s-badge>
                    ))}
                    {row.tags.length > 3 ? (
                      <s-text tone="neutral">+{row.tags.length - 3}</s-text>
                    ) : null}
                  </span>
                ),
              },
              {
                key: "status",
                title: "Status",
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                key: "faqs",
                title: "FAQs",
                render: () => <s-text tone="neutral">0</s-text>,
              },
              {
                key: "learn",
                title: "Learn",
                render: (row) => (
                  <s-switch
                    label={`Learn ${row.title}`}
                    labelAccessibilityVisibility="exclusive"
                    checked={row.learnEnabled}
                    onChange={(e) =>
                      submit("product-learn", {
                        id: row.id,
                        enabled: e.currentTarget.checked ? "true" : "false",
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
                  <s-button variant="tertiary" onClick={() => openDetail(row)}>
                    View
                  </s-button>
                ),
              },
            ]}
          />
        </s-stack>
      </s-section>

      <BrowseModalShell
        open={detailOpen}
        title="View product"
        onClose={() => setDetailOpen(false)}
        footer={
          <span style={{ marginLeft: "auto" }}>
            <s-button onClick={() => setDetailOpen(false)}>Close</s-button>
          </span>
        }
      >
        {!detail ? (
          <s-box padding="large">
            <s-text tone="neutral">Loading product…</s-text>
          </s-box>
        ) : (
          <s-stack gap="base">
            <ViewRow label="ID">
              <a
                href={detail.adminUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--s-color-text-link, #6d3bf5)" }}
              >
                {detail.numericId}
              </a>
            </ViewRow>
            <ViewRow label="Title">{detail.title}</ViewRow>
            <ViewRow label="Status">
              <StatusBadge status={detail.status} />
            </ViewRow>
            <ViewRow label="URL">
              {detail.url ? (
                <a
                  href={detail.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--s-color-text-link, #6d3bf5)", wordBreak: "break-all" }}
                >
                  {detail.url}
                </a>
              ) : (
                "—"
              )}
            </ViewRow>
            <ViewRow label="Vendor">{detail.vendor || "—"}</ViewRow>
            <ViewRow label="FAQs">{String(detail.faqCount)}</ViewRow>
            <ViewRow label="Description">{detail.description || "—"}</ViewRow>

            <s-heading>Tags</s-heading>
            <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
              {detail.tags.length === 0 ? (
                <s-text tone="neutral">—</s-text>
              ) : (
                detail.tags.map((tag) => (
                  <s-badge key={tag} tone="neutral">
                    {tag}
                  </s-badge>
                ))
              )}
            </span>

            <s-heading>Prices</s-heading>
            <ViewTable
              headers={["Variant", "Price"]}
              rows={
                detail.variants.length === 0
                  ? [["Default", "—"]]
                  : detail.variants.map((v) => [v.title, money(v.price)])
              }
            />

            <s-heading>Inventory</s-heading>
            <ViewTable
              headers={["Variant", "Status"]}
              rows={
                detail.variants.length === 0
                  ? [["Default", "—"]]
                  : detail.variants.map((v) => [v.title, v.available ? "In stock" : "Sold out"])
              }
            />

            <s-heading>Options</s-heading>
            <s-text tone="neutral">—</s-text>
          </s-stack>
        )}
      </BrowseModalShell>
    </s-stack>
  );
}

function ViewRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr",
        gap: 16,
        padding: "10px 0",
        borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
        fontSize: 13,
        alignItems: "start",
      }}
    >
      <span style={{ fontWeight: 600, color: "var(--s-color-text-secondary, #6b6b73)" }}>
        {props.label}
      </span>
      <span>{props.children}</span>
    </div>
  );
}

function ViewTable(props: { headers: [string, string]; rows: [string, string][] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr>
          {props.headers.map((h, i) => (
            <th
              key={h}
              style={{
                textAlign: i === 1 ? "right" : "left",
                padding: "8px 12px",
                background: "var(--s-color-bg-fill-secondary, #f7f7f7)",
                borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map(([a, b], index) => (
          <tr key={`${a}-${index}`}>
            <td
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
              }}
            >
              {a}
            </td>
            <td
              style={{
                padding: "8px 12px",
                textAlign: "right",
                borderBottom: "1px solid var(--s-color-border-secondary, #f1f1f1)",
              }}
            >
              {b}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
