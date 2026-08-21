import { useState } from "react";
import type { TraceStatus, TraceStep, TraceSummary } from "../lib/pipeline/trace-types";
import type { ReviewSourceData } from "../routes/app.ai-agent.test";
import { INK, RADIUS, SCROLLBAR_CSS, SPACE, TONES, type Tone } from "./ui/tokens";

// Turn inspector (Test AI). Renders the trace a single reply produced: every
// layer the pipeline walked, the score each compared against its threshold,
// the rows it retrieved, and the exact payload handed to the model — plus what
// actually got written to the Message row.
//
// The trace arrives on the SSE stream behind the "done" frame and is never
// stored; this panel is the only place it exists.

const STATUS: Record<TraceStatus, { label: string; tone: Tone; glyph: string }> = {
  hit: { label: "decided", tone: "accent", glyph: "●" },
  pass: { label: "passed", tone: "success", glyph: "✓" },
  miss: { label: "no match", tone: "neutral", glyph: "○" },
  skip: { label: "skipped", tone: "neutral", glyph: "–" },
  info: { label: "context", tone: "info", glyph: "·" },
  error: { label: "failed", tone: "critical", glyph: "!" },
};

/** Layer keys whose payload is the point of the whole exercise — these open by
 *  default; everything else starts folded so the timeline stays scannable. */
const OPEN_BY_DEFAULT = new Set([
  "router",
  "curated_match",
  "knowledge_search",
  "product_search",
  "allow_list",
  "generation",
]);

const LONG_VALUE = 90;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ScalarText(props: { value: unknown }) {
  const { value } = props;
  if (value === null || value === undefined) {
    return <span style={{ color: INK.faint }}>—</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span style={{ color: value ? TONES.success.fg : INK.muted, fontWeight: 600 }}>
        {value ? "yes" : "no"}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>;
  }
  const text = String(value);
  if (text.length > LONG_VALUE) {
    return (
      <span
        style={{
          display: "block",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 190,
          overflowY: "auto",
          background: INK.surface2,
          border: `1px solid ${INK.borderSoft}`,
          borderRadius: RADIUS.chip,
          padding: SPACE.sm,
          marginTop: SPACE.xs,
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {text}
      </span>
    );
  }
  return <span>{text}</span>;
}

function ValueView(props: { value: unknown; depth?: number }) {
  const { value } = props;
  const depth = props.depth ?? 0;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span style={{ color: INK.faint }}>none</span>;
    const allScalar = value.every((v) => !isPlainObject(v) && !Array.isArray(v));
    if (allScalar) {
      return (
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: SPACE.xs }}>
          {value.map((v, i) => (
            <span
              key={i}
              style={{
                background: TONES.neutral.bg,
                color: TONES.neutral.fg,
                borderRadius: RADIUS.pill,
                padding: "1px 8px",
                fontSize: 11.5,
              }}
            >
              {String(v)}
            </span>
          ))}
        </span>
      );
    }
    return (
      <div style={{ display: "grid", gap: SPACE.xs, marginTop: SPACE.xs }}>
        {value.map((row, i) => (
          <div
            key={i}
            style={{
              border: `1px solid ${INK.borderSoft}`,
              borderRadius: RADIUS.chip,
              padding: `${SPACE.xs}px ${SPACE.sm}px`,
              background: INK.surface2,
            }}
          >
            <ValueView value={row} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (isPlainObject(value)) {
    return (
      <div style={{ display: "grid", gap: 2 }}>
        {Object.entries(value).map(([key, v]) => (
          <div key={key} style={{ display: "flex", gap: SPACE.sm, alignItems: "baseline" }}>
            <span
              style={{
                color: INK.muted,
                fontSize: 11.5,
                minWidth: 116,
                flexShrink: 0,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {key}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
              <ValueView value={v} depth={depth + 1} />
            </span>
          </div>
        ))}
      </div>
    );
  }

  return <ScalarText value={value} />;
}

function StepRow(props: { step: TraceStep; isLast: boolean }) {
  const { step, isLast } = props;
  const status = STATUS[step.status] ?? STATUS.info;
  const [open, setOpen] = useState(OPEN_BY_DEFAULT.has(step.layer));
  const hasDetail = Boolean(step.detail && Object.keys(step.detail).length > 0);

  return (
    <div style={{ display: "flex", gap: SPACE.md }}>
      {/* Rail */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 22 }}>
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: RADIUS.pill,
            background: TONES[status.tone].bg,
            color: TONES[status.tone].fg,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {status.glyph}
        </span>
        {!isLast ? (
          <span style={{ flex: 1, width: 1, background: INK.border, minHeight: 8 }} />
        ) : null}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : SPACE.md }}>
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          aria-expanded={hasDetail ? open : undefined}
          disabled={!hasDetail}
          style={{
            display: "flex",
            alignItems: "center",
            gap: SPACE.sm,
            width: "100%",
            border: "none",
            background: "none",
            padding: 0,
            font: "inherit",
            textAlign: "left",
            cursor: hasDetail ? "pointer" : "default",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: INK.strong }}>{step.label}</span>
          <span
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11,
              color: INK.faint,
            }}
          >
            {step.layer}
          </span>
          <span
            style={{
              background: TONES[status.tone].bg,
              color: TONES[status.tone].fg,
              borderRadius: RADIUS.pill,
              padding: "1px 8px",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {status.label}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: SPACE.sm }}>
            <span
              style={{ fontSize: 11, color: INK.faint, fontVariantNumeric: "tabular-nums" }}
              title={`${step.atMs}ms into the turn`}
            >
              {step.ms}ms
            </span>
            {hasDetail ? (
              <s-icon type={open ? "chevron-up" : "chevron-down"} size="small" />
            ) : null}
          </span>
        </button>

        {hasDetail && open ? (
          <div
            style={{
              marginTop: SPACE.sm,
              padding: SPACE.md,
              border: `1px solid ${INK.border}`,
              borderRadius: RADIUS.banner,
            }}
          >
            <ValueView value={step.detail} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gap: 1 }}>
      <span style={{ fontSize: 11, color: INK.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {props.label}
      </span>
      <span style={{ fontSize: 15, fontWeight: 700, color: INK.strong }}>{props.value}</span>
    </div>
  );
}

export interface InspectedTurn {
  /** The shopper message this turn answered. */
  question: string;
  steps: TraceStep[] | null;
  summary: TraceSummary | null;
  /** What was actually written to the Message row (undefined = still loading). */
  source: ReviewSourceData | null | undefined;
}

export function TurnInspector(props: {
  /** null = nothing selected yet (the console has not been used this session). */
  turn: InspectedTurn | null;
  /** Height of the scrolling timeline, matched to the chat card beside it. */
  scrollHeight?: number;
}) {
  const steps = props.turn?.steps ?? null;
  const summary = props.turn?.summary ?? null;
  const source = props.turn?.source;
  const [copied, setCopied] = useState(false);

  const copy = () => {
    try {
      void navigator.clipboard
        .writeText(JSON.stringify({ question: props.turn?.question, summary, steps }, null, 2))
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
    } catch {
      /* clipboard unavailable — the panel is still readable on screen */
    }
  };

  if (!props.turn) {
    return (
      <s-section heading="Turn inspector">
        <s-stack gap="base">
          <s-text tone="neutral">
            Send a message on the left, then open <strong>Why this reply?</strong> under any answer.
            Every layer the pipeline walked shows up here — the scores it compared against your
            thresholds, the rows it retrieved, and the exact product list the model was allowed to
            talk about.
          </s-text>
          <s-text tone="neutral">Test conversations never count toward your plan quota.</s-text>
        </s-stack>
      </s-section>
    );
  }

  if (!steps || steps.length === 0) {
    return (
      <s-section heading="Turn inspector">
        <s-paragraph>Collecting the trace for this reply…</s-paragraph>
      </s-section>
    );
  }

  const decided = [...steps].reverse().find((s) => s.status === "hit");

  return (
    <s-section heading="Turn inspector">
      <s-stack gap="base">
        <s-text tone="neutral">
          Every layer this reply walked through, in order, with the evidence each one used.
        </s-text>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: SPACE.base,
            alignItems: "center",
            padding: SPACE.md,
            border: `1px solid ${INK.border}`,
            borderRadius: RADIUS.banner,
            background: INK.surface2,
          }}
        >
          <Stat label="Question" value={props.turn.question.slice(0, 44) || "—"} />
          <Stat label="Answered by" value={source?.sourceLayer ?? decided?.layer ?? "—"} />
          <Stat label="Total" value={`${summary?.totalMs ?? 0}ms`} />
          <Stat label="Model calls" value={String(summary?.llmCalls ?? 0)} />
          <Stat label="Embeddings" value={String(summary?.embeddingCalls ?? 0)} />
          <div style={{ marginLeft: "auto" }}>
            <s-button variant="tertiary" onClick={copy}>
              {copied ? "Copied" : "Copy trace JSON"}
            </s-button>
          </div>
        </div>

        {/* The timeline scrolls inside the card so the inspector column stays
            the same height as the chat beside it, however deep the trace is. */}
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
        <div
          className="cc-scroll"
          style={{
            display: "grid",
            gap: SPACE.base,
            alignContent: "start",
            maxHeight: props.scrollHeight ?? 420,
            overflowY: "auto",
            paddingRight: SPACE.xs,
          }}
        >
          <div style={{ display: "grid" }}>
            {steps.map((step, i) => (
              <StepRow key={step.seq} step={step} isLast={i === steps.length - 1} />
            ))}
          </div>

          <div
            style={{
              padding: SPACE.md,
              border: `1px solid ${INK.border}`,
              borderRadius: RADIUS.banner,
            }}
          >
            <div
              style={{ fontSize: 13, fontWeight: 600, color: INK.strong, marginBottom: SPACE.sm }}
            >
              Saved to the conversation
            </div>
            {source === undefined ? (
              <s-text tone="neutral">Loading…</s-text>
            ) : source ? (
              <ValueView
                value={{
                  sourceLayer: source.sourceLayer,
                  intent: source.intent,
                  productCards: source.productCards?.map((c) => c.title) ?? null,
                }}
              />
            ) : (
              <s-text tone="neutral">
                Nothing was written for this turn — the reply came from a layer that stores no
                message row, or the fetch was superseded.
              </s-text>
            )}
          </div>
        </div>
      </s-stack>
    </s-section>
  );
}
