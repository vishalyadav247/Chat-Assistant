import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { ReviewSourceData, TestActionResult } from "../routes/app.ai-agent.test";

// Test AI console (spec 08, design ai-agent.html #viewTest). Streams the real
// pipeline via POST /api/test-chat and parses the SSE frames from the fetch
// stream inline (the storefront widget has its own parser in extensions/ —
// admin code cannot import extension assets, so this tiny parser is local).
// After each reply the console fetches the saved Message row's debug data
// (sourceLayer / intent / productCards) through the route action ("source"
// intent) for the per-reply "Review source" panel.

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
  | { type: "error"; message: string };

interface ChatEntry {
  id: string;
  role: "user" | "bot";
  text: string;
  streaming?: boolean;
  cards?: ProductCardData[];
  source?: ReviewSourceData | null;
  sourceOpen?: boolean;
  feedback?: number;
  seeded?: boolean; // welcome bubble — no review source / feedback
}

const CANNED_CHIPS = [
  "What are your best sellers?",
  "Do you ship to Canada?",
  "keep my hands warm under $30",
];

const GUIDE_KEY = "chatconvert-test-ai-guide-dismissed";

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

function describeIntent(intent: unknown): string {
  if (!intent || typeof intent !== "object") return "—";
  const routed = intent as { intent?: string; keywords?: string[]; price_max?: number | null };
  const parts: string[] = [];
  if (routed.intent) parts.push(routed.intent);
  if (routed.keywords?.length) parts.push(`keywords: ${routed.keywords.join(", ")}`);
  if (routed.price_max != null) parts.push(`price max: ${routed.price_max}`);
  return parts.length ? parts.join(" · ") : "—";
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
  const [guideDismissed, setGuideDismissed] = useState(true);
  const conversationIdRef = useRef<string>("");
  const pendingSourceRef = useRef<string>("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const sourceFetcher = useFetcher<TestActionResult>();
  const feedbackFetcher = useFetcher<TestActionResult>();

  useEffect(() => {
    try {
      setGuideDismissed(localStorage.getItem(GUIDE_KEY) === "1");
    } catch {
      setGuideDismissed(false);
    }
  }, []);

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
      { id: botId, role: "bot", text: "", streaming: true },
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

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 280px",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* Chat card */}
      <s-box borderWidth="base" borderRadius="base">
        <div style={{ display: "flex", flexDirection: "column", height: 560 }}>
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

          <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            <div style={{ textAlign: "center", margin: "4px 0 12px" }}>
              <s-text tone="neutral">Today</s-text>
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
                      background:
                        entry.role === "user"
                          ? "#6d3bf5"
                          : "var(--s-color-bg-fill-secondary, #f1f1f1)",
                      color: entry.role === "user" ? "#fff" : "inherit",
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
                          border: "1px solid var(--s-color-border, #e3e3e3)",
                          borderRadius: 12,
                          overflow: "hidden",
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
                        onClick={() => patchEntry(entry.id, { sourceOpen: !entry.sourceOpen })}
                        style={{
                          border: "none",
                          background: "none",
                          padding: 0,
                          cursor: "pointer",
                          font: "inherit",
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#6d3bf5",
                        }}
                      >
                        Review source {entry.sourceOpen ? "▴" : "▾"}
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
                    {entry.sourceOpen ? (
                      <div
                        style={{
                          marginTop: 6,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid var(--s-color-border, #e3e3e3)",
                          fontSize: 12.5,
                        }}
                      >
                        {entry.source ? (
                          <s-stack gap="small">
                            <div>
                              <s-badge tone="info">{entry.source.sourceLayer ?? "unknown"}</s-badge>
                            </div>
                            <s-text tone="neutral">
                              Intent: {describeIntent(entry.source.intent)}
                            </s-text>
                            {entry.source.productCards?.length ? (
                              <s-text tone="neutral">
                                Products used:{" "}
                                {entry.source.productCards.map((c) => c.title).join(", ")}
                              </s-text>
                            ) : (
                              <s-text tone="neutral">No products attached to this reply.</s-text>
                            )}
                          </s-stack>
                        ) : (
                          <s-text tone="neutral">Loading source…</s-text>
                        )}
                      </div>
                    ) : null}
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

      {/* Side cards */}
      <s-stack gap="base">
        <s-section heading="Review sources">
          <s-paragraph>
            Click &apos;Review source&apos; on each AI response to view the layer, intent and data behind
            the reply.
          </s-paragraph>
        </s-section>
        {!guideDismissed ? (
          <s-banner
            tone="info"
            heading="Improve your AI"
            dismissible
            onDismiss={() => {
              setGuideDismissed(true);
              try {
                localStorage.setItem(GUIDE_KEY, "1");
              } catch {
                /* private mode */
              }
            }}
          >
            <s-paragraph>
              Keep adding more data sources to enhance AI&apos;s capabilities, quality and efficiency.
            </s-paragraph>
          </s-banner>
        ) : null}
        <s-section>
          <s-text tone="neutral">
            Test conversations never count toward your plan&apos;s conversation quota.
          </s-text>
        </s-section>
      </s-stack>
    </div>
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
};
