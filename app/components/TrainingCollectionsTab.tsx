import { useMemo, useState } from "react";
import type { CollectionRow } from "../routes/app.ai-agent.training";
import { DataTable } from "./DataTable";
import {
  FilterSelect,
  SyncStatus,
  LearnCard,
  useMasterLearnDraft,
  useSyncWatcher,
  useTrainingFetcher,
} from "./TrainingShared";
import { SaveBar } from "./SaveBar";

// Collections tab (spec 07, design #viewTraining → Collections): learn card
// with master switch (Collection.learnEnabled defaults to false per design),
// Sync collections button, table with per-row learn toggle.

// FAQ-style filter dropdown (user, 2026-09-11 — replaced the SubTabs pills).
type LearnFilter = "" | "on" | "off";

export function TrainingCollectionsTab(props: {
  rows: CollectionRow[];
  lastSyncedAt: string | null;
  /** Master "Learn collections" permission (ShopSettings.learn.collections) —
   *  independent of per-row learnEnabled, which applies only when this is on. */
  masterEnabled: boolean;
}) {
  const { submit, pendingIntent } = useTrainingFetcher();
  const syncWatch = useSyncWatcher(props.lastSyncedAt, "Collections synced");
  const [learnFilter, setLearnFilter] = useState<LearnFilter>("");
  // Master switch = major setting → Save/Discard bar; row toggles stay instant.
  const master = useMasterLearnDraft(props.masterEnabled, (enabled) =>
    submit("learn-master", { type: "collections", enabled: enabled ? "true" : "false" }),
  );

  const learned = props.rows.filter((row) => row.learnEnabled).length;

  const rows = useMemo(() => {
    if (!learnFilter) return props.rows;
    return props.rows.filter((row) => row.learnEnabled === (learnFilter === "on"));
  }, [props.rows, learnFilter]);

  return (
    <s-stack gap="base">
      <SaveBar
        dirty={master.dirty}
        saving={pendingIntent === "learn-master"}
        onSave={master.onSave}
        onDiscard={master.onDiscard}
      />
      <LearnCard
        title="Collections"
        chip={`${props.masterEnabled ? learned : 0} of ${props.rows.length} collections learned`}
        description="Help customers discover collections, understand product groupings and curated selections in your store."
        switchChecked={master.draft}
        switchLabel="Learn collections"
        onSwitch={master.setDraft}
      />

      <s-section heading="Manage collections">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
            <SyncStatus type="collections" lastSyncedAt={props.lastSyncedAt} running={syncWatch.syncing} />
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
            searchAlwaysOpen
            searchPlaceholder="Search collections"
            searchFn={(row, q) => row.title.toLowerCase().includes(q)}
            emptyMessage="No collections found. Run a sync to import them."
            perPage={10}
            hoverable
            toolbar={
              <FilterSelect
                label="Learning"
                value={learnFilter}
                options={[
                  { value: "on", label: "Learning on" },
                  { value: "off", label: "Learning off" },
                ]}
                onChange={(v) => setLearnFilter(v as LearnFilter)}
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
                width: 260, // cap (user, 2026-09-11) — long prose wraps inside
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
                    onInput={(e) =>
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
