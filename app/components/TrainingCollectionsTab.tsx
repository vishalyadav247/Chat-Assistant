import { useMemo, useState } from "react";
import type { CollectionRow } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import { LearnCard, SubTabs, formatDateTime, useTrainingFetcher } from "./TrainingShared";

// Collections tab (spec 07, design #viewTraining → Collections): learn card
// with master switch (Collection.learnEnabled defaults to false per design),
// Sync collections button, table with per-row learn toggle.

type SubTab = "all" | "active" | "inactive";

export function TrainingCollectionsTab(props: {
  rows: CollectionRow[];
  lastSyncedAt: string | null;
}) {
  const { submit, busy } = useTrainingFetcher();
  const [subTab, setSubTab] = useState<SubTab>("all");

  const learned = props.rows.filter((row) => row.learnEnabled).length;
  const allLearned = props.rows.length > 0 && learned === props.rows.length;

  const rows = useMemo(() => {
    if (subTab === "all") return props.rows;
    return props.rows.filter((row) => (subTab === "active" ? row.learnEnabled : !row.learnEnabled));
  }, [props.rows, subTab]);

  return (
    <s-stack gap="base">
      <LearnCard
        title="Collections"
        chip={`${learned} of ${props.rows.length} collections learned`}
        description="Help customers discover collections, understand product groupings and curated selections in your store."
        switchChecked={allLearned}
        switchLabel="Learn all collections"
        switchDisabled={busy || props.rows.length === 0}
        onSwitch={(checked) =>
          submit("collections-learn-all", { enabled: checked ? "true" : "false" })
        }
      />

      <s-section heading="Manage data">
        <s-stack gap="base">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <s-text tone="neutral">
                Auto sync: Daily · Last updated: {formatDateTime(props.lastSyncedAt)}
              </s-text>
            </div>
            <s-button variant="primary" disabled={busy} onClick={() => submit("sync-collections")}>
              Sync collections
            </s-button>
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
            searchPlaceholder="Search collections"
            searchFn={(row, q) => row.title.toLowerCase().includes(q)}
            emptyMessage="No collections found. Run a sync to import them."
            perPage={10}
            columns={[
              {
                key: "title",
                title: "Title",
                render: (row) => <span style={{ fontWeight: 600 }}>{row.title}</span>,
              },
              {
                key: "description",
                title: "Description",
                render: (row) => (
                  <s-text tone="neutral">
                    {row.description
                      ? row.description.length > 80
                        ? `${row.description.slice(0, 80)}…`
                        : row.description
                      : "—"}
                  </s-text>
                ),
              },
              {
                key: "conditions",
                title: "Conditions",
                render: (row) => <s-text tone="neutral">{row.conditions}</s-text>,
              },
              {
                key: "products",
                title: "Products",
                render: (row) => <s-text tone="neutral">{String(row.productCount)}</s-text>,
              },
              {
                key: "status",
                title: "Status",
                render: (row) => (
                  <s-badge tone={row.learnEnabled ? "success" : "neutral"}>
                    {row.learnEnabled ? "Active" : "Inactive"}
                  </s-badge>
                ),
              },
              {
                key: "learn",
                title: "Learn",
                align: "end",
                render: (row) => (
                  <s-switch
                    label={`Learn ${row.title}`}
                    labelAccessibilityVisibility="exclusive"
                    checked={row.learnEnabled}
                    onChange={(e) =>
                      submit("collection-learn", {
                        id: row.id,
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
