import { useState } from "react";
import { useNavigate } from "react-router";
import type { DiscountRow } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import {
  LearnCard,
  StatusBadge,
  SubTabs,
  SyncControlLayout,
  formatDate,
  useSyncWatcher,
  useTrainingFetcher,
} from "./TrainingShared";

// Discounts tab (spec 07, design discount_screen_2.png): upgrade banner for
// plans without real-time discount sync, learn card with master AI switch,
// manage card (Real-time mini switch, Manage → Shopify Discounts admin, Sync
// now), and the discounts table on the shared DataTable (native s-table:
// status pills, collapsible search, selection + bulk AI enable/disable —
// app-only per user decision 2026-08-12, never mutates the discount in
// Shopify — centered pager, items-per-page).

const TYPE_META: Record<string, { icon: "discount" | "delivery" | "gift-card"; label: string }> = {
  amount_off_order: { icon: "discount", label: "Amount off order" },
  amount_off_products: { icon: "discount", label: "Amount off products" },
  free_shipping: { icon: "delivery", label: "Free shipping" },
  bxgy: { icon: "gift-card", label: "Buy X get Y" },
};

type StatusFilter = "all" | "active" | "inactive" | "learning_on" | "learning_off";

export function TrainingDiscountsTab(props: {
  rows: DiscountRow[];
  lastSyncedAt: string | null;
  showUpgradeBanner: boolean;
  /** Plan allows real-time sync (Pro+; always true in open enforcement). */
  realtime: boolean;
  /** Merchant's saved toggle state (ShopSettings.discountRealtime). */
  realtimeEnabled: boolean;
  /** myshopify domain — Manage links to the store's Discounts admin. */
  shopDomain: string;
  /** Master "Learn discounts" permission (ShopSettings.learn.discounts) —
   *  independent of per-row learnEnabled, which applies only when this is on. */
  masterEnabled: boolean;
}) {
  const { submit, pendingIntent } = useTrainingFetcher();
  const syncWatch = useSyncWatcher(props.lastSyncedAt, "Discounts synced");
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const rows = props.rows.filter((row) => {
    switch (statusFilter) {
      case "active":
        return row.status === "active";
      case "inactive":
        return row.status !== "active";
      case "learning_on":
        return row.learnEnabled;
      case "learning_off":
        return !row.learnEnabled;
      default:
        return true;
    }
  });
  const learned = props.rows.filter((r) => r.learnEnabled).length;

  return (
    <s-stack gap="base">
      {props.showUpgradeBanner ? (
        <s-banner tone="info" heading="Upgrade to real-time discount sync">
          <s-paragraph>
            Pro/Plus plans sync discounts instantly when you edit them in Shopify via webhooks. No
            manual sync needed.
          </s-paragraph>
          <s-button variant="primary" onClick={() => navigate("/app/plan-usage")}>
            Upgrade to Pro
          </s-button>
        </s-banner>
      ) : null}

      <LearnCard
        title="Discounts"
        chip={`${props.masterEnabled ? learned : 0} of ${props.rows.length} discounts learned`}
        description="Enable your AI agent to answer customer questions about discounts."
        switchChecked={props.masterEnabled}
        switchLabel="Learn discounts"
        onSwitch={(checked) =>
          submit("learn-master", { type: "discounts", enabled: checked ? "true" : "false" })
        }
      />

      <s-section heading="Manage data">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
            <SyncControlLayout
              toggle={
                <s-switch
                  label="Real-time sync"
                  checked={props.realtime && props.realtimeEnabled}
                  disabled={!props.realtime || pendingIntent === "discount-realtime"}
                  onChange={(e) =>
                    submit("discount-realtime", {
                      enabled: e.currentTarget.checked ? "true" : "false",
                    })
                  }
                />
              }
              info={
                props.realtime
                  ? "Discount webhooks keep this data fresh automatically."
                  : "Available on Pro and Plus plans — discount webhooks keep this data fresh automatically."
              }
              locked={!props.realtime}
              lastSyncedAt={props.lastSyncedAt}
              running={syncWatch.syncing}
            />
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-button href={`https://${props.shopDomain}/admin/discounts`} target="_blank" icon="external">
                Manage in Shopify
              </s-button>
              <s-button
                variant="primary"
                icon="refresh"
                loading={syncWatch.syncing || pendingIntent === "sync-discounts"}
                onClick={() => {
                  submit("sync-discounts");
                  syncWatch.start();
                }}
              >
                Sync now
              </s-button>
            </s-stack>
          </s-grid>

          <DataTable
            rows={rows}
            searchPlaceholder="Search discounts"
            searchFn={(row, q) =>
              row.title.toLowerCase().includes(q) || row.summary.toLowerCase().includes(q)
            }
            emptyMessage="No items found"
            perPage={10}
            hoverable
            toolbar={
              <SubTabs
                tabs={[
                  { id: "all", label: "All" },
                  { id: "active", label: "Active" },
                  { id: "inactive", label: "Inactive" },
                  { id: "learning_on", label: "Learning on" },
                  { id: "learning_off", label: "Learning off" },
                ]}
                active={statusFilter}
                onChange={setStatusFilter}
              />
            }
            bulkActions={(ids, clear) => (
              <>
                <s-button
                  disabled={pendingIntent === "discounts-learn"}
                  onClick={() => {
                    submit("discounts-learn", { ids: ids.join(","), enabled: "true" });
                    clear();
                  }}
                >
                  Enable for AI
                </s-button>
                <s-button
                  disabled={pendingIntent === "discounts-learn"}
                  onClick={() => {
                    submit("discounts-learn", { ids: ids.join(","), enabled: "false" });
                    clear();
                  }}
                >
                  Disable for AI
                </s-button>
              </>
            )}
            columns={[
              {
                key: "title",
                title: "Title",
                render: (row) => (
                  <s-stack gap="small-500">
                    <s-text type="strong">{row.title}</s-text>
                    {row.summary ? <s-text color="subdued">{row.summary}</s-text> : null}
                  </s-stack>
                ),
              },
              {
                key: "status",
                title: "Status",
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                key: "method",
                title: "Method",
                render: (row) => (
                  <s-text tone="neutral">
                    {row.method === "automatic" ? "Automatic" : "Code"}
                  </s-text>
                ),
              },
              {
                key: "type",
                title: "Type",
                render: (row) => {
                  const meta = TYPE_META[row.discountType] ?? TYPE_META.amount_off_order;
                  return (
                    <s-stack direction="inline" alignItems="center" gap="small-300">
                      <s-icon type={meta.icon} size="small" />
                      <s-text color="subdued">{meta.label}</s-text>
                    </s-stack>
                  );
                },
              },
              {
                key: "startsAt",
                title: "Start date",
                render: (row) => <s-text tone="neutral">{formatDate(row.startsAt)}</s-text>,
              },
              {
                key: "endsAt",
                title: "End date",
                render: (row) => (
                  <s-text tone="neutral">{row.endsAt ? formatDate(row.endsAt) : "-"}</s-text>
                ),
              },
              {
                key: "used",
                title: "Used",
                align: "end",
                render: (row) => <s-text tone="neutral">{row.usedCount}</s-text>,
              },
              {
                key: "ai",
                title: "AI Learn",
                width: 110, // keeps the heading on one line
                render: (row) => (
                  <s-switch
                    label={`AI learning for ${row.title}`}
                    labelAccessibilityVisibility="exclusive"
                    checked={row.learnEnabled}
                    onChange={(e) =>
                      submit("discounts-learn", {
                        ids: row.id,
                        enabled: e.currentTarget.checked ? "true" : "false",
                      })
                    }
                  />
                ),
              },
            ]}
          />
        </s-stack>
      </s-section>
    </s-stack>
  );
}
