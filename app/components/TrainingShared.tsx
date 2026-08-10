import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { TrainingActionResult } from "../routes/app.ai-agent.training";

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

/** Sub-tab pill row (All / Active / Inactive, source-type filters, …). */
export function SubTabs<T extends string>(props: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (tab: T) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "inline-flex",
        gap: 4,
        background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
        borderRadius: 10,
        padding: 3,
        width: "fit-content",
        flexWrap: "wrap",
      }}
    >
      {props.tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={props.active === t.id}
          onClick={() => props.onChange(t.id)}
          style={{
            border: "none",
            cursor: "pointer",
            font: "inherit",
            fontSize: 12,
            fontWeight: 650,
            padding: "5px 12px",
            borderRadius: 8,
            background: props.active === t.id ? "var(--s-color-bg, #fff)" : "transparent",
            boxShadow: props.active === t.id ? "0 1px 2px rgba(20,20,25,.12)" : "none",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
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
