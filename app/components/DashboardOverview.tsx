import type { DashboardMetrics, DashboardRange } from "../lib/dashboard/dashboard.server";
import { StatGrid, StatTile } from "./StatTile";

// Overview KPI card (spec 13, design dashboard.html #rangeBtn/#reloadBtn +
// .ov-kpis): range dropdown, compare-to label, Reload, four KPI tiles.
// DELTA (spec 13): "Assisted revenue" / "Total sales share" wait on the
// orders-scope decision — v1 shows Chat add-to-carts as the assisted proxy.

const RANGE_LABELS: Record<DashboardRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "12m": "Last 12 months",
};

function formatCompare(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${day(from)} – ${day(to)} ${to.getFullYear()}`;
}

function deltaProps(delta: number | null): { value: string; direction: "up" | "down" } | undefined {
  if (delta === null || delta === 0) return undefined;
  return { value: `${Math.abs(delta)}%`, direction: delta > 0 ? "up" : "down" };
}

export function DashboardOverview(props: {
  metrics: DashboardMetrics;
  range: DashboardRange;
  reloading: boolean;
  onRangeChange: (range: DashboardRange) => void;
  onReload: () => void;
}) {
  const m = props.metrics;
  const n = (value: number) => value.toLocaleString("en-US");

  return (
    <s-section heading="Overview">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-select
              label="Date range"
              labelAccessibilityVisibility="exclusive"
              value={props.range}
              onChange={(e) => props.onRangeChange(e.currentTarget.value as DashboardRange)}
            >
              {(Object.keys(RANGE_LABELS) as DashboardRange[]).map((range) => (
                <s-option key={range} value={range}>
                  {RANGE_LABELS[range]}
                </s-option>
              ))}
            </s-select>
            <s-text tone="neutral">
              Compare to: {formatCompare(m.compare.from, m.compare.to)}
            </s-text>
          </s-stack>
          <s-button disabled={props.reloading} onClick={props.onReload}>
            {props.reloading ? "Reloading…" : "Reload"}
          </s-button>
        </s-stack>

        <StatGrid>
          <StatTile
            label="Total conversations"
            value={n(m.totalConversations)}
            delta={deltaProps(m.totalDelta)}
            sub={m.totalDelta === null ? `vs previous ${RANGE_LABELS[m.range].toLowerCase().replace("last ", "")}` : undefined}
          />
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text tone="neutral">Live conversations</s-text>
              <s-heading>{n(m.liveCount)}</s-heading>
              <s-text tone={m.liveCount > 0 ? "success" : "neutral"}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {m.liveCount > 0 ? (
                    <span
                      aria-hidden
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "#16a34a",
                        display: "inline-block",
                        animation: "cc-pulse 1.6s ease-in-out infinite",
                      }}
                    />
                  ) : null}
                  {m.liveCount > 0 ? "live now" : "none right now"}
                </span>
              </s-text>
            </s-stack>
          </s-box>
          <StatTile
            label="Chat add-to-carts"
            value={n(m.atcCount)}
            delta={deltaProps(m.atcDelta)}
            sub="Assisted-revenue proxy — order attribution coming with the orders scope."
          />
          <StatTile
            label="Resolution rate"
            value={`${m.resolutionRate.pct}%`}
            sub={`Resolved: ${n(m.resolutionRate.resolved)} · Total: ${n(m.resolutionRate.total)}`}
          />
        </StatGrid>
      </s-stack>
    </s-section>
  );
}
