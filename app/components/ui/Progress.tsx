import { BRAND, RADIUS } from "./tokens";

// Shared progress primitives (design prototypes use the same gradient fill on
// every ring/track: checklist ring, usage meter, setup-card progress).

const RING_RADIUS = 24;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 150.8, as in the design

export function ProgressRing(props: { completed: number; total: number; size?: number }) {
  const size = props.size ?? 56;
  const fraction = props.total === 0 ? 0 : props.completed / props.total;
  const offset = RING_CIRCUMFERENCE * (1 - fraction);
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 56 56"
        role="img"
        aria-label={`${props.completed} of ${props.total} steps complete`}
      >
        <circle cx="28" cy="28" r={RING_RADIUS} fill="none" stroke="#e9e9ec" strokeWidth="6" />
        <circle
          cx="28"
          cy="28"
          r={RING_RADIUS}
          fill="none"
          stroke="url(#cc-ring-gradient)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 28 28)"
          style={{ transition: "stroke-dashoffset .4s ease" }}
        />
        <defs>
          <linearGradient id="cc-ring-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
      </svg>
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {props.completed}/{props.total}
      </span>
    </div>
  );
}

/** Horizontal gradient progress track (usage meters, setup-card progress). */
export function ProgressTrack(props: {
  value: number;
  max: number;
  height?: number;
  label?: string;
}) {
  const pct = props.max > 0 ? Math.min(100, Math.max(0, (props.value / props.max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props.label}
      style={{
        height: props.height ?? 8,
        borderRadius: RADIUS.pill,
        background: "var(--s-color-bg-fill-secondary, #ececf0)",
        boxShadow: "inset 0 0 0 1px var(--s-color-border-secondary, #f1f1f1)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          borderRadius: RADIUS.pill,
          background: BRAND.progressGradient,
          transition: "width .5s cubic-bezier(.22,1,.36,1)",
        }}
      />
    </div>
  );
}
