// ChatConvert admin design tokens — single source of truth for the values the
// HTML design prototypes (.claude/resources/html_design/) use on every page.
// Rules (polaris-admin-ui skill): no raw `gap:`/`padding:` numbers in new UI —
// use SPACE; no hardcoded brand hex — use BRAND; gradients ONLY on
// hero/marketing/progress surfaces, never on forms, tables, or buttons.

/** Spacing scale (px). base = the 16px vertical rhythm between page sections. */
export const SPACE = {
  /** 4 — tightest: icon↔text inside a chip */
  xs: 4,
  /** 8 — icon↔label, button clusters, toolbar items */
  sm: 8,
  /** 12 — rows, KPI grids */
  md: 12,
  /** 14 — 4-up card grids (setup cards, plan cards) */
  cardGrid: 14,
  /** 16 — between page sections, two-column page grids */
  base: 16,
  /** 20 — card inner padding */
  cardPad: 20,
} as const;

/** Border-radius scale (px). */
export const RADIUS = {
  /** icon chips, small inner boxes */
  chip: 8,
  /** banners, inner boxes */
  banner: 12,
  /** cards */
  card: 16,
  /** pills & badges — always fully rounded */
  pill: 20,
} as const;

/** Brand colors & gradients (design tokens from the prototypes). */
export const BRAND = {
  accent: "#6d3bf5",
  accentSoft: "#efeafe",
  /** Standard brand mark gradient (logo, progress fills, CTA surfaces). */
  gradient: "linear-gradient(135deg,#6d3bf5,#3b82f6)",
  /** Dashboard hero banner gradient (3-stop). */
  heroGradient: "linear-gradient(120deg,#5b21b6 0%,#6d3bf5 45%,#3b82f6 100%)",
  /** Horizontal progress-track fill. */
  progressGradient: "linear-gradient(90deg,#7c3aed,#3b82f6)",
} as const;

/** Card shadows (sm includes the 1px hairline ring — cards are borderless). */
export const SHADOW = {
  sm: "0 1px 2px rgba(20,20,25,.06), 0 0 0 1px rgba(20,20,25,.04)",
  md: "0 6px 20px rgba(20,20,25,.08), 0 0 0 1px rgba(20,20,25,.04)",
} as const;

export type Tone = "accent" | "success" | "warning" | "info" | "neutral" | "critical";

/** Soft-background/int-foreground pairs for icon chips, pills, and strips. */
export const TONES: Record<Tone, { bg: string; fg: string }> = {
  accent: { bg: "#efeafe", fg: "#6d3bf5" },
  success: { bg: "#d7f8e6", fg: "#0c5132" },
  warning: { bg: "#fdecc8", fg: "#8a5a00" },
  info: { bg: "#dbeafe", fg: "#1e40af" },
  neutral: { bg: "#ececf0", fg: "#5a5a63" },
  critical: { bg: "#fdeef1", fg: "#e11d48" },
};

/** Muted text colors (the design's lightened ink ramp). */
export const INK = {
  strong: "var(--s-color-text, #2e2e37)",
  base: "var(--s-color-text, #4a4a53)",
  muted: "var(--s-color-text-secondary, #78787f)",
  faint: "var(--s-color-text-secondary, #a2a2ab)",
  border: "var(--s-color-border, #e9e9ec)",
  borderSoft: "var(--s-color-border-secondary, #f1f1f1)",
  surface2: "var(--s-color-bg-surface-secondary, #fbfbfc)",
} as const;
