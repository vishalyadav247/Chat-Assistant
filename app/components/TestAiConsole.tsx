import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { TraceStep, TraceSummary } from "../lib/pipeline/trace-types";
import type { ReviewSourceData, TestActionResult } from "../routes/app.ai-agent.test";
import { TurnInspector } from "./TurnInspector";
import { BRAND, INK, SCROLLBAR_CSS, SPACE } from "./ui/tokens";

// Test AI console (spec 08, design ai-agent.html #viewTest). Streams the real
// pipeline via POST /api/test-chat and parses the SSE frames from the fetch
// stream inline (the storefront widget has its own parser in extensions/ —
// admin code cannot import extension assets, so this tiny parser is local).
// Each reply carries two kinds of evidence. The decision trace arrives on the
// stream itself (a "trace" frame behind "done", api.test-chat.tsx) and shows
// every layer the pipeline walked; the saved Message row is fetched through the
// route action ("source" intent) and shows what was actually persisted. Both
// render in the Turn inspector below the console.

interface ProductCardData {
  shopifyProductId: string;
  title: string;
  price: number;
  imageUrl: string | null;
  handle: string;
  variantId: string | null;
}

type Frame =
  | { type: "token"; text: string }
  | { type: "message"; text: string }
  | { type: "cards"; cards: ProductCardData[] }
  | { type: "done"; outcome: string; conversationId: string }
  | { type: "trace"; steps: TraceStep[]; summary: TraceSummary }
  | { type: "error"; message: string };

interface ChatEntry {
  id: string;
  role: "user" | "bot";
  text: string;
  streaming?: boolean;
  cards?: ProductCardData[];
  source?: ReviewSourceData | null;
  /** The shopper message this turn answered — the inspector's header. */
  question?: string;
  /** Decision trace for this turn (Test AI only; arrives behind the done frame). */
  trace?: TraceStep[];
  traceSummary?: TraceSummary;
  feedback?: number;
  seeded?: boolean; // welcome bubble — no review source / feedback
}

const CANNED_CHIPS = [
  "What are your best sellers?",
  "Do you ship to Canada?",
  "keep my hands warm under $30",
];

const uid = () => `e${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
const newSessionId = () =>
  `test-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

async function streamSse(res: Response, onFrame: (frame: Frame) => void): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`request failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue; // skip heartbeat comments
        try {
          onFrame(JSON.parse(line.slice(6)) as Frame);
        } catch {
          // malformed frame — ignore
        }
      }
    }
  }
}

export function TestAiConsole(props: {
  welcome: string;
  faqChips: { id: string; question: string }[];
  currency: string;
}) {
  const [sessionId, setSessionId] = useState(() => newSessionId());
  const [entries, setEntries] = useState<ChatEntry[]>(() => [
    { id: "welcome", role: "bot", text: props.welcome, seeded: true },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  // Which reply the Turn inspector is showing. Set automatically to the newest
  // reply as its trace lands, so the panel always reflects the last thing sent.
  const [inspectId, setInspectId] = useState("");
  const conversationIdRef = useRef<string>("");
  const pendingSourceRef = useRef<string>("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const sourceFetcher = useFetcher<TestActionResult>();
  const feedbackFetcher = useFetcher<TestActionResult>();

  // Attach fetched review-source data to the reply that requested it.
  useEffect(() => {
    if (sourceFetcher.state !== "idle" || !sourceFetcher.data) return;
    const entryId = pendingSourceRef.current;
    if (!entryId) return;
    const source = sourceFetcher.data.ok ? (sourceFetcher.data.source ?? null) : null;
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, source } : e)));
    pendingSourceRef.current = "";
  }, [sourceFetcher.state, sourceFetcher.data]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

  const patchEntry = (id: string, patch: Partial<ChatEntry> | ((e: ChatEntry) => ChatEntry)) =>
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id ? (typeof patch === "function" ? patch(e) : { ...e, ...patch }) : e,
      ),
    );

  const send = async (raw: string) => {
    const message = raw.trim().slice(0, 2000);
    if (!message || sending) return;
    setInput("");
    setFaqOpen(false);
    const botId = uid();
    setEntries((prev) => [
      ...prev,
      { id: uid(), role: "user", text: message },
      { id: botId, role: "bot", text: "", streaming: true, question: message },
    ]);
    setSending(true);
    let doneConversationId = "";
    try {
      const res = await fetch("/api/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          conversationId: conversationIdRef.current || undefined,
          message,
        }),
      });
      await streamSse(res, (frame) => {
        if (frame.type === "token") {
          patchEntry(botId, (e) => ({ ...e, text: e.text + frame.text }));
        } else if (frame.type === "message") {
          patchEntry(botId, (e) => ({ ...e, text: e.text ? `${e.text}\n${frame.text}` : frame.text }));
        } else if (frame.type === "cards") {
          patchEntry(botId, { cards: frame.cards });
        } else if (frame.type === "done") {
          if (frame.conversationId) {
            conversationIdRef.current = frame.conversationId;
            doneConversationId = frame.conversationId;
          }
        } else if (frame.type === "trace") {
          patchEntry(botId, { trace: frame.steps, traceSummary: frame.summary });
          setInspectId(botId);
        } else if (frame.type === "error") {
          patchEntry(botId, (e) => ({
            ...e,
            text: e.text || "Something went wrong — try again.",
          }));
        }
      });
    } catch {
      patchEntry(botId, (e) => ({ ...e, text: e.text || "Something went wrong — try again." }));
    } finally {
      patchEntry(botId, { streaming: false });
      setSending(false);
      if (doneConversationId) {
        // One fetcher serves one request: submitting again supersedes any
        // in-flight source fetch, so settle the previous bubble instead of
        // leaving it on "Loading source…" forever (QA D12g).
        const superseded = pendingSourceRef.current;
        if (superseded && superseded !== botId) {
          setEntries((prev) =>
            prev.map((e) => (e.id === superseded && e.source === undefined ? { ...e, source: null } : e)),
          );
        }
        pendingSourceRef.current = botId;
        sourceFetcher.submit(
          { intent: "source", conversationId: doneConversationId },
          { method: "post" },
        );
      }
    }
  };

  const reset = () => {
    setSessionId(newSessionId());
    conversationIdRef.current = "";
    pendingSourceRef.current = "";
    setInspectId("");
    setEntries([{ id: "welcome", role: "bot", text: props.welcome, seeded: true }]);
    setInput("");
    setFaqOpen(false);
  };

  const giveFeedback = (entryId: string, rating: number) => {
    patchEntry(entryId, { feedback: rating });
    feedbackFetcher.submit(
      { intent: "feedback", rating: String(rating), conversationId: conversationIdRef.current },
      { method: "post" },
    );
  };

  const formatPrice = (price: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: props.currency }).format(price);

  const noUserMessages = !entries.some((e) => e.role === "user");
  const inspected = entries.find((e) => e.id === inspectId) ?? null;

  return (
    <s-stack gap="base">
      <div
        className="cc-split"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.15fr)",
          gap: SPACE.base,
          alignItems: "start",
        }}
      >
      {/* Chat card */}
      <s-box borderWidth="base" borderRadius="base">
        {/* .cc-testchat shortens the card on phones (spec 19, app-mobile.css). */}
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
        <div className="cc-testchat" style={{ display: "flex", flexDirection: "column", height: 560 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
            }}
          >
            <s-heading>Test your AI</s-heading>
            <s-button variant="tertiary" accessibilityLabel="Reset conversation" onClick={reset}>
              ↺ Reset
            </s-button>
          </div>

          <div
            ref={bodyRef}
            className="cc-scroll"
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 16,
              backgroundColor: "#f7f6fd",
              backgroundImage:
                "radial-gradient(rgba(109, 59, 245, 0.055) 1px, transparent 1px)," +
                "linear-gradient(180deg, rgba(109, 59, 245, 0.05) 0%, rgba(59, 130, 246, 0.05) 100%)",
              backgroundSize: "18px 18px, 100% 100%",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", margin: "2px 0 14px" }}>
              <span
                style={{
                  background: "rgba(255, 255, 255, 0.85)",
                  border: `1px solid ${INK.borderSoft}`,
                  borderRadius: 999,
                  padding: "3px 12px",
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: INK.muted,
                }}
              >
                Today
              </span>
            </div>

            {entries.map((entry) => (
              <div key={entry.id} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: entry.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      maxWidth: "78%",
                      padding: "9px 13px",
                      borderRadius: 14,
                      fontSize: 13.5,
                      whiteSpace: "pre-wrap",
                      background: entry.role === "user" ? BRAND.gradient : "#fff",
                      color: entry.role === "user" ? "#fff" : "inherit",
                      border: entry.role === "user" ? "none" : `1px solid ${INK.borderSoft}`,
                      boxShadow:
                        entry.role === "user"
                          ? "0 2px 8px rgba(109, 59, 245, 0.24)"
                          : "0 1px 2px rgba(20, 20, 25, 0.05)",
                    }}
                  >
                    {entry.streaming && !entry.text ? (
                      <span aria-label="AI is typing">···</span>
                    ) : (
                      entry.text
                    )}
                  </div>
                </div>

                {entry.cards?.length ? (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                    {entry.cards.map((card) => (
                      <div
                        key={card.shopifyProductId}
                        style={{
                          width: 140,
                          background: "#fff",
                          border: `1px solid ${INK.borderSoft}`,
                          borderRadius: 12,
                          overflow: "hidden",
                          boxShadow: "0 1px 2px rgba(20, 20, 25, 0.05)",
                        }}
                      >
                        {card.imageUrl ? (
                          <img
                            src={card.imageUrl}
                            alt={card.title}
                            style={{ width: "100%", height: 90, objectFit: "cover" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              height: 90,
                              background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
                            }}
                          />
                        )}
                        <div style={{ padding: "6px 8px" }}>
                          <div
                            style={{
                              fontSize: 12.5,
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {card.title}
                          </div>
                          <s-text tone="neutral">{formatPrice(card.price)}</s-text>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {entry.role === "bot" && !entry.seeded && !entry.streaming && entry.text ? (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button
                        type="button"
                        onClick={() => setInspectId((v) => (v === entry.id ? "" : entry.id))}
                        style={{
                          border: "none",
                          background: "none",
                          padding: 0,
                          cursor: "pointer",
                          font: "inherit",
                          fontSize: 12,
                          fontWeight: 600,
                          color: BRAND.accent,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 2,
                        }}
                      >
                        {inspectId === entry.id ? "Hide details" : "Why this reply?"}{" "}
                        <s-icon
                          type={inspectId === entry.id ? "chevron-up" : "chevron-down"}
                          size="small"
                        />
                      </button>
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        {[
                          { rating: 1, face: "🙁" },
                          { rating: 2, face: "😐" },
                          { rating: 3, face: "🙂" },
                        ].map(({ rating, face }) => (
                          <button
                            key={rating}
                            type="button"
                            aria-label={`Rate this reply ${rating} of 3`}
                            aria-pressed={entry.feedback === rating}
                            onClick={() => giveFeedback(entry.id, rating)}
                            style={{
                              border: "none",
                              background: "none",
                              cursor: "pointer",
                              padding: 0,
                              fontSize: 15,
                              opacity: entry.feedback == null || entry.feedback === rating ? 1 : 0.35,
                            }}
                          >
                            {face}
                          </button>
                        ))}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}

            {noUserMessages ? (
              <div style={{ marginTop: 10 }}>
                <s-text tone="neutral">Not sure what to ask?</s-text>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {props.faqChips.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setFaqOpen((v) => !v)}
                      style={chipStyle}
                    >
                      FAQ {faqOpen ? "▴" : "▾"}
                    </button>
                  ) : null}
                  {CANNED_CHIPS.map((chip) => (
                    <button key={chip} type="button" onClick={() => void send(chip)} style={chipStyle}>
                      {chip}
                    </button>
                  ))}
                </div>
                {faqOpen ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {props.faqChips.map((faq) => (
                      <button
                        key={faq.id}
                        type="button"
                        onClick={() => void send(faq.question)}
                        style={chipStyle}
                      >
                        {faq.question}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              padding: 12,
              borderTop: "1px solid var(--s-color-border, #e3e3e3)",
            }}
          >
            <input
              type="text"
              value={input}
              placeholder="Type your message"
              aria-label="Message"
              disabled={sending}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void send(input);
                }
              }}
              style={{
                flex: 1,
                padding: "9px 13px",
                borderRadius: 999,
                border: "1px solid var(--s-color-border, #d4d4d4)",
                font: "inherit",
              }}
            />
            <s-button
              variant="primary"
              accessibilityLabel="Send message"
              disabled={sending || !input.trim()}
              onClick={() => void send(input)}
            >
              Send
            </s-button>
          </div>
        </div>
      </s-box>

      {/* Inspector column — always mounted so the panel does not appear and
          disappear under the cursor; it renders its own idle state. */}
      <TurnInspector
        scrollHeight={392}
        turn={
          inspected
            ? {
                question: inspected.question ?? "",
                steps: inspected.trace ?? null,
                summary: inspected.traceSummary ?? null,
                source: inspected.source,
              }
            : null
        }
      />
      </div>
    </s-stack>
  );
}

const chipStyle: React.CSSProperties = {
  cursor: "pointer",
  font: "inherit",
  fontSize: 12.5,
  fontWeight: 600,
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid var(--s-color-border, #d4d4d4)",
  background: "var(--s-color-bg, #fff)",
  boxShadow: "0 1px 2px rgba(20, 20, 25, 0.05)",
};
