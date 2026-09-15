import { useState } from "react";
import type { DiscountRow } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import {
  FilterSelect,
  LearnCard,
  StatusBadge,
  SyncStatus,
  useMasterLearnDraft,
  useSyncWatcher,
  useTrainingFetcher,
} from "./TrainingShared";
import { SaveBar } from "./SaveBar";

// Discounts tab (spec 07, design discount_screen_2.png): learn card with master
// AI switch, manage card (sync status, Manage → Shopify Discounts admin, Sync
// now; discount webhooks apply on every plan, so there is no real-time switch
// or upgrade banner), and the discounts table on the shared DataTable (native s-table:
// status pills, collapsible search, selection + bulk AI enable/disable —
// app-only, never mutates the discount in
// Shopify — centered pager, items-per-page).

const TYPE_META: Record<string, { icon: "discount" | "delivery" | "gift-card"; label: string }> = {
  amount_off_order: { icon: "discount", label: "Amount off order" },
  amount_off_products: { icon: "discount", label: "Amount off products" },
  free_shipping: { icon: "delivery", label: "Free shipping" },
  bxgy: { icon: "gift-card", label: "Buy X get Y" },
};

// FAQ-style filter dropdowns (user, 2026-09-11 — replaced the SubTabs pills).
type StatusFilter = "" | "active" | "inactive";
type LearnFilter = "" | "on" | "off";

export function TrainingDiscountsTab(props: {
  rows: DiscountRow[];
  lastSyncedAt: string | null;
  /** myshopify domain — Manage links to the store's Discounts admin. */
  shopDomain: string;
  /** Master "Learn discounts" permission (ShopSettings.learn.discounts) —
   *  independent of per-row learnEnabled, which applies only when this is on. */
  masterEnabled: boolean;
}) {
  const dt = useDateTime();
  const { submit, pendingIntent } = useTrainingFetcher();
  const syncWatch = useSyncWatcher(props.lastSyncedAt, "Discounts synced");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [learnFilter, setLearnFilter] = useState<LearnFilter>("");

  const rows = props.rows.filter(
    (row) =>
      (!statusFilter ||
        (statusFilter === "active" ? row.status === "active" : row.status !== "active")) &&
      (!learnFilter || row.learnEnabled === (learnFilter === "on")),
  );
  const learned = props.rows.filter((r) => r.learnEnabled).length;

  // Master switch = major setting → Save/Discard bar; row toggles stay instant.
  const master = useMasterLearnDraft(props.masterEnabled, (enabled) =>
    submit("learn-master", { type: "discounts", enabled: enabled ? "true" : "false" }),
  );

  return (
    <s-stack gap="base">
      <SaveBar
        dirty={master.dirty}
        saving={pendingIntent === "learn-master"}
        onSave={master.onSave}
        onDiscard={master.onDiscard}
      />
      <LearnCard
        title="Discounts"
        chip={`${props.masterEnabled ? learned : 0} of ${props.rows.length} discounts learned`}
        description="Enable your AI agent to answer customer questions about discounts."
        switchChecked={master.draft}
        switchLabel="Learn discounts"
        onSwitch={master.setDraft}
      />

      <s-section heading="Manage discounts">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
            {/* Webhooks on every plan — no real-time switch, no plan gate. */}
            <SyncStatus type="discounts" lastSyncedAt={props.lastSyncedAt} running={syncWatch.syncing} />
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
                Sync discounts
              </s-button>
            </s-stack>
          </s-grid>

          <DataTable
            rows={rows}
            searchAlwaysOpen
            searchPlaceholder="Search discounts"
            searchFn={(row, q) =>
              row.title.toLowerCase().includes(q) || row.summary.toLowerCase().includes(q)
            }
            emptyMessage="No items found"
            perPage={10}
            hoverable
            toolbar={
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <FilterSelect
                  label="Status"
                  value={statusFilter}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                  ]}
                  onChange={(v) => setStatusFilter(v as StatusFilter)}
                />
                <FilterSelect
                  label="Learning"
                  value={learnFilter}
                  options={[
                    { value: "on", label: "Learning on" },
                    { value: "off", label: "Learning off" },
                  ]}
                  onChange={(v) => setLearnFilter(v as LearnFilter)}
                />
              </div>
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
                // Title + the summary ("20% off all products…") — kept, unlike
                // pages/blogs, because for a discount the summary IS the offer
                // and often says more than the internal title. One line each;
                // the full summary shows on hover.
                render: (row) => (
                  <s-stack gap="small-500">
                    <s-text type="strong">{row.title}</s-text>
                    {row.summary ? (
                      <div
                        title={row.summary}
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <s-text color="subdued">{row.summary}</s-text>
                      </div>
                    ) : null}
                  </s-stack>
                ),
                width: 200,
              },
              {
                key: "status",
                title: "Status",
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                key: "method",
                title: "Method",
                // The code sits under the method rather than in a column of its
                // own — the table is already wide, and the code is only ever
                // meaningful for the "Code" method. It is what the AI agent now
                // quotes to shoppers, so the merchant should see exactly what
                // was synced.
                render: (row) =>
                  row.method === "automatic" ? (
                    <s-text tone="neutral">Automatic</s-text>
                  ) : (
                    <s-stack gap="small-500">
                      <s-text tone="neutral">Code</s-text>
                      {row.code ? <s-text color="subdued">{row.code}</s-text> : null}
                    </s-stack>
                  ),
              },
              {
                key: "type",
                title: "Type",
                render: (row) => {
                  const meta = TYPE_META[row.discountType] ?? TYPE_META.amount_off_order;
                  return (
                    <s-stack gap="small-300">
                      <s-icon type={meta.icon} size="small" />
                      <s-text color="subdued">{meta.label}</s-text>
                    </s-stack>
                  );
                },
                width:120
              },
              {
                key: "startsAt",
                title: "Start date",
                render: (row) => <s-text tone="neutral">{row.startsAt ? dt.date(row.startsAt) : "—"}</s-text>,
                width:85
              },
              {
                key: "endsAt",
                title: "End date",
                render: (row) => (
                  <s-text tone="neutral">{row.endsAt ? dt.date(row.endsAt) : "-"}</s-text>
                ),
                width:85
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
                render: (row) => (
                  <s-switch
                    label={`AI learning for ${row.title}`}
                    labelAccessibilityVisibility="exclusive"
                    checked={row.learnEnabled}
                    onInput={(e) =>
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

import { useDateTime } from "../lib/format/context";