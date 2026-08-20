import type { DashboardMetrics, DashboardRange } from "../lib/dashboard/dashboard.server";
import { StatGrid, StatTile } from "./ui/StatTile";
import { Toolbar } from "./ui/Row";
import { useDateTime, type DateTimeApi } from "../lib/format/context";

// Overview KPI card (spec 13, design dashboard.html #rangeBtn/#reloadBtn +
// .ov-kpis): range dropdown, compare-to label, Reload, four KPI tiles with
// icon chips + sparklines per the reference design.
// DELTA (spec 13): "Assisted revenue" / "Total sales share" wait on the
// orders-scope decision — v1 shows Chat add-to-carts as the assisted proxy.

const RANGE_LABELS: Record<DashboardRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "12m": "Last 12 months",
};

function formatCompare(fromIso: string, toIso: string, dt: DateTimeApi): string {
  return `${dt.date(fromIso, { year: false })} – ${dt.date(toIso)}`;
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
  const dt = useDateTime();
  const m = props.metrics;
  const n = (value: number) => value.toLocaleString("en-US");

  return (
    <s-section heading="Overview">
      <s-stack gap="base">
        <Toolbar
          end={
            <s-button disabled={props.reloading} onClick={props.onReload}>
              {props.reloading ? "Reloading…" : "Reload"}
            </s-button>
          }
        >
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
            Compare to: {formatCompare(m.compare.from, m.compare.to, dt)}
          </s-text>
        </Toolbar>

        <StatGrid>
          <StatTile
            label="Total conversations"
            value={n(m.totalConversations)}
            icon="chat"
            tone="accent"
            delta={deltaProps(m.totalDelta)}
            spark={m.series.conversations}
          />
          <StatTile
            label="Live conversations"
            value={n(m.liveCount)}
            icon="live"
            tone="success"
            live={m.liveCount > 0}
            sub={m.liveCount === 0 ? "none right now" : undefined}
          />
          <StatTile
            label="Chat add-to-carts"
            value={n(m.atcCount)}
            icon="cart-up"
            tone="info"
            delta={deltaProps(m.atcDelta)}
            spark={m.series.atc}
            sub="Assisted-revenue proxy until the orders scope lands"
          />
          <StatTile
            label="Resolution rate"
            value={`${m.resolutionRate.pct}%`}
            icon="check-circle"
            tone="success"
            sub={`Resolved: ${n(m.resolutionRate.resolved)} · Total: ${n(m.resolutionRate.total)}`}
          />
        </StatGrid>
      </s-stack>
    </s-section>
  );
}
