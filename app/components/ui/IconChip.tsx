import { RADIUS, TONES, type Tone } from "./tokens";

// Tone-tinted icon chip (the design prototypes' card icon square): one
// primitive for every "icon in a soft colored square" so sizes/radii/tones
// never drift between cards.

type IconName = NonNullable<React.JSX.IntrinsicElements["s-icon"]["type"]>;

export function IconChip(props: { icon: IconName; tone?: Tone; size?: "small" | "base" | "large" }) {
  const tone = TONES[props.tone ?? "accent"];
  const px = props.size === "large" ? 44 : props.size === "small" ? 28 : 36;
  return (
    <span
      aria-hidden
      style={{
        width: px,
        height: px,
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: props.size === "large" ? RADIUS.banner : RADIUS.chip,
        background: tone.bg,
        color: tone.fg,
      }}
    >
      <s-icon type={props.icon} size={props.size === "small" ? "small" : "base"} />
    </span>
  );
}
