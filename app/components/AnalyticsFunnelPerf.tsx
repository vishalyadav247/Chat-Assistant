import type {
  RecommendationFunnel,
  ResponsePerformance,
} from "../lib/analytics/shared";
import { humanizeMs } from "../lib/analytics/shared";
import { StatGrid, StatTile } from "./ui/StatTile";
import { BRAND } from "./ui/tokens";

// Recommendation funnel + response performance cards (spec 14, design
// analytics.html .funnel / .stat-grid).
// DELTA (spec 14): the "Purchased" funnel stage renders "—" until order
// attribution lands (cart-attribute method / orders scope, spec 12/17).

function FunnelRow(props: { name: string; value: string; pct: number | null; color: string }) {
  return (
    <s-stack gap="small-300">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center">
        <s-text>{props.name}</s-text>
        <s-text type="strong">{props.value}</s-text>
      </s-stack>
      <div
        style={{
          height: 30,
          borderRadius: 8,
          background: "var(--s-color-bg-subdued, #f1f1f3)",
          overflow: "hidden",
        }}
      >
        {props.pct !== null && props.pct > 0 ? (
          <div
            style={{
              height: "100%",
              width: `${props.pct}%`,
              borderRadius: 8,
              background: props.color,
              display: "flex",
              alignItems: "center",
              paddingLeft: 11,
              color: "#fff",
              fontSize: 11.5,
              fontWeight: 700,
              minWidth: 44,
            }}
          >
            {props.pct}%
          </div>
        ) : null}
      </div>
    </s-stack>
  );
}

export function AnalyticsFunnel(props: { funnel: RecommendationFunnel }) {
  const f = props.funnel;
  const atcPct = f.shown > 0 ? Math.round((f.atc / f.shown) * 100) : 0;

  return (
    <s-section heading="Recommendation funnel">
      <s-stack gap="base">
        <s-text tone="neutral">From AI product suggestions to purchase.</s-text>
        {f.shown === 0 ? (
          <s-box padding="large">
            <s-text tone="neutral">
              No recommendations shown in this period yet. The funnel fills in when the AI
              suggests products to shoppers.
            </s-text>
          </s-box>
        ) : (
          <s-stack gap="base">
            <FunnelRow
              name="Recommendations shown"
              value={f.shown.toLocaleString("en-US")}
              pct={100}
              color={`linear-gradient(90deg,${BRAND.accent},#7c5cff)`}
            />
            <FunnelRow
              name="Added to cart"
              value={f.atc.toLocaleString("en-US")}
              pct={Math.min(100, atcPct)}
              color="linear-gradient(90deg,#3b82f6,#5b9bff)"
            />
            <FunnelRow name="Purchased" value="—" pct={null} color="" />
            <s-text tone="neutral">
              Purchase attribution arrives with the orders scope — until then this stage shows
              “—”.
            </s-text>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

export function AnalyticsResponsePerformance(props: { perf: ResponsePerformance }) {
  const p = props.perf;
  const d = p.deltas;

  const timeDelta = (pct: number | null) =>
    pct === null || pct === 0
      ? undefined
      : {
          value: `${Math.abs(pct)}% ${pct < 0 ? "faster" : "slower"}`,
          direction: (pct < 0 ? "down" : "up") as "down" | "up",
          invert: true, // faster (down) is good
        };

  return (
    <s-section heading="Response performance">
      <s-stack gap="base">
        <s-text tone="neutral">Speed of first reply and resolution.</s-text>
        <StatGrid>
          <StatTile
            label="Avg. first response"
            value={humanizeMs(p.avgFirstResponseMs)}
            icon="clock"
            tone="accent"
            delta={timeDelta(d.firstResponsePct)}
            sub={p.avgFirstResponseMs === null ? "No replies in this period yet" : undefined}
          />
          <StatTile
            label="Avg. resolution time"
            value={humanizeMs(p.avgResolutionMs)}
            icon="check-circle"
            tone="success"
            delta={timeDelta(d.resolutionPct)}
            sub={p.avgResolutionMs === null ? "No resolved conversations yet" : undefined}
          />
          <StatTile
            label="Answered on first try"
            icon="target"
            tone="info"
            value={p.answeredFirstTryPct === null ? "—" : `${p.answeredFirstTryPct}%`}
            delta={
              d.answeredFirstTryPts === null || d.answeredFirstTryPts === 0
                ? undefined
                : {
                    value: `${Math.abs(d.answeredFirstTryPts)} pts`,
                    direction: d.answeredFirstTryPts > 0 ? "up" : "down",
                  }
            }
          />
          <StatTile
            label="Handed to human"
            icon="person"
            tone="warning"
            value={p.handedToHuman.toLocaleString("en-US")}
            delta={
              d.handedToHuman === null || d.handedToHuman === 0
                ? undefined
                : {
                    value: `${Math.abs(d.handedToHuman)} vs prev`,
                    direction: d.handedToHuman > 0 ? "up" : "down",
                    invert: true, // more handovers is styled negative (design)
                  }
            }
          />
        </StatGrid>
      </s-stack>
    </s-section>
  );
}
