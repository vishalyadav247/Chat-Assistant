import { useMemo, useState } from "react";
import type { CollectionRow } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import {
  AutoSyncControl,
  LearnCard,
  SubTabs,
  useSyncWatcher,
  useTrainingFetcher,
} from "./TrainingShared";

// Collections tab (spec 07, design #viewTraining → Collections): learn card
// with master switch (Collection.learnEnabled defaults to false per design),
// Sync collections button, table with per-row learn toggle.

type SubTab = "all" | "active" | "inactive";

export function TrainingCollectionsTab(props: {
  rows: CollectionRow[];
  lastSyncedAt: string | null;
  /** Master "Learn collections" permission (ShopSettings.learn.collections) —
   *  independent of per-row learnEnabled, which applies only when this is on. */
  masterEnabled: boolean;
  /** Plan feature `catalog_auto_sync` (Pro+) — toggle is locked when false. */
  autoSyncAvailable: boolean;
  /** ShopSettings.catalogAutoSync.collections — daily full re-sync (webhooks unaffected). */
  autoSyncEnabled: boolean;
}) {
  const { submit, pendingIntent } = useTrainingFetcher();
  const syncWatch = useSyncWatcher(props.lastSyncedAt, "Collections synced");
  const [subTab, setSubTab] = useState<SubTab>("all");

  const learned = props.rows.filter((row) => row.learnEnabled).length;

  const rows = useMemo(() => {
    if (subTab === "all") return props.rows;
    return props.rows.filter((row) => (subTab === "active" ? row.learnEnabled : !row.learnEnabled));
  }, [props.rows, subTab]);

  return (
    <s-stack gap="base">
      <LearnCard
        title="Collections"
        chip={`${props.masterEnabled ? learned : 0} of ${props.rows.length} collections learned`}
        description="Help customers discover collections, understand product groupings and curated selections in your store."
        switchChecked={props.masterEnabled}
        switchLabel="Learn collections"
        onSwitch={(checked) =>
          submit("learn-master", { type: "collections", enabled: checked ? "true" : "false" })
        }
      />

      <s-section heading="Manage data">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
            <AutoSyncControl
              type="collections"
              available={props.autoSyncAvailable}
              enabled={props.autoSyncEnabled}
              busy={pendingIntent === "catalog-autosync"}
              lastSyncedAt={props.lastSyncedAt}
              running={syncWatch.syncing}
              onChange={(enabled) =>
                submit("catalog-autosync", { type: "collections", enabled: enabled ? "true" : "false" })
              }
            />
            <s-button
              variant="primary"
              icon="refresh"
              loading={syncWatch.syncing || pendingIntent === "sync-collections"}
              onClick={() => {
                submit("sync-collections");
                syncWatch.start();
              }}
            >
              Sync collections
            </s-button>
          </s-grid>

          <DataTable
            rows={rows}
            searchPlaceholder="Search collections"
            searchFn={(row, q) => row.title.toLowerCase().includes(q)}
            emptyMessage="No collections found. Run a sync to import them."
            perPage={10}
            hoverable
            toolbar={
              <SubTabs
                tabs={[
                  { id: "all", label: "All" },
                  { id: "active", label: "Learning on" },
                  { id: "inactive", label: "Learning off" },
                ]}
                active={subTab}
                onChange={setSubTab}
              />
            }
            bulkActions={(ids, clear) => (
              <>
                <s-button
                  disabled={pendingIntent === "collections-learn"}
                  onClick={() => {
                    submit("collections-learn", { ids: ids.join(","), enabled: "true" });
                    clear();
                  }}
                >
                  Enable learning
                </s-button>
                <s-button
                  disabled={pendingIntent === "collections-learn"}
                  onClick={() => {
                    submit("collections-learn", { ids: ids.join(","), enabled: "false" });
                    clear();
                  }}
                >
                  Disable learning
                </s-button>
              </>
            )}
            columns={[
              {
                key: "title",
                title: "Title",
                render: (row) => <s-text type="strong">{row.title}</s-text>,
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
                key: "learn",
                title: "AI Learn",
                width: 110, // keeps the heading on one line; left-aligned like the other tabs
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
