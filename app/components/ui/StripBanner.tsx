import { RADIUS, SPACE, TONES, type Tone } from "./tokens";

// Two-part banner from the design prototypes (ai-agent.html): a tone-colored
// strip (icon + bold title + optional dismiss) over an optional white body
// with the longer explanation. Radius 12, hairline ring, overflow hidden.

type IconName = NonNullable<React.JSX.IntrinsicElements["s-icon"]["type"]>;

export function StripBanner(props: {
  tone: Tone;
  icon: IconName;
  title: string;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
  children?: React.ReactNode;
}) {
  const tone = TONES[props.tone];
  return (
    <div
      style={{
        borderRadius: RADIUS.banner,
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(20,20,25,.06), 0 0 0 1px rgba(20,20,25,.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.sm + 2,
          padding: "12px 16px",
          background: tone.bg,
          color: tone.fg,
        }}
      >
        <s-icon type={props.icon} size="small" />
        <span style={{ fontSize: 13, fontWeight: 750, flex: 1, minWidth: 0 }}>{props.title}</span>
        {props.action ? (
          <button
            type="button"
            onClick={props.action.onClick}
            style={{
              border: "none",
              cursor: "pointer",
              font: "inherit",
              fontSize: 12.5,
              fontWeight: 650,
              padding: "4px 10px",
              borderRadius: RADIUS.chip,
              background: "rgba(255,255,255,.7)",
              color: tone.fg,
            }}
          >
            {props.action.label}
          </button>
        ) : null}
        {props.onDismiss ? (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={props.onDismiss}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: 2,
              display: "inline-flex",
              color: "inherit",
            }}
          >
            <s-icon type="x" size="small" />
          </button>
        ) : null}
      </div>
      {props.children ? (
        <div
          style={{
            padding: "12px 16px 14px",
            background: "var(--s-color-bg, #fff)",
            fontSize: 13,
            color: "var(--s-color-text-secondary, #78787f)",
          }}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
