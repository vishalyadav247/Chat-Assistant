import { useMemo, useState } from "react";
import type { ArticleRow, PageRow } from "../routes/app.ai-agent.training";
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
import { PlanBanner, PlanMeter } from "./ui/PlanGate";
import { useDateTime } from "../lib/format/context";

// Pages & Blogs tabs (spec 22) — the Collections tab pattern: learn card with
// master switch, plan meter, sync status + Sync button, table with per-row and
// bulk AI-learn toggles. One component for both; they differ by a column.
//
// Drafts arrive with learning OFF (never quote unreleased content) but stay
// listed, so a merchant can switch one on deliberately.

// FAQ-style filter dropdowns (user, 2026-09-11 — replaced the SubTabs pills).
type StatusFilter = "" | "published" | "draft";
type LearnFilter = "" | "on" | "off";
type Row = PageRow & Partial<Pick<ArticleRow, "blogTitle" | "author" | "tags">>;

const COPY = {
  pages: {
    title: "Pages",
    heading: "Manage pages",
    noun: "page",
    plural: "pages",
    description:
      "Teach the AI your store pages — About, FAQs, size guides, care instructions — synced straight from Shopify.",
    learnLabel: "Learn pages",
    syncLabel: "Sync pages",
    done: "Pages synced",
    empty: "No pages found. Click Sync pages to import them from Shopify.",
    search: "Search pages",
  },
  blogs: {
    title: "Blogs",
    heading: "Manage blogs",
    noun: "article",
    plural: "articles",
    description:
      "Teach the AI your blog articles — guides, how-tos and stories — synced straight from Shopify.",
    learnLabel: "Learn blogs",
    syncLabel: "Sync blogs",
    done: "Blogs synced",
    empty: "No blog articles found. Click Sync blogs to import them from Shopify.",
    search: "Search articles",
  },
} as const;

export function TrainingContentTab(props: {
  kind: "pages" | "blogs";
  rows: Row[];
  lastSyncedAt: string | null;
  /** Master "Learn pages/blogs" (ShopSettings.learn) — per-row flags apply only when on. */
  masterEnabled: boolean;
  /** pages_synced / articles_synced — plan cap + live bonus, as the sync enforces it. */
  syncedUsed: number;
  syncedQuota: number;
  syncedBonus: number;
  syncedNextPlan: string | null;
}) {
  const copy = COPY[props.kind];
  const dt = useDateTime();
  const { submit, pendingIntent } = useTrainingFetcher();
  const syncWatch = useSyncWatcher(props.lastSyncedAt, copy.done);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [learnFilter, setLearnFilter] = useState<LearnFilter>("");

  const singleIntent = props.kind === "pages" ? "page-learn" : "article-learn";
  const bulkIntent = props.kind === "pages" ? "pages-learn" : "articles-learn";
  const syncIntent = props.kind === "pages" ? "sync-pages" : "sync-blogs";

  const learned = props.rows.filter((row) => row.learnEnabled).length;
  const rows = useMemo(
    () =>
      props.rows.filter(
        (row) =>
          (!statusFilter || row.isPublished === (statusFilter === "published")) &&
          (!learnFilter || row.learnEnabled === (learnFilter === "on")),
      ),
    [props.rows, statusFilter, learnFilter],
  );

  const atLimit = props.syncedUsed >= props.syncedQuota;

  // Master switch = major setting → Save/Discard bar; row toggles stay instant.
  const master = useMasterLearnDraft(props.masterEnabled, (enabled) =>
    submit("learn-master", { type: props.kind, enabled: enabled ? "true" : "false" }),
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
        title={copy.title}
        chip={`${props.masterEnabled ? learned : 0} of ${props.rows.length} ${copy.plural} learned`}
        description={copy.description}
        switchChecked={master.draft}
        switchLabel={copy.learnLabel}
        onSwitch={master.setDraft}
      />

      <s-section heading={copy.heading}>
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
            <SyncStatus type={props.kind} lastSyncedAt={props.lastSyncedAt} running={syncWatch.syncing} />
            <s-button
              variant="primary"
              icon="refresh"
              loading={syncWatch.syncing || pendingIntent === syncIntent}
              onClick={() => {
                submit(syncIntent);
                syncWatch.start();
              }}
            >
              {copy.syncLabel}
            </s-button>
          </s-grid>

          {props.syncedBonus > 0 ? (
            <s-banner tone="success">
              Includes <b>{props.syncedBonus.toLocaleString("en-US")}</b> bonus {copy.noun}
              {props.syncedBonus === 1 ? "" : "s"} on top of your plan, added by the ChatConvert
              team. Your limit returns to the plan amount if they are withdrawn.
            </s-banner>
          ) : null}
          <PlanMeter
            used={props.syncedUsed}
            quota={props.syncedQuota}
            label={`${copy.plural} synced`}
            nextPlan={props.syncedNextPlan}
          />
          {atLimit && props.syncedQuota > 0 ? (
            <PlanBanner
              plan={props.syncedNextPlan}
              tone="warning"
              heading={`You've reached this plan's ${copy.noun} limit`}
            >
              Only your {props.syncedQuota.toLocaleString("en-US")} most recently updated{" "}
              {copy.plural} are synced; the rest aren&apos;t available to the AI.
            </PlanBanner>
          ) : null}

          <DataTable
            rows={rows}
            searchAlwaysOpen
            searchPlaceholder={copy.search}
            searchFn={(row, q) =>
              row.title.toLowerCase().includes(q) ||
              (row.blogTitle ?? "").toLowerCase().includes(q) ||
              (row.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
            }
            emptyMessage={copy.empty}
            perPage={10}
            hoverable
            toolbar={
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <FilterSelect
                  label="Status"
                  value={statusFilter}
                  options={[
                    { value: "published", label: "Published" },
                    { value: "draft", label: "Draft" },
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
                  disabled={pendingIntent === bulkIntent}
                  onClick={() => {
                    submit(bulkIntent, { ids: ids.join(","), enabled: "true" });
                    clear();
                  }}
                >
                  Enable learning
                </s-button>
                <s-button
                  disabled={pendingIntent === bulkIntent}
                  onClick={() => {
                    submit(bulkIntent, { ids: ids.join(","), enabled: "false" });
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
                width: 260, // cap (user, 2026-09-11) — title only, no excerpt
                render: (row) => (
                  // Empty-body warning survives as a hover tooltip: pages built
                  // from theme sections expose no body via the Admin API, so
                  // "learning on" must not imply the AI knows this page.
                  <span
                    title={
                      row.excerpt
                        ? row.excerpt
                        : `No text in Shopify's ${copy.noun} content — nothing for the AI to learn`
                    }
                  >
                    <s-text type="strong">{row.title}</s-text>
                  </span>
                ),
              },
              ...(props.kind === "blogs"
                ? [
                    {
                      key: "blog",
                      title: "Blog",
                      render: (row: Row) => (
                        <s-stack gap="small-500">
                          <s-text tone="neutral">{row.blogTitle || "—"}</s-text>
                          {row.author ? <s-text color="subdued">{row.author}</s-text> : null}
                        </s-stack>
                      ),
                    },
                  ]
                : []),
              {
                key: "status",
                title: "Status",
                render: (row) =>
                  row.isPublished ? (
                    <s-badge tone="success">Published</s-badge>
                  ) : (
                    <s-badge>Draft</s-badge>
                  ),
              },
              {
                key: "updated",
                title: "Updated",
                render: (row) => (
                  <s-text tone="neutral">{row.updatedAt ? dt.date(row.updatedAt) : "—"}</s-text>
                ),
              },
              {
                key: "learn",
                title: "AI Learn",
                width: 110,
                render: (row) => (
                  <s-switch
                    label={`Learn ${row.title}`}
                    labelAccessibilityVisibility="exclusive"
                    checked={row.learnEnabled}
                    onInput={(e) =>
                      submit(singleIntent, {
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
