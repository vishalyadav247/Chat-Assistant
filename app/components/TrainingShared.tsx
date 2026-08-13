import { useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { TrainingActionResult } from "../routes/app.ai-agent.training";
import { TabPills } from "./ui/TabPills";

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

  const busy = fetcher.state !== "idle";
  // Intent currently in flight — lets each button show its own spinner.
  const pendingIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";

  return { fetcher, submit, busy, pendingIntent };
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

/** Learn card: title + count chip + description + optional master switch. */
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
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <s-heading>{props.title}</s-heading>
            <s-badge tone="neutral">{props.chip}</s-badge>
          </div>
          <s-paragraph>{props.description}</s-paragraph>
        </div>
        {props.onSwitch ? (
          <s-switch
            label={props.switchLabel ?? `Learn ${props.title.toLowerCase()}`}
            labelAccessibilityVisibility="exclusive"
            checked={props.switchChecked}
            disabled={props.switchDisabled}
            onChange={(e) => props.onSwitch?.(e.currentTarget.checked)}
          />
        ) : null}
      </div>
    </s-section>
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

export function formatDateTime(iso: string | null): string {
  if (!iso) return "N/A";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString(undefined, {
    year: "2-digit",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
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
