import { useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
import type { TrainingActionResult } from "../routes/app.ai-agent.training";
import { TabPills } from "./ui/TabPills";
import { useDateTime } from "../lib/format/context";

// Shared bits for the AI Agent training tabs (spec 07).

/**
 * Fetcher wrapper for training actions: submits {intent, ...fields}, shows a
 * toast for message/error results, and hands each fresh result to onResult.
 */
export function useTrainingFetcher(onResult?: (result: TrainingActionResult) => void) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<TrainingActionResult>();
  const processed = useRef<unknown>(null);
  const callback = useRef(onResult);
  callback.current = onResult;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || processed.current === fetcher.data) return;
    processed.current = fetcher.data;
    const result = fetcher.data;
    if (!result.ok && result.error) shopify.toast.show(result.error, { isError: true });
    else if (result.ok && result.message) shopify.toast.show(result.message);
    callback.current?.(result);
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent: string, fields: Record<string, string> = {}) => {
    fetcher.submit({ intent, ...fields }, { method: "post" });
  };
  /** Multipart post, for file uploads (lookup tables, spec 28). */
  const submitForm = (intent: string, form: FormData) => {
    form.set("intent", intent);
    fetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  };

  const busy = fetcher.state !== "idle";
  // Intent currently in flight — lets each button show its own spinner.
  const pendingIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";

  return { fetcher, submit, submitForm, busy, pendingIntent };
}

/**
 * Tracks a background sync job to completion. The sync intents only ENQUEUE a
 * job; the job stamps SyncState.<type>SyncAt when it finishes. This hook polls
 * the route loader until that timestamp moves past the value captured at
 * start() — the same revalidation that flips `syncing` off also refreshes the
 * table rows, so content and the completion toast land together.
 */
export function useSyncWatcher(lastSyncedAt: string | null, doneMessage: string) {
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [syncing, setSyncing] = useState(false);
  const baseline = useRef<string | null>(null);
  const startedAt = useRef(0);

  const start = () => {
    baseline.current = lastSyncedAt;
    startedAt.current = Date.now();
    setSyncing(true);
  };

  useEffect(() => {
    if (!syncing) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(id);
  }, [syncing, revalidator]);

  useEffect(() => {
    if (!syncing) return;
    if (lastSyncedAt && lastSyncedAt !== baseline.current) {
      setSyncing(false);
      shopify.toast.show(doneMessage);
    } else if (Date.now() - startedAt.current > 180_000) {
      // Backstop so a failed job doesn't spin forever (jobs retry on their own).
      setSyncing(false);
      shopify.toast.show("Sync is taking longer than expected — check back shortly", {
        isError: true,
      });
    }
  }, [syncing, lastSyncedAt, doneMessage, shopify]);

  return { syncing, start };
}

/**
 * Live status for the Knowledge tab's data sources — every type (url, file,
 * pages, faq, legacy manual/csv).
 *
 * Adding or re-syncing a source only sets the row to "pending" and enqueues a
 * pg-boss job; the job flips it to active/error when it finishes. Nothing
 * pushed that back to the browser, so the table sat on "Pending" until the
 * merchant reloaded.
 *
 * Unlike useSyncWatcher this needs no baseline and no start() call: the row
 * status IS the signal. That also means it catches an ingest this tab did not
 * start — the weekly re-crawl cron, another browser tab, a teammate.
 *
 * The interval widens with elapsed time because a sitemap crawl of 20 pages
 * plus embedding runs for minutes, and a fixed 2.5s poll would fire hundreds of
 * loader revalidations across it. Paused while the tab is hidden.
 */
export function usePendingSources(
  sources: Array<{ id: string; name: string; status: string }>,
): { pendingCount: number } {
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  // Latest-ref so the polling chain is not torn down and restarted every time
  // revalidator.state flips — that would reset the backoff on every tick.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const startedAt = useRef(0);
  const gaveUp = useRef(false);
  const lastStatus = useRef<Map<string, string>>(new Map());

  const pendingCount = sources.reduce((n, s) => (s.status === "pending" ? n + 1 : n), 0);
  const watching = pendingCount > 0;
  // The real dependency of the toast effect: `sources` is a fresh array on
  // every render, so depending on it would re-run the effect constantly.
  const statusKey = sources.map((s) => `${s.id}:${s.status}`).join("|");

  useEffect(() => {
    if (!watching) {
      startedAt.current = 0;
      gaveUp.current = false;
      return;
    }
    if (!startedAt.current) startedAt.current = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const elapsed = Date.now() - startedAt.current;
      if (elapsed > 15 * 60_000) {
        // Backstop so a dead job doesn't poll forever (jobs retry on their own).
        if (!gaveUp.current) {
          gaveUp.current = true;
          shopify.toast.show("Still processing — check back shortly", { isError: true });
        }
        return;
      }
      const visible = typeof document === "undefined" || !document.hidden;
      if (visible && revalidatorRef.current.state === "idle") {
        revalidatorRef.current.revalidate();
      }
      timer = setTimeout(tick, elapsed < 30_000 ? 2500 : elapsed < 120_000 ? 5000 : 10_000);
    };
    timer = setTimeout(tick, 2500);
    return () => clearTimeout(timer);
  }, [watching, shopify]);

  useEffect(() => {
    for (const source of sources) {
      if (lastStatus.current.get(source.id) === "pending" && source.status !== "pending") {
        if (source.status === "error") {
          shopify.toast.show(`${source.name} could not be synced`, { isError: true });
        } else {
          shopify.toast.show(`${source.name} is ready`);
        }
      }
    }
    lastStatus.current = new Map(sources.map((s) => [s.id, s.status]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey, shopify]);

  return { pendingCount };
}

/** Learn card: title + count chip + description + optional master switch. */
/**
 * FAQ-style filter dropdown for a DataTable toolbar (user, 2026-09-11 —
 * the pattern that replaced SubTabs pills on the training tabs): a compact
 * fixed-width select whose first option is "<Label>: All" ("" value).
 */
export function FilterSelect(props: {
  label: string;
  /** "" = All. */
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  width?: number;
}) {
  return (
    <div style={{ width: props.width ?? 160 }}>
      <s-select
        label={props.label}
        labelAccessibilityVisibility="exclusive"
        value={props.value || "all"}
        onInput={(e) => {
          const v = e.currentTarget.value;
          props.onChange(v === "all" ? "" : v);
        }}
      >
        <s-option value="all">{props.label}: All</s-option>
        {props.options.map((o) => (
          <s-option key={o.value} value={o.value}>
            {o.label}
          </s-option>
        ))}
      </s-select>
    </div>
  );
}

/**
 * Draft state for a tab's MASTER learn switch (user decision 2026-09-11):
 * the top-level switch is a major setting, so it arms the contextual
 * Save/Discard bar instead of applying on click — while the per-row toggles
 * stay immediate (their toast is the confirmation). The draft re-syncs from
 * the saved value after the loader revalidates a successful save.
 */
export function useMasterLearnDraft(saved: boolean, save: (enabled: boolean) => void) {
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  return {
    draft,
    setDraft,
    dirty: draft !== saved,
    onSave: () => save(draft),
    onDiscard: () => setDraft(saved),
  };
}

export function LearnCard(props: {
  title: string;
  chip: string;
  description: string;
  switchChecked?: boolean;
  switchLabel?: string;
  onSwitch?: (checked: boolean) => void;
  switchDisabled?: boolean;
}) {
  return (
    <s-section>
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>{props.title}</s-heading>
            <s-badge tone={props.switchChecked === false ? "neutral" : "info"}>{props.chip}</s-badge>
          </s-stack>
          <s-paragraph color="subdued">{props.description}</s-paragraph>
        </s-stack>
        {props.onSwitch ? (
          <s-switch
            label={props.switchLabel ?? `Learn ${props.title.toLowerCase()}`}
            checked={props.switchChecked}
            disabled={props.switchDisabled}
            onInput={(e) => props.onSwitch?.(e.currentTarget.checked)}
          />
        ) : null}
      </s-grid>
    </s-section>
  );
}

/**
 * How a Training tab's data stays current, plus its last-synced line
 * There is no Auto sync or real-time switch and no
 * plan gate any more: keeping synced data correct is the app's job, not a
 * merchant setting.
 *
 *  - products / discounts: Shopify webhooks, processed on every plan.
 *  - collections: webhooks for the collection itself; smart-collection
 *    MEMBERSHIP (driven by product tags) has no webhook, so the weekly
 *    background sync refreshes it.
 *  - pages / blogs: Shopify has no webhooks at all, so the weekly background
 *    sync is what updates them.
 * The manual Sync button beside this is always available.
 */
const SYNC_INFO: Record<SyncType, string> = {
  products: "Updates automatically whenever a product changes in Shopify.",
  collections:
    "Updates automatically when a collection changes in Shopify. Smart-collection membership refreshes weekly.",
  discounts: "Updates automatically whenever a discount changes in Shopify.",
  pages: "Shopify doesn't notify apps about page edits, so pages refresh automatically once a week. Click Sync to update now.",
  blogs: "Shopify doesn't notify apps about blog edits, so articles refresh automatically once a week. Click Sync to update now.",
};

export type SyncType = "products" | "collections" | "discounts" | "pages" | "blogs";

export function SyncStatus(props: { type: SyncType; lastSyncedAt: string | null; running?: boolean }) {
  const dt = useDateTime();
  return (
    <s-stack gap="none">
      <s-text color="subdued">{SYNC_INFO[props.type]}</s-text>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-icon type="clock" tone="neutral" size="small" />
        <s-text color="subdued">Last synced {props.lastSyncedAt ? dt.dateTime(props.lastSyncedAt) : "never"}</s-text>
        {props.running ? <s-badge tone="info">Sync running</s-badge> : null}
      </s-stack>
    </s-stack>
  );
}

/** Sub-tab pill row — thin wrapper over the shared TabPills (small size). */
export function SubTabs<T extends string>(props: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (tab: T) => void;
}) {
  return (
    <TabPills tabs={props.tabs} active={props.active} onChange={props.onChange} size="small" />
  );
}

export function StatusBadge(props: { status: string; error?: string | null }) {
  const status = props.status.toLowerCase();
  const tone =
    status === "active" || status === "published"
      ? ("success" as const)
      : status === "error"
        ? ("critical" as const)
        : status === "pending"
          ? ("warning" as const)
          : status === "draft"
            ? ("info" as const)
            : ("neutral" as const);
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span title={status === "error" && props.error ? props.error : undefined}>
      <s-badge tone={tone}>{label}</s-badge>
    </span>
  );
}


/** Trigger a client-side text-file download (CSV export in an embedded iframe). */
export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
