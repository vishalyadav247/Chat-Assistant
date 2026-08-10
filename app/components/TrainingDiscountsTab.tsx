import { useNavigate } from "react-router";
import type { DiscountRow } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import { LearnCard, StatusBadge, formatDate, formatDateTime, useTrainingFetcher } from "./TrainingShared";

// Discounts tab (spec 07, design #viewTraining → Discounts): upgrade banner
// for plans without real-time discount sync (hidden while plan enforcement is
// in open mode — the condition is server-computed via hasFeature), learn card,
// manage card with the real-time mini switch + manual Sync now.

export function TrainingDiscountsTab(props: {
  rows: DiscountRow[];
  lastSyncedAt: string | null;
  showUpgradeBanner: boolean;
  realtime: boolean;
}) {
  const { submit, busy } = useTrainingFetcher();
  const navigate = useNavigate();

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
        chip={`${props.rows.length} discounts learned`}
        description="Enable your AI agent to answer customer questions about discounts."
      />

      <s-section heading="Manage data">
        <s-stack gap="base">
          <s-paragraph>
            Pull the latest discount data from your Shopify store including discount codes and
            automatic discounts.
          </s-paragraph>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              title={
                props.realtime
                  ? "Discount webhooks keep this data fresh automatically"
                  : "Available on Pro and Plus plans"
              }
            >
              <s-switch
                label="Real-time sync"
                checked={props.realtime}
                disabled={true}
              />
            </span>
            <s-text tone="neutral">· Last updated: {formatDateTime(props.lastSyncedAt)}</s-text>
            <span style={{ marginLeft: "auto" }}>
              <s-button variant="primary" disabled={busy} onClick={() => submit("sync-discounts")}>
                Sync now
              </s-button>
            </span>
          </div>

          <DataTable
            rows={props.rows}
            searchPlaceholder="Search discounts"
            searchFn={(row, q) => row.title.toLowerCase().includes(q)}
            emptyMessage="No items found"
            perPage={10}
            columns={[
              {
                key: "title",
                title: "Title",
                render: (row) => <span style={{ fontWeight: 600 }}>{row.title}</span>,
              },
              {
                key: "summary",
                title: "Summary",
                render: (row) => <s-text tone="neutral">{row.summary || "—"}</s-text>,
              },
              {
                key: "status",
                title: "Status",
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                key: "startsAt",
                title: "Starts",
                render: (row) => <s-text tone="neutral">{formatDate(row.startsAt)}</s-text>,
              },
              {
                key: "endsAt",
                title: "Ends",
                render: (row) => <s-text tone="neutral">{formatDate(row.endsAt)}</s-text>,
              },
            ]}
          />
        </s-stack>
      </s-section>
    </s-stack>
  );
}
