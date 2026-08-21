import { useMemo, useState } from "react";
import type { AnalyticsRange, SeriesPoint } from "../lib/analytics/shared";
import { ANALYTICS_RANGE_LABELS, ANALYTICS_RANGES } from "../lib/analytics/shared";
import { BRAND } from "./ui/tokens";
import { useDateTime } from "../lib/format/context";
import { formatDate, type DateTimePrefs } from "../lib/format/datetime";

// "Total conversations over time" card (spec 14, design analytics.html
// #lineChart): hand-rolled SVG smoothed line chart, Human vs AI series, own
// range dropdown (7d / 30d / 3m), legend, crosshair hover tooltip. Series
// colors from the design (#6d3bf5 AI / #22b8d6 human — CVD-validated pair).

const AI_COLOR = BRAND.accent;
const HUMAN_COLOR = "#22b8d6";

const W = 1100;
const H = 230;
const PAD = { left: 46, right: 20, top: 16, bottom: 34 };

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  for (const m of [1, 2, 4, 5, 10]) {
    if (value <= m * magnitude) return m * magnitude;
  }
  return 10 * magnitude;
}

/** Catmull-Rom → cubic bezier smoothing (same construction as the design). */
function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Date-only series points (YYYY-MM-DD, already shop-local days) → shop date
 *  format without the year; formatted in UTC so the day never shifts. */
function labelFor(iso: string, prefs: DateTimePrefs): string {
  return formatDate(`${iso}T00:00:00Z`, { ...prefs, timeZone: "UTC" }, { year: false });
}

export function AnalyticsLineChart(props: {
  series: SeriesPoint[];
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
}) {
  const dt = useDateTime();
  const [hover, setHover] = useState<number | null>(null);
  const { series, range } = props;

  const model = useMemo(() => {
    const n = series.length;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const rawMax = Math.max(1, ...series.map((p) => Math.max(p.ai, p.human)));
    const yMax = niceMax(rawMax);
    const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v: number) => PAD.top + (1 - v / yMax) * plotH;
    const aiPts: [number, number][] = series.map((p, i) => [x(i), y(p.ai)]);
    const humanPts: [number, number][] = series.map((p, i) => [x(i), y(p.human)]);
    const ticks = [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax].map((v) => Math.round(v));
    // Thin the x labels: at most ~7.
    const step = Math.max(1, Math.ceil(n / 7));
    const labelIdx = new Set<number>();
    for (let i = 0; i < n; i += step) labelIdx.add(i);
    labelIdx.add(n - 1);
    return { n, yMax, x, y, aiPts, humanPts, ticks: [...new Set(ticks)], labelIdx, plotH };
  }, [series]);

  const total = series.reduce((sum, p) => sum + p.ai + p.human, 0);
  const aiPath = smoothPath(model.aiPts);
  const base = model.y(0);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < model.n; i++) {
      const d = Math.abs(model.x(i) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setHover(best);
  };

  const hovered = hover !== null ? series[hover] : null;

  return (
    <s-section heading="Total conversations over time">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-text tone="neutral">Human vs AI agent.</s-text>
          <s-select
            label="Chart range"
            labelAccessibilityVisibility="exclusive"
            value={range}
            onChange={(e) => props.onRangeChange(e.currentTarget.value as AnalyticsRange)}
          >
            {ANALYTICS_RANGES.map((r) => (
              <s-option key={r} value={r}>
                {ANALYTICS_RANGE_LABELS[r]}
              </s-option>
            ))}
          </s-select>
        </s-stack>

        {total === 0 ? (
          <s-box padding="large">
            <s-stack gap="small" alignItems="center">
              <s-text tone="neutral">No conversations in this period yet.</s-text>
              <s-text tone="neutral">
                The chart fills in as shoppers start chatting on your storefront.
              </s-text>
            </s-stack>
          </s-box>
        ) : (
          // .cc-chart-scroll (app-mobile.css): on phones the SVG keeps a
          // legible minimum width and pans horizontally instead of scaling
          // its labels below readability.
          <div className="cc-chart-scroll" style={{ position: "relative" }}>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              style={{ width: "100%", height: "auto", display: "block" }}
              role="img"
              aria-label="Conversations per day, human versus AI agent"
              onMouseMove={handleMove}
              onMouseLeave={() => setHover(null)}
            >
              <defs>
                <linearGradient id="cc-ai-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={AI_COLOR} stopOpacity=".16" />
                  <stop offset="1" stopColor={AI_COLOR} stopOpacity="0" />
                </linearGradient>
              </defs>
              {model.ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={PAD.left}
                    y1={model.y(tick)}
                    x2={W - PAD.right}
                    y2={model.y(tick)}
                    stroke="#ececf0"
                    strokeWidth="1"
                  />
                  <text
                    x={PAD.left - 10}
                    y={model.y(tick) + 4}
                    textAnchor="end"
                    fontSize="12"
                    fill="#9a9aa2"
                  >
                    {tick}
                  </text>
                </g>
              ))}
              {series.map((p, i) =>
                model.labelIdx.has(i) ? (
                  <text
                    key={p.date}
                    x={model.x(i)}
                    y={H - 10}
                    textAnchor="middle"
                    fontSize="12"
                    fill="#9a9aa2"
                  >
                    {labelFor(p.date, dt.prefs)}
                  </text>
                ) : null,
              )}
              <path
                d={`${aiPath} L ${model.x(model.n - 1)},${base} L ${model.x(0)},${base} Z`}
                fill="url(#cc-ai-fill)"
              />
              <path
                d={smoothPath(model.humanPts)}
                fill="none"
                stroke={HUMAN_COLOR}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={aiPath}
                fill="none"
                stroke={AI_COLOR}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {hover !== null ? (
                <g>
                  <line
                    x1={model.x(hover)}
                    y1={PAD.top}
                    x2={model.x(hover)}
                    y2={base}
                    stroke="#9a9aa2"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={model.x(hover)}
                    cy={model.y(series[hover].ai)}
                    r="4"
                    fill={AI_COLOR}
                    stroke="#fff"
                    strokeWidth="2"
                  />
                  <circle
                    cx={model.x(hover)}
                    cy={model.y(series[hover].human)}
                    r="4"
                    fill={HUMAN_COLOR}
                    stroke="#fff"
                    strokeWidth="2"
                  />
                </g>
              ) : null}
            </svg>
            {hovered && hover !== null ? (
              <div
                style={{
                  position: "absolute",
                  left: `${(model.x(hover) / W) * 100}%`,
                  top: 0,
                  transform: `translateX(${hover > model.n / 2 ? "calc(-100% - 10px)" : "10px"})`,
                  background: "var(--s-color-bg, #fff)",
                  border: "1px solid #e3e3e3",
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 12,
                  boxShadow: "0 2px 8px rgba(0,0,0,.08)",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                }}
              >
                <div style={{ fontWeight: 600 }}>{labelFor(hovered.date, dt.prefs)}</div>
                <div>
                  <span style={{ color: AI_COLOR }}>●</span> AI agent: {hovered.ai}
                </div>
                <div>
                  <span style={{ color: HUMAN_COLOR }}>●</span> Human: {hovered.human}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <s-stack direction="inline" justifyContent="center" gap="large">
          <s-text tone="neutral">
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 15,
                height: 3,
                borderRadius: 2,
                background: HUMAN_COLOR,
                verticalAlign: "middle",
                marginRight: 6,
              }}
            />
            Human
          </s-text>
          <s-text tone="neutral">
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 15,
                height: 3,
                borderRadius: 2,
                background: AI_COLOR,
                verticalAlign: "middle",
                marginRight: 6,
              }}
            />
            AI agent
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
