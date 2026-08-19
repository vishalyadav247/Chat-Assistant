import { useMemo, useState } from "react";
import type { MetafieldDefinitionRow } from "../lib/ingestion/metafields.server";
import type { ProductDetail, ProductRow, TrainingActionResult } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import { ManageMetafieldsModal } from "./ManageMetafieldsModal";
import { BrowseModalShell, BrowseThumb } from "./BrowseProductsModal";
import {
  AutoSyncControl,
  LearnCard,
  StatusBadge,
  SubTabs,
  useSyncWatcher,
  useTrainingFetcher,
} from "./TrainingShared";
import { BRAND } from "./ui/tokens";

// Products tab (spec 07, design #viewTraining → Products): learn card with
// master switch, manage card (Manage metafields modal + Sync), sub-tabs
// All/Active/Inactive + Learning on/off (2026-08-17), table with per-row learn
// toggle + read-only view modal (row click opens it too; lists synced
// metafields, flagging the ones the AI learns from — 2026-08-19).

type SubTab = "all" | "active" | "inactive" | "learning_on" | "learning_off";

export function TrainingProductsTab(props: {
  rows: ProductRow[];
  total: number;
  learned: number;
  lastSyncedAt: string | null;
  syncStatus: string;
  currency: string;
  /** Master "Learn products" permission (ShopSettings.learn.products) —
   *  independent of per-row learnEnabled, which applies only when this is on. */
  masterEnabled: boolean;
  /** Plan feature `catalog_auto_sync` (Pro+) — toggle is locked when false. */
  autoSyncAvailable: boolean;
  /** ShopSettings.catalogAutoSync.products — daily full re-sync (webhooks unaffected). */
  autoSyncEnabled: boolean;
  /** Manage metafields modal rows + plan cap (spec 07, 2026-08-19). */
  metafields: MetafieldDefinitionRow[];
  metafieldQuota: number;
  metafieldSyncAt: string | null;
}) {
  const { submit, pendingIntent } = useTrainingFetcher();
  const syncWatch = useSyncWatcher(props.lastSyncedAt, "Products synced");
  const [subTab, setSubTab] = useState<SubTab>("all");
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [metafieldsOpen, setMetafieldsOpen] = useState(false);
  const detailFetcher = useTrainingFetcher((result: TrainingActionResult) => {
    if (result.intent === "product-detail" && result.ok && result.detail) {
      setDetail(result.detail);
    }
  });

  const rows = useMemo(() => {
    switch (subTab) {
      case "active":
        return props.rows.filter((row) => row.status === "active");
      case "inactive":
        return props.rows.filter((row) => row.status !== "active");
      case "learning_on":
        return props.rows.filter((row) => row.learnEnabled);
      case "learning_off":
        return props.rows.filter((row) => !row.learnEnabled);
      default:
        return props.rows;
    }
  }, [props.rows, subTab]);

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
        chip={`${props.masterEnabled ? props.learned : 0} of ${props.total} products learned`}
        description="Help customers discover products, get details about features and pricing, and find what they're looking for."
        switchChecked={props.masterEnabled}
        switchLabel="Learn products"
        onSwitch={(checked) =>
          submit("learn-master", { type: "products", enabled: checked ? "true" : "false" })
        }
      />

      <s-section heading="Manage data">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
            <AutoSyncControl
              type="products"
              available={props.autoSyncAvailable}
              enabled={props.autoSyncEnabled}
              busy={pendingIntent === "catalog-autosync"}
              lastSyncedAt={props.lastSyncedAt}
              running={props.syncStatus === "running" || syncWatch.syncing}
              onChange={(enabled) =>
                submit("catalog-autosync", { type: "products", enabled: enabled ? "true" : "false" })
              }
            />
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-button onClick={() => setMetafieldsOpen(true)}>Manage metafields</s-button>
              <s-button
                variant="primary"
                icon="refresh"
                loading={syncWatch.syncing || pendingIntent === "sync-products"}
                onClick={() => {
                  submit("sync-products");
                  syncWatch.start();
                }}
              >
                Sync products
              </s-button>
            </s-stack>
          </s-grid>

          <DataTable
            rows={rows}
            searchPlaceholder="Search products by title or tag"
            searchFn={(row, q) =>
              row.title.toLowerCase().includes(q) ||
              row.tags.some((tag) => tag.toLowerCase().includes(q))
            }
            emptyMessage="No products found. Run a sync to import your catalog."
            perPage={10}
            onRowClick={openDetail}
            toolbar={
              <SubTabs
                tabs={[
                  { id: "all", label: "All" },
                  { id: "active", label: "Active" },
                  { id: "inactive", label: "Inactive" },
                  { id: "learning_on", label: "Learning on" },
                  { id: "learning_off", label: "Learning off" },
                ]}
                active={subTab}
                onChange={setSubTab}
              />
            }
            bulkActions={(ids, clear) => (
              <>
                <s-button
                  disabled={pendingIntent === "products-learn"}
                  onClick={() => {
                    submit("products-learn", { ids: ids.join(","), enabled: "true" });
                    clear();
                  }}
                >
                  Enable learning
                </s-button>
                <s-button
                  disabled={pendingIntent === "products-learn"}
                  onClick={() => {
                    submit("products-learn", { ids: ids.join(","), enabled: "false" });
                    clear();
                  }}
                >
                  Disable learning
                </s-button>
              </>
            )}
            columns={[
              {
                key: "product",
                title: "Product",
                render: (row) => (
                  <s-grid gridTemplateColumns="auto 1fr" gap="small-200" alignItems="center">
                    <BrowseThumb imageUrl={row.imageUrl} title={row.title} />
                    <s-text type="strong">{row.title}</s-text>
                  </s-grid>
                ),
              },
              {
                key: "tags",
                title: "Tags",
                render: (row) => (
                  <s-stack direction="inline" gap="small-400">
                    {row.tags.slice(0, 3).map((tag) => (
                      <s-badge key={tag} tone="neutral">
                        {tag}
                      </s-badge>
                    ))}
                    {row.tags.length > 3 ? (
                      <s-text color="subdued">+{row.tags.length - 3}</s-text>
                    ) : null}
                  </s-stack>
                ),
              },
              {
                key: "status",
                title: "Status",
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                key: "learn",
                title: "AI Learn",
                width: 110, // keeps the heading on one line
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
                  <s-button
                    variant="tertiary"
                    icon="view"
                    accessibilityLabel={`View ${row.title}`}
                    onClick={() => openDetail(row)}
                  />
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
          <s-stack direction="inline" justifyContent="end">
            <s-button onClick={() => setDetailOpen(false)}>Close</s-button>
          </s-stack>
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
                style={{ color: `var(--s-color-text-link, ${BRAND.accent})` }}
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
                  style={{ color: `var(--s-color-text-link, ${BRAND.accent})`, wordBreak: "break-all" }}
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
            <s-stack direction="inline" gap="small-400">
              {detail.tags.length === 0 ? (
                <s-text color="subdued">—</s-text>
              ) : (
                detail.tags.map((tag) => (
                  <s-badge key={tag} tone="neutral">
                    {tag}
                  </s-badge>
                ))
              )}
            </s-stack>

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

            <s-heading>Metafields</s-heading>
            {detail.metafields.length === 0 ? (
              <s-text tone="neutral">—</s-text>
            ) : (
              <s-stack gap="small-200">
                {detail.metafields.map((m, index) => (
                  <s-grid
                    key={`${m.label}-${index}`}
                    gridTemplateColumns="140px 1fr auto"
                    gap="base"
                    alignItems="start"
                  >
                    <s-text color="subdued" type="strong">
                      {m.label}
                    </s-text>
                    <s-text>{m.value}</s-text>
                    {m.enabled ? <s-badge tone="success">AI</s-badge> : <span />}
                  </s-grid>
                ))}
              </s-stack>
            )}

            <s-heading>Options</s-heading>
            <s-text tone="neutral">—</s-text>
          </s-stack>
        )}
      </BrowseModalShell>

      <ManageMetafieldsModal
        open={metafieldsOpen}
        onClose={() => setMetafieldsOpen(false)}
        rows={props.metafields}
        quota={props.metafieldQuota}
        lastSyncedAt={props.metafieldSyncAt}
      />
    </s-stack>
  );
}

function ViewRow(props: { label: string; children: React.ReactNode }) {
  return (
    <s-stack gap="small-200">
      <s-grid gridTemplateColumns="140px 1fr" gap="base" alignItems="start">
        <s-text color="subdued" type="strong">
          {props.label}
        </s-text>
        <s-text>{props.children}</s-text>
      </s-grid>
      <s-divider />
    </s-stack>
  );
}

function ViewTable(props: { headers: [string, string]; rows: [string, string][] }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>{props.headers[0]}</s-table-header>
        <s-table-header format="numeric">{props.headers[1]}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {props.rows.map(([a, b], index) => (
          <s-table-row key={`${a}-${index}`}>
            <s-table-cell>{a}</s-table-cell>
            <s-table-cell>{b}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
