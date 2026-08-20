import { BRAND, RADIUS, SHADOW, SPACE } from "./ui/tokens";

// Dashboard hero banner (spec 13, design dashboard.html .hero): brand
// gradient card with decorative circles, time-of-day greeting, pulsing
// "Assistant online" pill, dynamic subline, three actions. The gradient is a
// sanctioned hero/marketing surface (polaris-admin-ui skill, decision
// 2026-08-10) — its buttons are custom-styled because s-button cannot render
// white-on-gradient; focus outlines are preserved.

const HERO_CSS = `
@keyframes cc-pulse {
  0% { box-shadow: 0 0 0 0 rgba(74,222,128,.5); }
  70% { box-shadow: 0 0 0 6px rgba(74,222,128,0); }
  100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
}
.cc-hero-btn { transition: transform .15s ease, box-shadow .15s ease, background .15s ease; }
.cc-hero-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.cc-hero-btn.primary:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0,0,0,.2); }
.cc-hero-btn.ghost:hover { background: rgba(255,255,255,.26) !important; }
`;

export function AssistantPill(props: { online: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 11px",
        borderRadius: RADIUS.pill,
        background: "rgba(255,255,255,.16)",
        backdropFilter: "blur(4px)",
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: props.online ? "#4ade80" : "rgba(255,255,255,.5)",
          display: "inline-block",
          animation: props.online ? "cc-pulse 2s ease-in-out infinite" : undefined,
        }}
      />
      {props.online ? "Assistant online" : "Assistant off"}
    </span>
  );
}

function HeroButton(props: {
  kind: "primary" | "ghost";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const primary = props.kind === "primary";
  return (
    <button
      type="button"
      className={`cc-hero-btn ${props.kind}`}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        border: "none",
        cursor: props.disabled ? "default" : "pointer",
        font: "inherit",
        fontSize: 13,
        fontWeight: 650,
        padding: "9px 15px",
        borderRadius: 10,
        background: primary ? "#fff" : "rgba(255,255,255,.16)",
        color: primary ? "#5b21b6" : "#fff",
        opacity: props.disabled ? 0.7 : 1,
      }}
    >
      {props.children}
    </button>
  );
}

function DecoCircle(props: { size: number; style: React.CSSProperties; opacity: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        width: props.size,
        height: props.size,
        borderRadius: "50%",
        background: `rgba(255,255,255,${props.opacity})`,
        pointerEvents: "none",
        ...props.style,
      }}
    />
  );
}

export function DashboardHero(props: {
  greeting: string;
  shopName: string;
  pendingQuestions: number;
  atcThisMonth: number;
  aiEnabled: boolean;
  syncing: boolean;
  onAnswerQuestions: () => void;
  onSyncCatalog: () => void;
  onPreviewWidget: () => void;
}) {
  const { pendingQuestions: pending, atcThisMonth: atc } = props;
  const subline =
    pending === 0 && atc === 0
      ? "Your assistant is ready — shoppers' questions and chat add-to-carts will show up here."
      : `${pending} shopper ${pending === 1 ? "question is" : "questions are"} waiting for an answer, and your assistant drove ${atc} chat add-to-cart${atc === 1 ? "" : "s"} this month.`;

  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: RADIUS.card,
        padding: "22px 24px",
        color: "#fff",
        background: BRAND.heroGradient,
        boxShadow: SHADOW.md,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: HERO_CSS }} />
      <DecoCircle size={240} opacity={0.12} style={{ right: -40, top: -60 }} />
      <DecoCircle size={180} opacity={0.08} style={{ right: 120, bottom: -80 }} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: SPACE.base,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 750,
              letterSpacing: -0.4,
              color: "#fff",
            }}
          >
            {props.greeting}, {props.shopName} 👋
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 13.5,
              color: "rgba(255,255,255,.85)",
              maxWidth: 460,
            }}
          >
            {subline}
          </p>
        </div>
        <AssistantPill online={props.aiEnabled} />
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          gap: 10,
          marginTop: 18,
          flexWrap: "wrap",
        }}
      >
        <HeroButton kind="primary" onClick={props.onAnswerQuestions}>
          {pending > 0
            ? `Answer ${pending} question${pending === 1 ? "" : "s"}`
            : "Review questions"}
        </HeroButton>
        <HeroButton kind="ghost" disabled={props.syncing} onClick={props.onSyncCatalog}>
          {props.syncing ? "Syncing…" : "Sync catalog"}
        </HeroButton>
        <HeroButton kind="ghost" onClick={props.onPreviewWidget}>
          Preview widget
        </HeroButton>
      </div>
    </div>
  );
}
