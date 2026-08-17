import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate, useRevalidator } from "react-router";
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
            onChange={(e) => props.onSwitch?.(e.currentTarget.checked)}
          />
        ) : null}
      </s-grid>
    </s-section>
  );
}

/**
 * Auto-sync toggle for the Products / Collections "Manage data" rows
 * (2026-08-17, mirrors the Discounts real-time switch): controls the DAILY
 * full re-sync only (webhooks always apply); switch + plan lock, with the
 * last-updated line directly underneath.
 */
export function AutoSyncControl(props: {
  type: "products" | "collections";
  available: boolean;
  enabled: boolean;
  busy: boolean;
  lastSyncedAt: string | null;
  running: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <SyncControlLayout
      toggle={
        <s-switch
          label="Auto sync"
          checked={props.available && props.enabled}
          disabled={!props.available || props.busy}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
      }
      info={
        props.available
          ? `Re-syncs all ${props.type} from Shopify once a day.`
          : `Available on Pro and Plus plans — re-syncs all ${props.type} once a day. Individual changes still update instantly.`
      }
      locked={!props.available}
      lastSyncedAt={props.lastSyncedAt}
      running={props.running}
    />
  );
}

/**
 * Shared layout for the sync switches (Products / Collections auto sync,
 * Discounts real-time sync): row 1 = [switch] [what it does] [Pro + Upgrade
 * when locked]; row 2 = last updated (+ "Sync running" badge).
 */
export function SyncControlLayout(props: {
  toggle: React.ReactNode;
  info: string;
  locked?: boolean;
  lastSyncedAt: string | null;
  running?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <s-stack gap="none">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        {props.toggle}
        <s-text color="subdued">{props.info}</s-text>
        {props.locked ? (
          <>
            <s-badge tone="info">Pro</s-badge>
            <s-button variant="tertiary" onClick={() => navigate("/app/plan-usage")}>
              Upgrade
            </s-button>
          </>
        ) : null}
      </s-stack>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-icon type="clock" tone="neutral" size="small" />
        <s-text color="subdued">Last updated {formatDateTime(props.lastSyncedAt)}</s-text>
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
