import type { CsatSummary, ResolutionBreakdown } from "../lib/analytics/shared";

// Resolution donut + CSAT cards (spec 14, design analytics.html .donut-wrap /
// .csat-*). Donut is an SVG circle with stroke-dasharray segments and 2px
// surface gaps; center shows "N% resolved". Colors: AI #6d3bf5 / human #22b8d6
// (matches the line-chart series identity) / unresolved neutral gray.

const AI_COLOR = "#6d3bf5";
const HUMAN_COLOR = "#22b8d6";
const UNRESOLVED_COLOR = "#d4d4d8";

const SIZE = 132;
const STROKE = 16;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;

function DonutSegment(props: { pct: number; offsetPct: number; color: string }) {
  if (props.pct <= 0) return null;
  // 2px gap on each side of a segment (skipped when a single segment is 100%).
  const gap = props.pct >= 100 ? 0 : 2;
  const length = Math.max(0, (props.pct / 100) * CIRC - gap);
  return (
    <circle
      cx={SIZE / 2}
      cy={SIZE / 2}
      r={R}
      fill="none"
      stroke={props.color}
      strokeWidth={STROKE}
      strokeDasharray={`${length} ${CIRC - length}`}
      strokeDashoffset={-((props.offsetPct / 100) * CIRC + gap / 2)}
      transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
    />
  );
}

export function AnalyticsResolutionDonut(props: { breakdown: ResolutionBreakdown }) {
  const b = props.breakdown;
  const rows = [
    { name: "Resolved by AI", pct: b.resolvedByAiPct, color: AI_COLOR },
    { name: "Resolved by human", pct: b.resolvedByHumanPct, color: HUMAN_COLOR },
    { name: "Unresolved", pct: b.unresolvedPct, color: UNRESOLVED_COLOR },
  ];

  return (
    <s-section heading="How conversations resolved">
      <s-stack gap="base">
        <s-text tone="neutral">Split by resolution type.</s-text>
        {b.total === 0 ? (
          <s-box padding="large">
            <s-text tone="neutral">
              No conversations in this period yet — the split appears once chats come in.
            </s-text>
          </s-box>
        ) : (
          <s-stack direction="inline" gap="large" alignItems="center">
            <div style={{ position: "relative", width: SIZE, height: SIZE, flex: "none" }}>
              <svg
                width={SIZE}
                height={SIZE}
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                role="img"
                aria-label={`${b.resolvedPct}% of conversations resolved: ${b.resolvedByAiPct}% by AI, ${b.resolvedByHumanPct}% by a human, ${b.unresolvedPct}% unresolved`}
              >
                <DonutSegment pct={rows[0].pct} offsetPct={0} color={rows[0].color} />
                <DonutSegment pct={rows[1].pct} offsetPct={rows[0].pct} color={rows[1].color} />
                <DonutSegment
                  pct={rows[2].pct}
                  offsetPct={rows[0].pct + rows[1].pct}
                  color={rows[2].color}
                />
              </svg>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <s-heading>{b.resolvedPct}%</s-heading>
                <s-text tone="neutral">resolved</s-text>
              </div>
            </div>
            <s-stack gap="base">
              {rows.map((row) => (
                <s-stack key={row.name} direction="inline" gap="small" alignItems="center">
                  <span
                    aria-hidden
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: 3,
                      background: row.color,
                      display: "inline-block",
                      flex: "none",
                    }}
                  />
                  <s-text>{row.name}</s-text>
                  <s-text type="strong">{row.pct}%</s-text>
                </s-stack>
              ))}
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

const STAR_COLOR = "#f5b301";

export function AnalyticsCsat(props: { csat: CsatSummary }) {
  const { avg, responses, histogram } = props.csat;
  const max = Math.max(1, ...histogram);

  return (
    <s-section heading="Customer satisfaction">
      <s-stack gap="base">
        <s-text tone="neutral">From post-chat surveys.</s-text>
        {responses === 0 || avg === null ? (
          <s-box padding="large">
            <s-text tone="neutral">
              No survey responses yet. Ratings appear after shoppers complete the post-chat
              survey.
            </s-text>
          </s-box>
        ) : (
          <>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-heading>{avg.toFixed(1)}</s-heading>
              <s-stack gap="none">
                <span
                  aria-label={`${avg.toFixed(1)} out of 5 stars`}
                  style={{ color: STAR_COLOR, display: "inline-flex", gap: 1 }}
                >
                  {Array.from({ length: 5 }, (_, i) => (
                    <s-icon
                      key={i}
                      type={i < Math.round(avg) ? "star-filled" : "star"}
                      size="small"
                    />
                  ))}
                </span>
                <s-text tone="neutral">from {responses} responses</s-text>
              </s-stack>
            </s-stack>
            <s-stack gap="small">
              {histogram.map((count, index) => {
                const stars = 5 - index;
                return (
                  <div
                    key={stars}
                    style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}
                  >
                    <span
                      style={{
                        width: 34,
                        flex: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 2,
                      }}
                    >
                      <s-text tone="neutral">{stars}</s-text>
                      <s-icon type="star-filled" size="small" tone="neutral" />
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 5,
                        background: "var(--s-color-bg-subdued, #f1f1f3)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.round((count / max) * 100)}%`,
                          borderRadius: 5,
                          background: STAR_COLOR,
                        }}
                      />
                    </div>
                    <span style={{ width: 28, textAlign: "right", flex: "none" }}>
                      <s-text tone="neutral">{count}</s-text>
                    </span>
                  </div>
                );
              })}
            </s-stack>
          </>
        )}
      </s-stack>
    </s-section>
  );
}
