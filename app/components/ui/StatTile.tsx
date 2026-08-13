import { useMemo } from "react";
import { RADIUS, SHADOW, SPACE, TONES, type Tone } from "./tokens";

// KPI tile per the design prototypes (dashboard/analytics/curated/proactive/
// contacts all share this anatomy): tone-colored icon chip + label, big value,
// delta pill and/or sparkline footer, optional sublabel. Variants:
//   inset    — sits INSIDE a card/section (surface-2 + hairline ring). Default.
//   elevated — its own card on the page background (shadow + hover lift).
// `live` renders the pulsing "live now" pill (replaces per-page forks).

type IconName = NonNullable<React.JSX.IntrinsicElements["s-icon"]["type"]>;

export interface StatDelta {
  value: string;
  direction: "up" | "down" | "flat";
  /** Flip tone for metrics where down is good (e.g. response time). */
  invert?: boolean;
}

const SPARK_W = 66;
const SPARK_H = 26;

function Sparkline(props: { points: number[]; color: string }) {
  const path = useMemo(() => {
    const values = props.points;
    if (values.length < 2) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * (SPARK_W - 2) + 1;
        const y = SPARK_H - 2 - ((v - min) / span) * (SPARK_H - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [props.points]);
  if (!path) return null;
  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <polyline
        points={path}
        fill="none"
        stroke={props.color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const LIVE_PULSE_CSS = `
@keyframes ccstat-pulse {
  0% { box-shadow: 0 0 0 0 rgba(34,197,94,.45); }
  70% { box-shadow: 0 0 0 5px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}`;

export function StatTile(props: {
  label: string;
  value: string;
  icon?: IconName;
  tone?: Tone;
  sub?: string;
  delta?: StatDelta;
  spark?: number[];
  live?: boolean;
  variant?: "elevated" | "inset";
}) {
  const tone = TONES[props.tone ?? "accent"];
  const elevated = props.variant === "elevated";
  const d = props.delta;
  const deltaGood = d ? (d.direction === "up") !== Boolean(d.invert) : true;
  const deltaTone =
    d?.direction === "flat" ? TONES.neutral : deltaGood ? TONES.success : TONES.critical;

  return (
    <div
      className={elevated ? "ccstat-elevated" : undefined}
      style={{
        padding: "14px 14px 12px",
        borderRadius: elevated ? RADIUS.card : 14,
        background: elevated ? "var(--s-color-bg, #fff)" : "var(--s-color-bg-surface-secondary, #fbfbfc)",
        boxShadow: elevated ? SHADOW.sm : "inset 0 0 0 1px var(--s-color-border, #e9e9ec)",
        transition: elevated ? "transform .18s ease, box-shadow .18s ease" : undefined,
        display: "flex",
        flexDirection: "column",
        gap: SPACE.sm,
        minWidth: 0,
      }}
    >
      {props.live ? <style>{LIVE_PULSE_CSS}</style> : null}
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
        {props.icon ? (
          <span
            style={{
              width: 28,
              height: 28,
              flex: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: RADIUS.chip,
              background: tone.bg,
              color: tone.fg,
            }}
          >
            <s-icon type={props.icon} size="small" />
          </span>
        ) : null}
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 550,
            color: "var(--s-color-text-secondary, #78787f)",
            minWidth: 0,
          }}
        >
          {props.label}
        </span>
      </div>

      <span
        style={{
          fontSize: 25,
          fontWeight: 750,
          letterSpacing: -0.6,
          color: "var(--s-color-text, #2e2e37)",
          lineHeight: 1.1,
        }}
      >
        {props.value}
      </span>

      {d || props.spark || props.live ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: SPACE.sm,
            minHeight: SPARK_H,
          }}
        >
          {props.live ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: RADIUS.pill,
                background: TONES.success.bg,
                color: TONES.success.fg,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#22c55e",
                  animation: "ccstat-pulse 2s infinite",
                }}
              />
              live now
            </span>
          ) : d ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                fontSize: 11.5,
                fontWeight: 700,
                padding: "2px 7px",
                borderRadius: RADIUS.pill,
                background: deltaTone.bg,
                color: deltaTone.fg,
              }}
            >
              {d.direction !== "flat" ? (
                <s-icon type={d.direction === "up" ? "arrow-up" : "arrow-down"} size="small" />
              ) : null}
              {d.value}
            </span>
          ) : (
            <span />
          )}
          {props.spark && props.spark.length > 1 ? (
            <Sparkline points={props.spark} color={tone.fg} />
          ) : null}
        </div>
      ) : null}

      {props.sub ? (
        <span style={{ fontSize: 11.5, color: "var(--s-color-text-secondary, #a2a2ab)" }}>
          {props.sub}
        </span>
      ) : null}
    </div>
  );
}

const ELEVATED_HOVER_CSS = `
.ccstat-elevated:hover { transform: translateY(-3px); box-shadow: ${SHADOW.md}; }`;

export function StatGrid(props: { children: React.ReactNode; columns?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: props.columns
          ? `repeat(${props.columns}, minmax(0, 1fr))`
          : "repeat(auto-fit, minmax(180px, 1fr))",
        gap: SPACE.md,
      }}
    >
      <style>{ELEVATED_HOVER_CSS}</style>
      {props.children}
    </div>
  );
}
