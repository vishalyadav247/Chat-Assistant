import type { ReactNode } from "react";

// The admin console's own component vocabulary (spec 19, redesigned
// 2026-09-03: "make it robust and authentic, glassmorphism, mobile first").
//
// Deliberately NOT Polaris: `<s-page>` / `<s-section>` render into shadow DOM,
// so the frosted surfaces, gradient rims and dark theme below cannot reach
// them. Form CONTROLS stay Polaris — they are the parts that must behave
// exactly like the merchant app's, and rewriting inputs is how accessibility
// bugs get invented. Because Polaris always renders LIGHT chrome, every card
// becomes a light frosted sheet in dark mode — see the note in admin.css.
//
// Everything here is presentational. No loader, no fetch, no plan logic.

export type ThemePref = "light" | "dark" | "system";

export function AdminPage(props: {
  heading: string;
  subheading?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="cca-page">
      <header className="cca-pagehead">
        <div className="cca-pagehead__text">
          <h1>{props.heading}</h1>
          {props.subheading ? <p>{props.subheading}</p> : null}
        </div>
        {props.actions ? <div className="cca-pagehead__actions">{props.actions}</div> : null}
      </header>
      <div className="cca-page__body">{props.children}</div>
    </div>
  );
}

export function AdminCard(props: {
  heading?: string;
  description?: ReactNode;
  actions?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="cca-card">
      {props.heading || props.actions || props.description ? (
        <header className="cca-card__head">
          <div>
            {props.heading ? <h2>{props.heading}</h2> : null}
            {props.description ? <p className="cca-card__desc">{props.description}</p> : null}
          </div>
          {props.actions ? <div className="cca-card__actions">{props.actions}</div> : null}
        </header>
      ) : null}
      <div className={["cca-card__body", props.bodyClassName].filter(Boolean).join(" ")}>
        {props.children}
      </div>
    </section>
  );
}

export function AdminStats(props: { children: ReactNode }) {
  return <div className="cca-stats">{props.children}</div>;
}

export function AdminStat(props: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "accent" | "success" | "warning" | "critical" | "neutral";
  icon?: IconName;
}) {
  return (
    <div className={`cca-stat cca-stat--${props.tone ?? "accent"}`}>
      {props.icon ? (
        <span className="cca-stat__icon" aria-hidden>
          <Icon name={props.icon} />
        </span>
      ) : null}
      <span className="cca-stat__label">{props.label}</span>
      <span className="cca-stat__value">{props.value}</span>
      {props.hint ? <span className="cca-stat__hint">{props.hint}</span> : null}
    </div>
  );
}

export function AdminSegmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: string; icon?: IconName }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "small" | "base";
}) {
  return (
    <div
      className={`cca-seg${props.size === "small" ? " cca-seg--small" : ""}`}
      role="radiogroup"
      aria-label={props.ariaLabel}
    >
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          className={`cca-seg__item${props.value === option.value ? " is-active" : ""}`}
          onClick={() => props.onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} /> : null}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function AdminBadge(props: {
  tone?: "accent" | "success" | "warning" | "critical" | "neutral";
  children: ReactNode;
}) {
  return <span className={`cca-badge cca-badge--${props.tone ?? "neutral"}`}>{props.children}</span>;
}

export function AdminEmpty(props: { title: string; body?: ReactNode }) {
  return (
    <div className="cca-empty">
      <strong>{props.title}</strong>
      {props.body ? <span>{props.body}</span> : null}
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────
// Inline SVG, currentColor, 20px grid. Chrome icons are NOT Polaris `s-icon`:
// these sit on the frosted rail where they must inherit the theme's ink.

export type IconName =
  | "home"
  | "chart"
  | "alert"
  | "wand"
  | "card"
  | "tag"
  | "settings"
  | "users"
  | "sun"
  | "moon"
  | "monitor"
  | "menu"
  | "close"
  | "logout";

const PATHS: Record<IconName, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  chart: <path d="M4 20V10m5 10V4m5 16v-7m5 7V8" />,
  alert: <path d="M12 3 2 20h20zM12 10v4m0 3v.5" />,
  wand: <path d="m5 19 9-9m0 0 2-2-2-2-2 2zM19 5v3m1.5-1.5h-3M6 4v2M5 5h2" />,
  card: <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18" />,
  tag: <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9zM8 8v.01" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 5.5a3 3 0 0 1 0 5.8M18 14.4a5.6 5.6 0 0 1 3.5 5.2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5" />,
  monitor: <path d="M3 5h18v11H3zM9 20h6m-3-4v4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  logout: <path d="M15 12H4m0 0 3.5-3.5M4 12l3.5 3.5M10 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8" />,
};

export function Icon(props: { name: IconName; className?: string }) {
  return (
    <svg
      className={["cca-icon", props.className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[props.name]}
    </svg>
  );
}
