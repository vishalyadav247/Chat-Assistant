import { RADIUS, SPACE, TONES } from "./tokens";

// The one tab-pill row for the whole admin (replaces 5 divergent
// implementations — see PROGRESS decisions log 2026-08-10). Pill track on a
// subdued surface; active pill = accent-soft (a form surface — no gradients).

export function TabPills<T extends string>(props: {
  tabs: { id: T; label: string; badge?: string | number }[];
  active: T;
  onChange: (id: T) => void;
  size?: "base" | "small";
}) {
  const small = props.size === "small";
  return (
    <div
      role="tablist"
      className="cc-tabpills"
      style={{
        display: "inline-flex",
        gap: SPACE.xs,
        background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
        borderRadius: RADIUS.banner,
        padding: 4,
        width: "fit-content",
        flexWrap: "wrap",
      }}
    >
      {props.tabs.map((tab) => {
        const active = props.active === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => props.onChange(tab.id)}
            style={{
              border: "none",
              cursor: "pointer",
              font: "inherit",
              fontWeight: 650,
              fontSize: small ? 12 : 13,
              padding: small ? "5px 12px" : "7px 14px",
              borderRadius: RADIUS.chip,
              display: "inline-flex",
              alignItems: "center",
              gap: SPACE.xs + 2,
              color: active ? TONES.accent.fg : "inherit",
              background: active ? "var(--s-color-bg, #fff)" : "transparent",
              boxShadow: active ? "0 1px 3px rgba(20,20,25,.15)" : "none",
              transition: "background .15s ease, color .15s ease",
            }}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== "" ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "1px 7px",
                  borderRadius: RADIUS.pill,
                  background: active ? TONES.accent.bg : "var(--s-color-bg, #fff)",
                  color: active ? TONES.accent.fg : "var(--s-color-text-secondary, #78787f)",
                }}
              >
                {tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
