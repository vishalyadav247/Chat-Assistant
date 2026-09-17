import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { TraceStep, TraceSummary } from "../lib/pipeline/trace-types";
import type { ReviewSourceData, TestActionResult } from "../routes/app.ai-agent.test";
import { CHAT_CARD_CSS, ChatProductCards } from "./ChatProductCards";
import { BRAND, INK, SCROLLBAR_CSS } from "./ui/tokens";

// Test AI console (spec 08, design ai-agent.html #viewTest). Streams the real
// pipeline via POST /api/test-chat and parses the SSE frames from the fetch
// stream inline (the storefront widget has its own parser in extensions/ —
// admin code cannot import extension assets, so this tiny parser is local).
// MERCHANT preview, not a debugger (user decision 2026-09-14 — the developer
// Turn inspector moved to Admin → Debug): each reply shows a plain-words
// "Answered from" line built from the saved Message row's sourceLayer, which
// names the training surface to fix when an answer disappoints — plus the
// feedback faces. The endpoint no longer streams a "trace" frame (QA-U5).

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
  | { type: "actions"; actions: { key: string; label: string; screen: string }[] }
  | { type: "done"; outcome: string; conversationId: string }
  | { type: "trace"; steps: TraceStep[]; summary: TraceSummary }
  | { type: "error"; message: string };

interface ChatEntry {
  id: string;
  role: "user" | "bot";
  text: string;
  streaming?: boolean;
  cards?: ProductCardData[];
  /** In-widget buttons this reply offers the shopper (order tracking, contact,
   *  help). Shown here so the merchant sees what a shopper would see; they are
   *  inert in the console, which has no widget panel to open. */
  actions?: { key: string; label: string; screen: string }[];
  source?: ReviewSourceData | null;
  feedback?: number;
  seeded?: boolean; // welcome bubble — no review source / feedback
}

/** sourceLayer → what a MERCHANT should read, and where to improve it. */
const SOURCE_LABELS: Record<string, string> = {
  curated: "Curated answer",
  recommendation: "App recommendation rule",
  buy: "Product search",
  buy_browse: "Product search",
  detail: "Product details",
  question: "Store info & FAQs",
  rag_fallback: "Fallback — no matching info found",
  clarify: "Clarifying question",
  chat: "Small talk",
  banned: "Blocked topic",
  // QA-U3: layers the pipeline writes that had no label (raw text showed).
  off_topic: "Outside store topics",
  order_status: "Order tracking",
  handover: "Human handover",
  cap: "AI unavailable",
  human: "Human support mode",
};

/** Blocked turns save as `banned_${layer}` (keyword / meaning / router /
 *  moderation) — one merchant-facing type (QA-U3). */
export function sourceKey(layer: string): string {
  return layer.startsWith("banned_") ? "banned" : layer;
}

function sourceLabel(layer: string | null): string | null {
  if (!layer) return null;
  return SOURCE_LABELS[sourceKey(layer)] ?? layer.replace(/_/g, " ");
}

const NON_ENGLISH_WORDS = new Set([
  "hola", "gracias", "quiero", "busco", "tienen", "envío", "precio", "dónde", "cuánto",
  "cuál", "cual", "qué", "política", "politica", "devoluciones", "envíos",
  "bonjour", "merci", "cherche", "avez", "livraison", "combien", "où",
  "hallo", "danke", "suche", "haben", "versand", "viel",
  "namaste", "kya", "chahiye", "mujhe", "kitna", "aap",
]);

/**
 * The merchant is testing in another language (QA-U4). The old "3+ non-ASCII
 * letters" test fired on accented English ("café résumé"). Now: 3+ letters from
 * a non-Latin script, or a clearly non-English word from the languages the
 * persona supports (es / fr / de / Hindi in Latin script).
 */
export function looksNonEnglish(message: string): boolean {
  const letters = message.match(/\p{L}/gu) ?? [];
  if (letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length >= 3) return true;
  if (/[¿¡]/.test(message)) return true; // Spanish-only punctuation
  const words = message.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((w) => NON_ENGLISH_WORDS.has(w));
}

// ── Training missions (user request 2026-09-14: "make it a gaming
// experience") ──────────────────────────────────────────────────────────────
// Six guided challenges that auto-complete from what the pipeline actually
// did — playful on the surface, but each one walks the merchant through
// testing a REAL coverage area (products, store info, curated answers,
// conversation memory, languages, the fallback). Progress + score persist
// per browser; "Reset" starts a new chat but keeps the game going.

interface Mission {
  key: string;
  emoji: string;
  title: string;
  hint: string;
  /** Clicking the mission sends this message (missions without one are
   *  completed by HOW the merchant chats, not by a canned line). */
  sample?: string;
  points: number;
}

const MISSIONS: Mission[] = [
  {
    key: "product",
    emoji: "🛍️",
    title: "Get a product recommendation",
    hint: "Ask for something to buy — complete when product cards appear.",
    sample: "I'm looking for a gift — what do you recommend?",
    points: 15,
  },
  {
    key: "policy",
    emoji: "📦",
    title: "Ask a store question",
    hint: "Shipping, returns, policies — answered from your store info.",
    sample: "What is your return policy?",
    points: 15,
  },
  {
    key: "curated",
    emoji: "⭐",
    title: "Hit a curated answer",
    hint: "Ask something you wrote a curated answer for — word it your way.",
    points: 20,
  },
  {
    key: "memory",
    emoji: "🧠",
    title: "Hold a real conversation",
    hint: "Ask 4+ messages in one chat — follow-ups test the AI's memory.",
    points: 15,
  },
  {
    key: "polyglot",
    emoji: "🌍",
    title: "Switch languages mid-chat",
    hint: "Write in any other language — the AI should follow you.",
    sample: "¿Cuál es su política de devoluciones?",
    points: 20,
  },
  {
    key: "stump",
    emoji: "🕵️",
    title: "Try to stump it",
    hint: "Ask something your store can't answer. Finding a gap is a WIN — add it to your FAQs.",
    sample: "Do you sell helicopters?",
    points: 15,
  },
];

const LEVELS: { at: number; name: string }[] = [
  { at: 0, name: "Rookie tester" },
  { at: 30, name: "AI trainer" },
  { at: 60, name: "Prompt pro" },
  { at: 100, name: "AI whisperer" },
];

const GAME_KEY = "chatconvert-test-ai-game";

interface GameState {
  done: Record<string, boolean>;
  score: number;
  seenSources: string[];
}

function loadGame(): GameState {
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GameState>;
      return {
        done: parsed.done ?? {},
        score: typeof parsed.score === "number" ? parsed.score : 0,
        seenSources: Array.isArray(parsed.seenSources) ? parsed.seenSources : [],
      };
    }
  } catch {
    /* private mode */
  }
  return { done: {}, score: 0, seenSources: [] };
}

function levelFor(score: number): { name: string; next: number | null; pct: number } {
  let current = LEVELS[0];
  let next: { at: number; name: string } | null = null;
  for (const level of LEVELS) {
    if (score >= level.at) current = level;
    else {
      next = level;
      break;
    }
  }
  if (!next) return { name: current.name, next: null, pct: 100 };
  const span = next.at - current.at;
  return {
    name: current.name,
    next: next.at,
    pct: Math.min(100, Math.round(((score - current.at) / span) * 100)),
  };
}

const CONFETTI_EMOJI = ["🎉", "✨", "🎊", "⭐", "🥳", "💜"];

// Widget-style composer + gradient-header reset (2026-09-14). CSS classes
// because :hover / :focus-within can't be inline styles.
const COMPOSER_CSS = `
.cc-composer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 5px 5px 16px;
  border-radius: 999px;
  border: 1px solid var(--s-color-border, #d4d4d4);
  background: var(--s-color-bg-surface-secondary, #f7f7f8);
  transition: border-color .15s ease, box-shadow .15s ease, background-color .15s ease;
}
.cc-composer:focus-within {
  background: var(--s-color-bg, #fff);
  border-color: ${BRAND.accent};
  box-shadow: 0 0 0 3px rgba(109, 59, 245, 0.16);
}
.cc-composer input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 13.5px;
  padding: 7px 0;
}
.cc-composer input:disabled { opacity: .6; }
.cc-sendbtn {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: ${BRAND.gradient};
  box-shadow: 0 2px 8px rgba(109, 59, 245, 0.35);
  transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;
}
.cc-sendbtn:hover:not(:disabled) { transform: scale(1.06); box-shadow: 0 3px 12px rgba(109, 59, 245, 0.45); }
.cc-sendbtn:active:not(:disabled) { transform: scale(.97); }
.cc-sendbtn:disabled { opacity: .4; cursor: default; box-shadow: none; }
.cc-testreset {
  border: 1px solid rgba(255, 255, 255, .4);
  background: rgba(255, 255, 255, .14);
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: 999px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color .15s ease;
}
.cc-testreset:hover { background: rgba(255, 255, 255, .26); }
`;

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
  /** Storefront domain, so recommended-product cards link somewhere real. */
  shopDomain: string;
}) {
  const [sessionId, setSessionId] = useState(() => newSessionId());
  const [entries, setEntries] = useState<ChatEntry[]>(() => [
    { id: "welcome", role: "bot", text: props.welcome, seeded: true },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const conversationIdRef = useRef<string>("");

  // Training-missions game (2026-09-14). Loaded after mount so SSR and the
  // first client render agree (localStorage is browser-only).
  const [game, setGame] = useState<GameState>({ done: {}, score: 0, seenSources: [] });
  const [confetti, setConfetti] = useState(false);
  const userTurnsRef = useRef(0);
  useEffect(() => setGame(loadGame()), []);
  useEffect(() => {
    try {
      localStorage.setItem(GAME_KEY, JSON.stringify(game));
    } catch {
      /* private mode */
    }
  }, [game]);

  const completeMission = (key: string) => {
    setGame((prev) => {
      if (prev.done[key]) return prev;
      const mission = MISSIONS.find((m) => m.key === key);
      const next = {
        ...prev,
        done: { ...prev.done, [key]: true },
        score: prev.score + (mission?.points ?? 10),
      };
      if (MISSIONS.every((m) => next.done[m.key])) {
        setConfetti(true);
        setTimeout(() => setConfetti(false), 2600);
      }
      return next;
    });
  };

  const recordSource = (layer: string | null) => {
    if (!layer) return;
    setGame((prev) =>
      prev.seenSources.includes(sourceKey(layer))
        ? prev
        : { ...prev, seenSources: [...prev.seenSources, sourceKey(layer)] },
    );
    if (layer === "curated") completeMission("curated");
    if (layer === "question") completeMission("policy");
    // QA-U4: a clarifying question is not a knowledge gap — only the fallback is.
    if (layer === "rag_fallback") completeMission("stump");
  };
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
    recordSource(source?.sourceLayer ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Mission detection on the merchant's own message + conversation length.
    userTurnsRef.current += 1;
    if (userTurnsRef.current >= 4) completeMission("memory");
    if (looksNonEnglish(message)) completeMission("polyglot");
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
          if (frame.cards.length > 0) completeMission("product");
        } else if (frame.type === "actions") {
          patchEntry(botId, { actions: frame.actions });
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
    userTurnsRef.current = 0; // a fresh chat restarts the memory mission
    setEntries([{ id: "welcome", role: "bot", text: props.welcome, seeded: true }]);
    setInput("");
    setFaqOpen(false);
  };

  const giveFeedback = (entryId: string, rating: number) => {
    const first = entries.find((e) => e.id === entryId)?.feedback == null;
    patchEntry(entryId, { feedback: rating });
    // Rating replies earns a little score too — honest ratings, any face.
    if (first) setGame((prev) => ({ ...prev, score: prev.score + 5 }));
    feedbackFetcher.submit(
      { intent: "feedback", rating: String(rating), conversationId: conversationIdRef.current },
      { method: "post" },
    );
  };

  const noUserMessages = !entries.some((e) => e.role === "user");

  return (
    <s-stack gap="base">
      {/* Chat left, training-missions game right (user, 2026-09-14: "make it
          a gaming experience"). cc-split stacks the columns on phones. */}
      <div
        className="cc-split"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 300px",
          gap: 16,
          alignItems: "start",
        }}
      >
      {/* Chat card — styled like the storefront widget (user, 2026-09-14:
          gradient header, pill composer, round send button), so the preview
          FEELS like the thing shoppers use. */}
      <s-box borderWidth="base" borderRadius="base">
        {/* .cc-testchat shortens the card on phones (spec 19, app-mobile.css). */}
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS + CHAT_CARD_CSS + COMPOSER_CSS }} />
        <div
          className="cc-testchat"
          style={{
            display: "flex",
            flexDirection: "column",
            height: 620,
            overflow: "hidden",
            borderRadius: 8, // clip the gradient header to the card's corners
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "12px 16px",
              background: BRAND.gradient,
              color: "#fff",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span
                aria-hidden
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  background: "rgba(255,255,255,.18)",
                  border: "1px solid rgba(255,255,255,.35)",
                  flexShrink: 0,
                }}
              >
                ✨
              </span>
              <span style={{ display: "grid", lineHeight: 1.25, minWidth: 0 }}>
                <span style={{ fontWeight: 700, fontSize: 14.5 }}>Your AI agent</span>
                <span style={{ fontSize: 11.5, opacity: 0.85, display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "#4ade80",
                      boxShadow: "0 0 0 2.5px rgba(74,222,128,.30)",
                    }}
                  />
                  Test mode · replies use your live data
                </span>
              </span>
            </div>
            <button
              type="button"
              aria-label="Reset conversation"
              onClick={reset}
              className="cc-testreset"
            >
              ↺ Reset
            </button>
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

                {/* Same card component the inbox thread renders, so the two
                    merchant-side views of a recommendation cannot drift. */}
                {entry.cards?.length ? (
                  <ChatProductCards
                    cards={entry.cards}
                    currency={props.currency}
                    shopDomain={props.shopDomain}
                  />
                ) : null}

                {/* What the shopper gets instead of the agent describing a
                    storefront link that does not exist. Inert here — there is
                    no widget panel in the console for them to open. */}
                {entry.actions?.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {entry.actions.map((action) => (
                      <s-badge key={action.key} tone="info">
                        {`${action.label} → opens ${action.screen}`}
                      </s-badge>
                    ))}
                  </div>
                ) : null}

                {entry.role === "bot" && !entry.seeded && !entry.streaming && entry.text ? (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      {/* Plain-words provenance — tells the merchant WHICH
                          training surface produced the answer, so a bad reply
                          points at the thing to improve (curated answer, FAQ,
                          product data…). The developer trace lives in
                          Admin → Debug now. */}
                      {entry.source !== undefined && sourceLabel(entry.source?.sourceLayer ?? null) ? (
                        <span
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: INK.muted,
                            background: "rgba(255,255,255,.85)",
                            border: `1px solid ${INK.borderSoft}`,
                            borderRadius: 999,
                            padding: "2px 9px",
                          }}
                        >
                          Answered from: {sourceLabel(entry.source?.sourceLayer ?? null)}
                          {entry.source?.productCards?.length
                            ? ` · ${entry.source.productCards.length} product${entry.source.productCards.length === 1 ? "" : "s"}`
                            : ""}
                        </span>
                      ) : null}
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
              padding: 12,
              borderTop: "1px solid var(--s-color-border, #e3e3e3)",
              background: "var(--s-color-bg, #fff)",
            }}
          >
            <div className="cc-composer">
              <input
                type="text"
                value={input}
                placeholder={sending ? "The AI is replying…" : "Ask your AI anything…"}
                aria-label="Message"
                disabled={sending}
                onChange={(e) => setInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void send(input);
                  }
                }}
              />
              <button
                type="button"
                className="cc-sendbtn"
                aria-label="Send message"
                disabled={sending || !input.trim()}
                onClick={() => void send(input)}
              >
                {/* Paper plane — inline SVG so it inherits the white ink. */}
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M3.5 11.2 20.2 3.9c.7-.3 1.4.4 1.1 1.1l-7.3 16.7c-.3.7-1.3.7-1.6 0l-2.2-5.6a1 1 0 0 0-.6-.6l-5.6-2.2c-.7-.3-.7-1.3 0-1.6z"
                    fill="currentColor"
                  />
                  <path d="m11.3 12.7 4.2-4.2" stroke="rgba(255,255,255,.8)" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </s-box>

      <GamePanel
        game={game}
        confetti={confetti}
        sending={sending}
        onMissionClick={(mission) => {
          if (mission.sample && !game.done[mission.key]) void send(mission.sample);
        }}
      />
      </div>
    </s-stack>
  );
}

/** Score, level, missions checklist and discovered answer types. */
function GamePanel(props: {
  game: GameState;
  confetti: boolean;
  sending: boolean;
  onMissionClick: (mission: Mission) => void;
}) {
  const { game } = props;
  const level = levelFor(game.score);
  const doneCount = MISSIONS.filter((m) => game.done[m.key]).length;
  const allDone = doneCount === MISSIONS.length;

  return (
    <s-box borderWidth="base" borderRadius="base" padding="base">
      <div style={{ position: "relative", display: "grid", gap: 14 }}>
        {props.confetti ? (
          <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
            <style
              dangerouslySetInnerHTML={{
                __html:
                  "@keyframes cc-confetti-fall { from { transform: translateY(-30px) rotate(0deg); opacity: 1; } to { transform: translateY(340px) rotate(320deg); opacity: 0; } }",
              }}
            />
            {Array.from({ length: 18 }, (_, i) => (
              <span
                key={i}
                style={{
                  position: "absolute",
                  top: 0,
                  left: `${(i * 53) % 100}%`,
                  fontSize: 16 + ((i * 7) % 10),
                  animation: `cc-confetti-fall ${1.6 + ((i * 13) % 10) / 10}s ease-in ${((i * 17) % 8) / 10}s both`,
                }}
              >
                {CONFETTI_EMOJI[i % CONFETTI_EMOJI.length]}
              </span>
            ))}
          </div>
        ) : null}

        {/* Score + level */}
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <s-heading>Training missions</s-heading>
            <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.accent }}>
              {game.score} pts
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ fontWeight: 700 }}>
              {allDone ? "🏆 " : ""}
              {level.name}
            </span>
            <span style={{ opacity: 0.65 }}>
              {level.next !== null ? `next level at ${level.next} pts` : "max level!"}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={level.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progress to the next level"
            style={{ height: 6, borderRadius: 3, background: "var(--s-color-border, #e3e3e3)", overflow: "hidden" }}
          >
            <div style={{ width: `${level.pct}%`, height: "100%", background: BRAND.gradient, borderRadius: 3 }} />
          </div>
        </div>

        {/* Missions */}
        <div style={{ display: "grid", gap: 6 }}>
          <s-text color="subdued">
            {allDone
              ? "All missions complete — your AI survived the gauntlet! 🎉"
              : `${doneCount} of ${MISSIONS.length} complete — click a mission to try it.`}
          </s-text>
          {MISSIONS.map((mission) => {
            const done = Boolean(game.done[mission.key]);
            const clickable = Boolean(mission.sample) && !done && !props.sending;
            return (
              <button
                key={mission.key}
                type="button"
                title={mission.hint}
                disabled={!clickable}
                onClick={() => props.onMissionClick(mission)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  textAlign: "left",
                  font: "inherit",
                  fontSize: 12.5,
                  padding: "7px 10px",
                  borderRadius: 10,
                  cursor: clickable ? "pointer" : "default",
                  border: `1px solid ${done ? "rgba(0,180,90,.45)" : INK.borderSoft}`,
                  background: done ? "rgba(0,180,90,.08)" : "var(--s-color-bg, #fff)",
                  opacity: done ? 0.85 : 1,
                }}
              >
                <span style={{ fontSize: 16 }}>{done ? "✅" : mission.emoji}</span>
                <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, textDecoration: done ? "line-through" : "none" }}>
                    {mission.title}
                  </span>
                  <span style={{ opacity: 0.65, fontSize: 11.5 }}>
                    {done ? `+${mission.points} pts` : mission.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {/* Discovered answer types */}
        <div style={{ display: "grid", gap: 6 }}>
          <s-text color="subdued">
            Answer types discovered · {game.seenSources.filter((s) => SOURCE_LABELS[s]).length}
          </s-text>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {game.seenSources
              .filter((s) => SOURCE_LABELS[s])
              .map((s) => (
                <s-badge key={s} tone="info">
                  {SOURCE_LABELS[s]}
                </s-badge>
              ))}
            {game.seenSources.filter((s) => SOURCE_LABELS[s]).length === 0 ? (
              <s-text color="subdued">— start chatting to collect them</s-text>
            ) : null}
          </div>
        </div>
      </div>
    </s-box>
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
