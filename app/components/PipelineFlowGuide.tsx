import { INK, RADIUS, SCROLLBAR_CSS, SPACE, TONES, type Tone } from "./ui/tokens";

// "How a reply is decided" — the runtime pipeline (spec 03) written out in
// order, with THIS shop's live thresholds substituted in. It is the reading
// companion to the Turn inspector: the guide says what each layer is for, the
// inspector says what each layer did on a given turn.
//
// The numbers here come from the loader (shop config), never from constants
// duplicated in the UI — a threshold changed in Instructions shows up here.

export interface FlowConfig {
  aiEnabled: boolean;
  bannedTopicCount: number;
  bannedMatchThreshold: number;
  handoverIntentRules: number;
  curatedMatchThreshold: number;
  curatedBorderline: number;
  minMeaningScore: number;
  answerOnlyFromKnowledge: boolean;
  learnProducts: boolean;
  learnDiscounts: boolean;
  excludeOutOfStock: boolean;
}

interface Stage {
  key: string;
  title: string;
  tone: Tone;
  /** What the layer does, in one sentence. */
  body: string;
  /** Live facts from this shop's config. */
  facts: (config: FlowConfig) => { label: string; value: string }[];
  /** Where the merchant changes it. */
  setIn?: string;
}

const yesNo = (value: boolean) => (value ? "on" : "off");

const STAGES: Stage[] = [
  {
    key: "gate",
    title: "Gatekeeping",
    tone: "neutral",
    body:
      "Before any money is spent: per-session rate limit, blocked visitors, conversations a human took over, the AI switch and your plan's usage cap. Any of these ends the turn with a canned line and zero model calls.",
    facts: (c) => [{ label: "AI replies", value: yesNo(c.aiEnabled) }],
    setIn: "Settings → General",
  },
  {
    key: "handover",
    title: "Handover triggers",
    tone: "warning",
    body:
      "Checked before retrieval so an escalation never gets answered by the bot first. Text triggers (an explicit ask, negative sentiment, the same question twice) run immediately; intent rules run against the embedding.",
    facts: (c) => [{ label: "Intent rules", value: String(c.handoverIntentRules) }],
    setIn: "AI Agent → Instructions → Handover",
  },
  {
    key: "guardrails",
    title: "Guardrails",
    tone: "critical",
    body:
      "Three independent layers. A word-boundary keyword scan needs no embedding. A meaning scan compares the message vector against your banned topics. Provider moderation runs in parallel with the router, so it costs no extra time.",
    facts: (c) => [
      { label: "Banned topics", value: String(c.bannedTopicCount) },
      { label: "Meaning threshold", value: c.bannedMatchThreshold.toFixed(2) },
    ],
    setIn: "AI Agent → Instructions → Guardrails",
  },
  {
    key: "embedding",
    title: "One embedding per turn",
    tone: "info",
    body:
      "The message is embedded once and that single vector is reused by every layer below — guardrails, curated match, recommendations, product search and RAG. This is why a turn costs so little.",
    facts: () => [{ label: "Vector", value: "1536 dims, reused 5×" }],
  },
  {
    key: "curated",
    title: "Curated answers",
    tone: "accent",
    body:
      "Your hand-written answers get first refusal. Above the serve threshold the answer goes out verbatim with zero generation calls. Between borderline and serve, one cheap yes/no call confirms the match. Below borderline the layer is skipped.",
    facts: (c) => [
      { label: "Serve at", value: `≥ ${c.curatedMatchThreshold.toFixed(2)}` },
      { label: "Confirm between", value: `${c.curatedBorderline.toFixed(2)} – ${c.curatedMatchThreshold.toFixed(2)}` },
    ],
    setIn: "AI Agent → Training data → Curated answers",
  },
  {
    key: "recommendation",
    title: "App recommendations",
    tone: "accent",
    body:
      "Ranked below your curated answers on purpose: a merchant-written answer always beats an app-generated one on the same trigger. If every pinned product is unavailable the layer steps aside instead of serving empty cards.",
    facts: (c) => [
      { label: "Serve at", value: `≥ ${c.curatedMatchThreshold.toFixed(2)}` },
      { label: "Hide sold out", value: yesNo(c.excludeOutOfStock) },
    ],
    setIn: "AI Agent → Training data → Recommendations",
  },
  {
    key: "router",
    title: "The router — model call 1 of 2",
    tone: "info",
    body:
      "The first of only two model calls. It returns strict JSON: intent (buy / question / chat), search keywords, a price ceiling, and off-topic and policy flags. Unparseable JSON is retried once, then falls to a clarify reply — it never guesses buy.",
    facts: () => [{ label: "Returns", value: "intent · keywords · price_max" }],
    setIn: "AI Agent → Instructions → General (store scope)",
  },
  {
    key: "buy",
    title: "Buy lane",
    tone: "success",
    body:
      "Hybrid retrieval: pgvector cosine similarity plus a weighted keyword index, fused by reciprocal rank. Only the top match tier is shown — one product or four, whatever actually matched, never padded. The model receives that same set as an allow-list.",
    facts: (c) => [
      { label: "Learn products", value: yesNo(c.learnProducts) },
      { label: "Relevance floor", value: c.minMeaningScore.toFixed(2) },
    ],
    setIn: "AI Agent → Training data → Products",
  },
  {
    key: "question",
    title: "Question lane (RAG)",
    tone: "success",
    body:
      "Top 3 knowledge chunks by cosine similarity. If the best hit is under the relevance floor and no discount facts apply, the reply is your fallback message and the question lands in the unresolved queue — the model is never asked to improvise.",
    facts: (c) => [
      { label: "Relevance floor", value: c.minMeaningScore.toFixed(2) },
      { label: "Answer only from knowledge", value: yesNo(c.answerOnlyFromKnowledge) },
      { label: "Learn discounts", value: yesNo(c.learnDiscounts) },
    ],
    setIn: "AI Agent → Training data → Knowledge",
  },
  {
    key: "chat",
    title: "Chat lane",
    tone: "neutral",
    body:
      "Greetings and small talk. No retrieval at all — just your persona and a short reply budget.",
    facts: () => [{ label: "Retrieval", value: "none" }],
    setIn: "AI Agent → Instructions → General",
  },
  {
    key: "reply",
    title: "The reply — model call 2 of 2",
    tone: "info",
    body:
      "The model is the voice, not the brain. It can only speak about the rows the lane handed it; titles, prices and images on the cards are rendered straight from the database, so a hallucinated product cannot reach a shopper.",
    facts: () => [{ label: "Grounding", value: "allow-list only" }],
  },
];

const MODAL_ID = "chatconvert-pipeline-walkthrough";

interface ModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const modalEl = (id: string) =>
  (typeof document === "undefined" ? null : document.getElementById(id)) as ModalElement | null;

export function PipelineFlowGuide(props: { config: FlowConfig }) {
  // The walkthrough opens in an overlay rather than expanding inline: it is
  // reference reading, and pushing the console 1,200px down the page to reach
  // it was exactly the problem the two-column layout fixed.
  return (
    <>
      <s-section heading="How a reply is decided">
        <s-stack gap="base">
          <s-text tone="neutral">
            Eleven layers run in a fixed order, and the first one that can answer wins. Only two of
            them call the model — everything in between is your data, matched by score against a
            threshold you control.
          </s-text>

          <div>
            <s-button variant="tertiary" onClick={() => modalEl(MODAL_ID)?.showOverlay()}>
              Show the walkthrough
            </s-button>
          </div>
        </s-stack>
      </s-section>

      <s-modal id={MODAL_ID} heading="How a reply is decided">
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
        <s-stack gap="base">
          <s-text tone="neutral">
            The first layer that can answer wins. Only two of them call the model — everything in
            between is your own data, matched by score against a threshold you control. The numbers
            below are this store&apos;s live settings.
          </s-text>

          <div
            className="cc-scroll"
            style={{ display: "grid", gap: SPACE.md, maxHeight: "60vh", overflowY: "auto" }}
          >
            {STAGES.map((stage, index) => {
              const facts = stage.facts(props.config);
              return (
                <div
                  key={stage.key}
                  style={{
                    display: "flex",
                    gap: SPACE.md,
                    padding: SPACE.md,
                    border: `1px solid ${INK.border}`,
                    borderRadius: RADIUS.banner,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 24,
                      height: 24,
                      flexShrink: 0,
                      borderRadius: RADIUS.pill,
                      background: TONES[stage.tone].bg,
                      color: TONES[stage.tone].fg,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {index + 1}
                  </span>
                  <div style={{ flex: 1, minWidth: 0, display: "grid", gap: SPACE.sm }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: INK.strong }}>
                      {stage.title}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.55, color: INK.base }}>
                      {stage.body}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: SPACE.sm,
                        alignItems: "center",
                      }}
                    >
                      {facts.map((fact) => (
                        <span
                          key={fact.label}
                          style={{
                            display: "inline-flex",
                            gap: SPACE.xs,
                            alignItems: "baseline",
                            background: INK.surface2,
                            border: `1px solid ${INK.borderSoft}`,
                            borderRadius: RADIUS.pill,
                            padding: "2px 10px",
                            fontSize: 11.5,
                          }}
                        >
                          <span style={{ color: INK.muted }}>{fact.label}</span>
                          <strong style={{ color: INK.strong }}>{fact.value}</strong>
                        </span>
                      ))}
                      {stage.setIn ? (
                        <span style={{ fontSize: 11.5, color: INK.faint }}>Set in {stage.setIn}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </s-stack>

        <s-button slot="primary-action" onClick={() => modalEl(MODAL_ID)?.hideOverlay()}>
          Done
        </s-button>
      </s-modal>
    </>
  );
}
