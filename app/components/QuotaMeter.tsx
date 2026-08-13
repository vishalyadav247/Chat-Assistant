import { ProgressTrack } from "./ui/Progress";

// Quota meter (specs 04/07/09/15): "N of M used" with a progress bar.
// M always comes from the server (plan matrix displayQuota) — never hard-coded.
// While plan enforcement is in "open" mode the bar renders informationally.
// Near/at the cap the fill switches from the brand gradient to warning/critical.

export function QuotaMeter(props: { used: number; quota: number; label?: string }) {
  const pct = props.quota > 0 ? Math.min(100, Math.round((props.used / props.quota) * 100)) : 0;
  const tone = pct >= 100 ? "critical" : pct >= 80 ? "warning" : "auto";
  return (
    <s-box padding="small">
      <s-stack gap="small">
        <s-text tone={tone === "auto" ? undefined : tone}>
          {props.used} of {props.quota} {props.label ?? "used"}
        </s-text>
        {tone === "auto" ? (
          <ProgressTrack value={props.used} max={props.quota} height={6} label={props.label} />
        ) : (
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: "var(--s-color-border, #e3e3e3)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                borderRadius: 3,
                background: pct >= 100 ? "#d72c0d" : "#b98900",
                transition: "width 200ms ease",
              }}
            />
          </div>
        )}
      </s-stack>
    </s-box>
  );
}
