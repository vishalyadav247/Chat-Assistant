import { RADIUS, SPACE, TONES, type Tone } from "./tokens";

// Shared empty state: tone-tinted icon tile + title + optional description and
// call-to-action, on a subdued inset surface. Replaces the app's three ad-hoc
// "no data" renderings (bare neutral text / padded box / custom CSS).

type IconName = NonNullable<React.JSX.IntrinsicElements["s-icon"]["type"]>;

export function EmptyState(props: {
  icon: IconName;
  title: string;
  description?: string;
  tone?: Tone;
  action?: { label: string; onClick: () => void };
  compact?: boolean;
}) {
  const tone = TONES[props.tone ?? "neutral"];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: SPACE.sm,
        padding: props.compact ? "18px 16px" : "32px 20px",
        borderRadius: RADIUS.banner,
        background: "var(--s-color-bg-surface-secondary, #fbfbfc)",
        boxShadow: "inset 0 0 0 1px var(--s-color-border, #e9e9ec)",
      }}
    >
      <span
        style={{
          width: props.compact ? 34 : 44,
          height: props.compact ? 34 : 44,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: RADIUS.banner,
          background: tone.bg,
          color: tone.fg,
        }}
      >
        <s-icon type={props.icon} size={props.compact ? "small" : "base"} />
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--s-color-text, #2e2e37)" }}>
        {props.title}
      </span>
      {props.description ? (
        <span
          style={{
            fontSize: 12.5,
            color: "var(--s-color-text-secondary, #78787f)",
            maxWidth: 420,
          }}
        >
          {props.description}
        </span>
      ) : null}
      {props.action ? (
        <div style={{ marginTop: 2 }}>
          <s-button onClick={props.action.onClick}>{props.action.label}</s-button>
        </div>
      ) : null}
    </div>
  );
}
