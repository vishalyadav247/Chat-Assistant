import { useId, useRef } from "react";
import { RADIUS, SPACE, TONES } from "./tokens";

// The one tab-pill row for the whole admin (replaces 5 divergent
// implementations — see PROGRESS decisions log 2026-08-10). Pill track on a
// subdued surface; active pill = accent-soft (a form surface — no gradients).
//
// A11y: this declares the ARIA tab pattern, so it implements the pattern's
// keyboard contract too — roving tabindex (only the selected pill is in the
// Tab order), ArrowLeft/ArrowRight to move between tabs with automatic
// activation, and Home/End for the ends. Each tab exposes a stable `id` so a
// panel can point back with aria-labelledby; pass `panelId` to wire
// aria-controls when the consumer renders a role="tabpanel" wrapper.

export function TabPills<T extends string>(props: {
  tabs: { id: T; label: string; badge?: string | number }[];
  active: T;
  onChange: (id: T) => void;
  size?: "base" | "small";
  /** id of the role="tabpanel" element these tabs control, if the page has one. */
  panelId?: string;
  /** Accessible name for the tab row (defaults to none — use when a page has 2+ rows). */
  label?: string;
}) {
  const small = props.size === "small";
  const uid = useId();
  const tabId = (id: T) => `${uid}-tab-${id}`;
  const refs = useRef(new Map<T, HTMLButtonElement | null>());
  // Roving tabindex needs exactly one entry point. If `active` matches no tab
  // (a page landing on an unknown ?tab=), fall back to the first pill so the
  // row never drops out of the Tab order.
  const activeIndex = props.tabs.findIndex((t) => t.id === props.active);
  const focusIndex = activeIndex >= 0 ? activeIndex : 0;

  // Automatic activation: arrows both move focus and select, which is the
  // APG default for tab sets whose panels are already rendered client-side.
  const move = (from: number, delta: number | "first" | "last") => {
    const count = props.tabs.length;
    if (count === 0) return;
    const next =
      delta === "first" ? 0 : delta === "last" ? count - 1 : (from + delta + count) % count;
    const tab = props.tabs[next];
    if (!tab) return;
    props.onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(index, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(index, -1);
        break;
      case "Home":
        event.preventDefault();
        move(index, "first");
        break;
      case "End":
        event.preventDefault();
        move(index, "last");
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      aria-label={props.label}
      className="cc-tabpills"
      style={{
        display: "inline-flex",
        gap: SPACE.xs,
        background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
        borderRadius: RADIUS.banner,
        width: "fit-content",
        flexWrap: "wrap",
      }}
    >
      {props.tabs.map((tab, index) => {
        const active = props.active === tab.id;
        return (
          <button
            key={tab.id}
            id={tabId(tab.id)}
            ref={(el) => {
              refs.current.set(tab.id, el);
            }}
            role="tab"
            type="button"
            aria-selected={active}
            aria-controls={props.panelId}
            // Roving tabindex: Tab reaches the row once, arrows walk it.
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => props.onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
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
