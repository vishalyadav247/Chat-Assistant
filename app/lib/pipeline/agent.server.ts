import db from "../../db.server";
import { env } from "../env.server";
import { embedText, toSqlVector } from "../embeddings/embedding.server";
import { formatMoney } from "../format/money";
import {
  getLlmProvider,
  type AgentMessage,
  type ChatMessage,
  type ToolCall,
  type ToolDefinition,
} from "../llm/index.server";
import { logError } from "../log.server";
import type { ShopConfig } from "../config/shop-config.server";
import { knowledgeSearch } from "../search/knowledge-search.server";
import {
  candidateSnippet,
  hybridProductSearch,
  isPurchasable,
  selectRelevant,
  type ProductVariantInfo,
} from "../search/product-search.server";
import { Prisma } from "@prisma/client";
import { SHOWABLE_PRODUCT } from "../search/showable";
import { availableActions, type ChatAction } from "./actions.server";
import { canned } from "./canned.server";
import { fallbackLeaveMessageForm } from "./handover.server";
import { shownProducts } from "./detail.server";
import type { PipelineFrame, ProductCard } from "./index.server";
import { agentPolicy, agentStoreContext, AGENT_SYSTEM } from "./prompts";
import type { Trace } from "./trace.server";

// AI agent mode (spec 24). The model reads the whole conversation and looks
// facts up with tools; code implements every tool, scopes it to the shop and
// builds every card from DB rows. There is no router, lane or per-phrase rule:
// "is it unisex" after a card is a get_product call because the model can see
// which product "it" is, not because a regex recognised the words.

/** Model rounds per turn (tool calls + the final reply). The last round offers no tools, forcing an answer. */
const MAX_ROUNDS = 5;
/** Tool calls executed per round; further calls in the same round are refused. */
const MAX_TOOL_CALLS_PER_ROUND = 4;
/** After this long, the next round is the answer round (no more tool calls). */
const TURN_BUDGET_MS = 15_000;
const MAX_CARDS = 4;
/** Shortest title fragment a partial product-name match may use. */
const MIN_PARTIAL_TITLE = 5;
const SEARCH_LIMIT = 8;

type TrackFn = (type: import("../analytics/events.server").AnalyticsEventType, payload?: Record<string, unknown>) => Promise<void>;

/** Helpers owned by index.server.ts, passed in so this module never imports it at runtime. */
export interface AgentDeps {
  saveMessage(
    shopId: string,
    conversationId: string,
    data: { role: "out"; author: string; content: string; sourceLayer?: string; intent?: unknown; productCards?: ProductCard[] },
  ): Promise<string>;
  recordUnresolved(shopId: string, conversationId: string, question: string, reason: string, isTest: boolean): Promise<void>;
  cardsForShopifyIds(shopId: string, ids: string[], excludeOutOfStock: boolean): Promise<ProductCard[]>;
  appendCrossSell(shopId: string, cards: ProductCard[], excludeOutOfStock: boolean): Promise<ProductCard[]>;
  discountFacts(shopId: string): Promise<string>;
  escalateCannotAnswer(shopId: string, conversationId: string, config: ShopConfig): Promise<PipelineFrame[]>;
}

/** The agent is the engine for every shop; `AI_AGENT_MODE=pipeline` is the rollback switch. */
export function agentModeEnabled(): boolean {
  return env().AI_AGENT_MODE !== "pipeline";
}

/** Explicit model pin, or undefined → the provider uses the dashboard model, then CHAT_MODEL. */
export function agentModel(): string | undefined {
  return env().AGENT_MODEL.trim() || undefined;
}

/**
 * Streaming link guard. Tool results carry merchant and crawled text, and the
 * widget turns https URLs in a reply into clickable links — so text injected
 * into a crawled page could otherwise put a working off-site link inside the
 * store's chat. The agent is told never to write links; this enforces it for
 * absolute URLs that are not the store's own domain (product links come
 * through cards, never through text). Holds back only an unfinished URL.
 */
export class LinkGuard {
  private pending = "";
  constructor(private readonly allowedHosts: string[]) {}

  push(text: string): string {
    this.pending += text;
    let out = "";
    for (;;) {
      const match = /https?:\/\/[^\s<>"'()[\]]*/i.exec(this.pending);
      if (!match) {
        // Keep a trailing fragment that could still grow into "https://".
        const tail = /h(?:t(?:t(?:p(?:s(?::(?:\/\/?)?)?|:(?:\/\/?)?)?)?)?)?$/i.exec(this.pending);
        const cut = tail ? tail.index : this.pending.length;
        out += this.pending.slice(0, cut);
        this.pending = this.pending.slice(cut);
        return out;
      }
      const end = match.index + match[0].length;
      if (end >= this.pending.length) {
        // URL may continue in the next token.
        out += this.pending.slice(0, match.index);
        this.pending = this.pending.slice(match.index);
        return out;
      }
      out += this.pending.slice(0, match.index) + this.clean(match[0]);
      this.pending = this.pending.slice(end);
    }
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest.replace(/https?:\/\/[^\s<>"'()[\]]*/gi, (url) => this.clean(url));
  }

  private clean(url: string): string {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return this.allowedHosts.includes(host) ? url : "";
    } catch {
      return "";
    }
  }
}

/** "gid://shopify/Product/123" or "123" → the stored gid. */
function productGid(id: unknown): string | null {
  const raw = String(id ?? "").trim();
  const numeric = raw.split("/").pop() ?? "";
  return /^\d+$/.test(numeric) ? `gid://shopify/Product/${numeric}` : null;
}

const shortId = (gid: string) => gid.split("/").pop() ?? gid;

// ── Tool schemas ────────────────────────────────────────────────────────────

function toolDefinitions(config: ShopConfig, actions: ChatAction[]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (config.settings.learn.products) {
    tools.push(
      {
        name: "search_products",
        description:
          "Search this store's catalogue. Describe what the shopper wants in plain words: the kind of product plus any purpose, feature, style, size, material or who it is for (e.g. 'waterproof jacket for hiking', 'gift for a coffee lover', 'moisturiser for dry skin'). Each result has match 'best' (strongest matches for the query) or 'possible' (weaker — show only if it truly fits).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for, written in English." },
            max_price: { type: "number", description: "Budget ceiling in the store's currency, only if the shopper gave one." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "get_product",
        description:
          "Full details of one product: price, availability, variants (sizes, colours, options), type, vendor, tags, specifications and description. Use it for any question about a specific product.",
        parameters: {
          type: "object",
          properties: {
            product: { type: "string", description: "The product's exact title (preferred) or its id." },
          },
          required: ["product"],
          additionalProperties: false,
        },
      },
      {
        name: "show_products",
        description: "Show product cards to the shopper (max 4), best first. Only products returned by the tools.",
        parameters: {
          type: "object",
          properties: {
            products: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_CARDS,
              description: "Exact titles (preferred) or ids.",
            },
          },
          required: ["products"],
          additionalProperties: false,
        },
      },
    );
  }
  tools.push({
    name: "search_store_info",
    description:
      "Search this store's own information: answers written by the store, FAQs, shipping, returns, payment and other policies, store pages, blog articles, contact details and collection names. Results marked source 'store answer' are the store's own approved wording — prefer them.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The question as a complete sentence." } },
      required: ["question"],
      additionalProperties: false,
    },
  });
  if (config.settings.learn.discounts) {
    tools.push({
      name: "get_discounts",
      description: "The store's currently active discounts, offers and codes, and how to claim them.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    });
  }
  if (actions.length > 0) {
    tools.push({
      name: "offer_button",
      description:
        "Show a button under your reply that opens a screen of this chat widget: " +
        actions.map((a) => `${a.key} (${a.label})`).join(", ") +
        ". Refer to it as the button below.",
      parameters: {
        type: "object",
        properties: { button: { type: "string", enum: actions.map((a) => a.key) } },
        required: ["button"],
        additionalProperties: false,
      },
    });
  }
  tools.push({
    name: "decline",
    description:
      "Use only when the shopper asks about a topic the store does not allow (kind 'banned_topic') or for a task unrelated to shopping here, such as general knowledge, writing, homework or coding (kind 'off_topic'). Never use it for a product request — even for a product this store does not sell: search, then tell the shopper plainly the store doesn't carry it. The app replies with the store's own message — do not write a reply yourself.",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: ["banned_topic", "off_topic"] } },
      required: ["kind"],
      additionalProperties: false,
    },
  });
  tools.push({
    name: "cannot_answer",
    description:
      "Call when the tools do not contain the answer to the shopper's question, so the store team can follow up. Still reply honestly that you are not sure.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  });
  return tools;
}

// ── The agent turn ──────────────────────────────────────────────────────────

export async function* agentLane(args: {
  shopId: string;
  convoId: string;
  config: ShopConfig;
  message: string;
  /** Persona + language + shopper facts, as built for every lane. */
  personaPrompt: string;
  /** Summary + recent messages, assistant turns annotated with their cards. */
  history: ChatMessage[];
  meterPromise: Promise<unknown>;
  track: TrackFn;
  trace: Trace;
  isTest: boolean;
  /** The merchant's fallback message (or the translated built-in). */
  fallback: string;
  /** The shopper message's embedding (already computed for this turn). */
  queryEmbedding: number[];
  deps: AgentDeps;
}): AsyncIterable<PipelineFrame> {
  const { shopId, config, trace, deps } = args;
  const excludeOutOfStock = config.settings.recommendationRules.excludeOutOfStock;
  const minMeaningScore = config.guardrails?.minMeaningScore ?? 0.3;
  const widgetActions = availableActions(config.widget);
  const tools = toolDefinitions(config, widgetActions);
  const policy = agentPolicy(config.guardrails?.bannedTopics ?? [], config.persona?.scope ?? "");

  const storeContext = agentStoreContext({
    name: config.settings.storeInfo.name || config.shopName,
    currency: config.currency,
  });

  const messages: AgentMessage[] = [
    { role: "system", content: [args.personaPrompt, AGENT_SYSTEM, storeContext, policy].filter(Boolean).join("\n\n") },
    ...args.history.map((m): AgentMessage => ({ role: m.role, content: m.content })),
    { role: "user", content: args.message },
  ];

  // Turn state the tools write to.
  let cards: ProductCard[] = [];
  const actions: ChatAction[] = [];
  let cannotAnswer = false;
  /** Products get_product loaded this turn (gids, in order). */
  const lookedUp: string[] = [];
  /** Set by the decline tool: the reply becomes the store's own message. */
  let declined: "banned_topic" | "off_topic" | null = null;
  const toolsUsed: string[] = [];
  /** Compact facts looked up this turn, saved with the reply so later turns
   *  remember them ("what is the price of this" after get_product). */
  const facts: string[] = [];

  // Products are named by title or id. Models mis-copy 13-digit ids, so a
  // title is the preferred handle; ids still work. Products this conversation
  // already showed win a title match, then the shop's showable catalogue.
  let shownCache: { shopifyProductId: string; title: string }[] | null = null;
  async function resolveProduct(ref: unknown): Promise<string | null> {
    const raw = String(ref ?? "").trim();
    if (!raw) return null;
    const gid = productGid(raw);
    if (gid) {
      const hit = await db.product.findFirst({
        where: { shopId, shopifyProductId: gid, ...SHOWABLE_PRODUCT },
        select: { shopifyProductId: true },
      });
      if (hit) return hit.shopifyProductId;
    }
    const lower = raw.toLowerCase();
    shownCache ??= await shownProducts(shopId, args.convoId).catch(() => []);
    // Partial matches need a meaningful fragment: "a" or "1" would otherwise
    // match an unrelated product (tenancy review note).
    const partialOk = lower.length >= MIN_PARTIAL_TITLE;
    const shown =
      shownCache.find((p) => p.title.toLowerCase() === lower) ??
      (partialOk
        ? shownCache.find((p) => {
            const title = p.title.toLowerCase();
            return title.includes(lower) || (title.length >= MIN_PARTIAL_TITLE && lower.includes(title));
          })
        : undefined);
    if (shown) return shown.shopifyProductId;
    const exact = await db.product.findFirst({
      where: { shopId, ...SHOWABLE_PRODUCT, title: { equals: raw, mode: "insensitive" } },
      select: { shopifyProductId: true },
    });
    if (exact) return exact.shopifyProductId;
    if (!partialOk) return null;
    const partial = await db.product.findFirst({
      where: { shopId, ...SHOWABLE_PRODUCT, title: { contains: raw, mode: "insensitive" } },
      orderBy: { title: "asc" },
      select: { shopifyProductId: true },
    });
    return partial?.shopifyProductId ?? null;
  }

  // Merchant-written curated answers close to the question. The deterministic
  // layer before the agent serves only near-exact matches (≥ the serve
  // threshold); a paraphrase between the borderline and serve thresholds used
  // to be invisible here, so the agent answered from general knowledge instead
  // of the merchant's own words.
  async function curatedAnswersFor(embedding: number[]) {
    const floor = config.guardrails?.curatedBorderline ?? 0.65;
    const rows = await db.$queryRaw<{ question: string; talkingPoints: string; productIds: string[]; score: number }[]>(Prisma.sql`
      SELECT "question", "talkingPoints", "productIds",
             (1 - ("embedding" <=> ${toSqlVector(embedding)}::vector))::float8 AS score
      FROM "curated_answers"
      WHERE "shopId" = ${shopId} AND "status" = 'published' AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${toSqlVector(embedding)}::vector
      LIMIT 2
    `);
    const close = rows.filter((r) => Number(r.score) >= floor);
    return Promise.all(
      close.map(async (r) => {
        const pinned =
          config.settings.learn.products && r.productIds.length > 0
            ? await deps.cardsForShopifyIds(shopId, r.productIds.slice(0, MAX_CARDS), excludeOutOfStock)
            : [];
        return {
          source: "store answer",
          topic: r.question,
          text: r.talkingPoints.replace(/\s+/g, " ").trim().slice(0, 1500),
          ...(pinned.length > 0 ? { products: pinned.map((c) => c.title) } : {}),
        };
      }),
    );
  }

  async function runTool(call: ToolCall): Promise<unknown> {
    let input: Record<string, unknown>;
    try {
      input = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    } catch {
      return { error: "Arguments were not valid JSON." };
    }
    toolsUsed.push(call.name);
    switch (call.name) {
      case "search_products": {
        if (!config.settings.learn.products) return { error: "Product search is not available." };
        const query = String(input.query ?? "").slice(0, 300) || args.message;
        const maxPrice = typeof input.max_price === "number" && input.max_price > 0 ? input.max_price : null;
        const embedding = await embedText(query, { shopId });
        trace.countLlm("embedding");
        const found = await hybridProductSearch({
          shopId,
          queryEmbedding: embedding,
          keywords: [],
          message: query,
          priceMax: maxPrice,
          minMeaningScore,
          excludeOutOfStock,
          limit: SEARCH_LIMIT,
        });
        // The search's own relevance tier (keyword coverage, else vector
        // distance) tells the model which rows are the real matches — the
        // signal it lacked when it padded picks with loosely related items.
        const bestIds = new Set(selectRelevant(found, SEARCH_LIMIT).map((c) => c.id));
        return {
          results: found.map((c) => ({
            id: shortId(c.shopifyProductId),
            title: c.title,
            price: formatMoney(c.price, config.currency),
            available: isPurchasable(c),
            match: bestIds.has(c.id) ? "best" : "possible",
            details: candidateSnippet(c),
          })),
          ...(found.length === 0 ? { note: "No matching products in this store." } : {}),
        };
      }
      case "get_product": {
        if (!config.settings.learn.products) return { error: "Product details are not available." };
        const ref = String(input.product ?? input.product_id ?? "").slice(0, 200);
        let gid = await resolveProduct(ref);
        let closestTo: string | null = null;
        if (!gid) {
          // A guessed or slightly wrong name must not become "we don't sell
          // it": return the closest real products so the next call can use an
          // exact title.
          // The shopper's own words lead: a model-invented title ("X Chips
          // Bracelet Adjustable") would otherwise rank look-alike titles above
          // the product the shopper actually named.
          const [fromShopper, fromRef] = await Promise.all([
            hybridProductSearch({
              shopId,
              queryEmbedding: args.queryEmbedding,
              keywords: [],
              message: args.message,
              priceMax: null,
              minMeaningScore,
              excludeOutOfStock: false,
              limit: 5,
            }).catch(() => []),
            ref.trim()
              ? embedText(ref, { shopId })
                  .then((e) =>
                    hybridProductSearch({
                      shopId,
                      queryEmbedding: e,
                      keywords: [],
                      message: ref,
                      priceMax: null,
                      minMeaningScore,
                      excludeOutOfStock: false,
                      limit: 5,
                    }),
                  )
                  .catch(() => [])
              : Promise.resolve([]),
          ]);
          if (ref.trim()) trace.countLlm("embedding");
          // One clear winner for the shopper's own words (alone in the top
          // relevance tier, with a shopper word in its title/tags) is the
          // product they mean: answer about it instead of asking "did you mean".
          const tier = selectRelevant(fromShopper, 5);
          if (tier.length === 1 && tier[0].coverage > 0 && tier[0].headTerms.length > 0) {
            gid = tier[0].shopifyProductId;
            closestTo = ref;
          } else {
            const seenIds = new Set<string>();
            const closest = [...fromShopper, ...fromRef]
              .filter((c) => (seenIds.has(c.id) ? false : (seenIds.add(c.id), true)))
              .slice(0, 5);
            return {
              not_found: ref,
              closest_matches: closest.map((c) => ({ title: c.title, price: formatMoney(c.price, config.currency) })),
              note:
                closest.length > 0
                  ? "No product has exactly that title. If one of these is what the shopper means, call get_product with its exact title."
                  : "No product like that in this store.",
            };
          }
        }
        if (!gid) return { error: "No product with that title or id in this store." };
        if (!lookedUp.includes(gid)) lookedUp.push(gid);
        const p = await db.product.findFirst({
          where: { shopId, shopifyProductId: gid, ...SHOWABLE_PRODUCT },
          select: {
            shopifyProductId: true, title: true, price: true, stock: true, variants: true,
            productType: true, vendor: true, tags: true, description: true, metafieldText: true,
          },
        });
        if (!p) return { error: "That product is not available in this store." };
        const variants = (p.variants as ProductVariantInfo[] | null) ?? [];
        const variantList = variants
          .filter((v) => v.title && v.title.toLowerCase() !== "default title")
          .slice(0, 15)
          .map((v) => `${v.title}${v.available ? "" : " (sold out)"}`);
        const price = formatMoney(Number(p.price), config.currency);
        const available = isPurchasable(p);
        facts.push(
          `${p.title}: ${price}, ${available ? "available" : "sold out"}` +
            `${variantList.length ? `, variants ${variantList.join(" / ")}` : ""}` +
            `${p.tags.length ? `, tags ${p.tags.slice(0, 8).join(", ")}` : ""}`,
        );
        return {
          ...(closestTo ? { note: `No product is titled "${closestTo}"; this is the product matching the shopper's words.` } : {}),
          id: shortId(p.shopifyProductId),
          title: p.title,
          price,
          available,
          variants: variantList,
          type: p.productType,
          vendor: p.vendor,
          tags: p.tags.slice(0, 20),
          specifications: p.metafieldText.trim().slice(0, 1500),
          // Up to 5,000 chars: long SEO descriptions keep facts (sizes, who it
          // suits, care) deep in the text. Sent to the model only for this
          // lookup — history keeps the compact facts, not the description.
          description: p.description.replace(/\s+/g, " ").trim().slice(0, 5000),
        };
      }
      case "show_products": {
        if (!config.settings.learn.products) return { error: "Products cannot be shown." };
        const requested = (Array.isArray(input.products) ? input.products : Array.isArray(input.product_ids) ? input.product_ids : [])
          .slice(0, MAX_CARDS * 2)
          .map((r) => String(r));
        const resolved = await Promise.all(requested.map(async (ref) => ({ ref, gid: await resolveProduct(ref) })));
        const gids = [...new Set(resolved.map((r) => r.gid).filter((g): g is string => g !== null))].slice(0, MAX_CARDS);
        const rows = await deps.cardsForShopifyIds(shopId, gids, excludeOutOfStock);
        const byId = new Map(rows.map((r) => [r.shopifyProductId, r]));
        cards = gids.map((g) => byId.get(g)).filter((c): c is ProductCard => Boolean(c));
        const missing = resolved.filter((r) => !r.gid || !byId.has(r.gid)).map((r) => r.ref);
        for (const c of cards) facts.push(`shown ${c.title}: ${formatMoney(c.price, config.currency)}`);
        return {
          shown: cards.map((c) => c.title),
          ...(missing.length > 0 ? { not_shown: missing, reason: "not found or not available to buy" } : {}),
        };
      }
      case "search_store_info": {
        const question = String(input.question ?? "").slice(0, 400) || args.message;
        const embedding = await embedText(question, { shopId });
        trace.countLlm("embedding");
        // Searched with the model's question AND the shopper's own words (the
        // turn's existing embedding, no extra call): a rewrite can drift from
        // how the store phrased it, and the passage then scores under the floor.
        const embeddings = question.trim().toLowerCase() === args.message.trim().toLowerCase()
          ? [embedding]
          : [embedding, args.queryEmbedding];
        const mergeHits = (lists: Awaited<ReturnType<typeof knowledgeSearch>>[]) => {
          const best = new Map<string, Awaited<ReturnType<typeof knowledgeSearch>>[number]>();
          for (const hit of lists.flat()) {
            const seen = best.get(hit.id);
            if (!seen || hit.score > seen.score) best.set(hit.id, hit);
          }
          return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 4);
        };
        const [hits, storeAnswers, collections] = await Promise.all([
          Promise.all(embeddings.map((e) => knowledgeSearch(shopId, e, 4)))
            .then(mergeHits)
            .then((rows) => rows.filter((h) => h.score >= minMeaningScore)),
          Promise.all(embeddings.map((e) => curatedAnswersFor(e))).then((lists) => {
            const byTopic = new Map<string, (typeof lists)[number][number]>();
            for (const answer of lists.flat()) if (!byTopic.has(answer.topic)) byTopic.set(answer.topic, answer);
            return [...byTopic.values()].slice(0, 2);
          }),
          config.settings.learn.collections
            ? db.collection.findMany({
                where: { shopId, learnEnabled: true },
                orderBy: { productCount: "desc" },
                take: 25,
                select: { title: true },
              })
            : Promise.resolve([] as { title: string }[]),
        ]);
        const results = [
          ...storeAnswers,
          ...hits.map((h) => ({
            source: "store info",
            topic: h.topic,
            text: h.body.replace(/\s+/g, " ").trim().slice(0, 1500),
          })),
        ];
        return {
          results,
          collections: collections.map((c) => c.title),
          ...(results.length === 0 ? { note: "Nothing about this in the store's information." } : {}),
        };
      }
      case "get_discounts": {
        if (!config.settings.learn.discounts) return { error: "Discount information is not available." };
        const facts = await deps.discountFacts(shopId);
        return { discounts: facts.trim() || "There are no active discounts right now." };
      }
      case "offer_button": {
        const action = widgetActions.find((a) => a.key === input.button);
        if (!action) return { error: "That button is not available." };
        if (!actions.some((a) => a.key === action.key)) actions.push(action);
        return { ok: true, label: action.label };
      }
      case "decline": {
        const kind = input.kind === "banned_topic" ? "banned_topic" : "off_topic";
        // "Do you sell helicopters?" is a product request, not an unrelated
        // task: an off-topic refusal only stands once the agent has looked in
        // the store. A banned topic is merchant policy and stands at once.
        // A merchant who configured a store scope asked for strict off-topic
        // handling with their own message, so their refusal stands at once.
        const searched = toolsUsed.includes("search_products") || toolsUsed.includes("search_store_info");
        const scopeConfigured = Boolean(config.persona?.scope?.trim());
        if (kind === "off_topic" && !searched && !scopeConfigured && config.settings.learn.products) {
          return {
            error:
              "Not declined. If the shopper could be asking for a product or about the store, search first and answer from the results (say plainly if the store doesn't carry it). Call decline again only if the request is truly unrelated to shopping here.",
          };
        }
        declined = kind;
        return { ok: true, note: "The store's own message will be shown. Do not reply." };
      }
      case "cannot_answer": {
        cannotAnswer = true;
        await deps.recordUnresolved(shopId, args.convoId, args.message, "fell_back", args.isTest);
        return { ok: true };
      }
      default:
        return { error: `Unknown tool ${call.name}.` };
    }
  }

  let reply = "";
  let failed = false;
  const startedAt = Date.now();
  const shopRow = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } }).catch(() => null);
  const guard = new LinkGuard(shopRow?.domain ? [shopRow.domain.toLowerCase()] : []);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Out of rounds or out of time: offer no tools, so this round answers.
      const lastRound = round === MAX_ROUNDS - 1 || Date.now() - startedAt > TURN_BUDGET_MS;
      let text = "";
      let calls: ToolCall[] = [];
      trace.countLlm("reply");
      for await (const event of getLlmProvider().agentStream(
        messages,
        lastRound ? [] : tools,
        { shopId, purpose: "reply" },
        { model: agentModel(), temperature: 0.3, maxTokens: 500 },
      )) {
        if (event.type === "text") {
          const safe = guard.push(event.text);
          if (!safe) continue;
          // A later round's text continues a sentence from an earlier one
          // ("Let me check that." → tool → "It is unisex."): keep them apart.
          if (!text && reply && !/\s$/.test(reply)) {
            text = " ";
            yield { type: "token", text: " " };
          }
          text += safe;
          yield { type: "token", text: safe };
        } else {
          calls = event.calls;
        }
      }
      const tail = guard.flush();
      if (tail) {
        text += tail;
        yield { type: "token", text: tail };
      }
      reply += text;
      if (calls.length === 0 || lastRound) break;

      messages.push({ role: "assistant", content: text || null, toolCalls: calls });
      // Bounded work per round on a public endpoint: every call still gets a
      // tool reply (the API requires one per call id), extras just do nothing.
      const results = await Promise.all(
        calls.map(async (call, index) => {
          if (index >= MAX_TOOL_CALLS_PER_ROUND) {
            return { call, result: { error: "Too many tool calls at once; use the results you already have." } };
          }
          const result = await runTool(call).catch((error) => {
            logError("agent_tool_error", error, { shopId, tool: call.name });
            return { error: "The tool failed; answer without it." };
          });
          trace.step("agent_tool", `Tool: ${call.name}`, "error" in (result as object) ? "miss" : "hit", {
            round: round + 1,
            arguments: call.arguments,
            result,
          });
          return { call, result };
        }),
      );
      for (const { call, result } of results) {
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
      // A declined request ends the turn: the store's message is the reply.
      if (declined) break;
    }
  } catch (error) {
    failed = true;
    logError("agent_error", error, { shopId });
    await args.track("llm_error", { layer: "agent" });
  }

  // A failed model call is an unanswered question: the fallback (whose default
  // offers the leave-message form) must come with the form and feed the
  // unresolved queue — and must not be lost behind a half-streamed sentence.
  if (failed && !declined) {
    cannotAnswer = true;
    await deps.recordUnresolved(shopId, args.convoId, args.message, "fell_back", args.isTest);
    if (reply.trim()) {
      yield { type: "message", text: args.fallback };
      reply = `${reply.trim()}\n${args.fallback}`;
    }
  }

  if (declined) {
    // Deterministic copy for refusals: the merchant's off-topic message (or the
    // translated built-in), never model wording — and no cards or buttons.
    const declineText =
      declined === "off_topic"
        ? config.persona?.offTopicMessage?.trim() || canned("offTopic", config.persona)
        : canned("blockedTopic", config.persona);
    if (reply.trim()) {
      yield { type: "message", text: declineText };
      reply = `${reply.trim()}\n${declineText}`;
    } else {
      reply = declineText;
      yield { type: "message", text: declineText };
    }
    const layer = declined === "off_topic" ? "off_topic" : "banned_agent";
    await deps.saveMessage(shopId, args.convoId, {
      role: "out",
      author: "ai",
      content: reply,
      sourceLayer: layer,
      intent: { agent: true, tools: toolsUsed },
    });
    trace.step("agent_decline", "Agent declined the request", "hit", { kind: declined, text: declineText });
    await args.track(declined === "off_topic" ? "turn_off_topic" : "turn_blocked", { layer: "agent" });
    await args.meterPromise;
    if (declined === "banned_topic") {
      // Repeated refusals count toward the cannot-answer handover, like the
      // deterministic banned-topic layers.
      const escalation = await deps.escalateCannotAnswer(shopId, args.convoId, config);
      for (const frame of escalation) yield frame;
      yield { type: "done", outcome: escalation.length > 0 ? "handover" : "blocked", conversationId: args.convoId };
      return;
    }
    yield { type: "done", outcome: "off_topic", conversationId: args.convoId };
    return;
  }

  if (!reply.trim()) {
    reply = args.fallback;
    if (!cannotAnswer) {
      cannotAnswer = true;
      await deps.recordUnresolved(shopId, args.convoId, args.message, "fell_back", args.isTest);
    }
    yield { type: "message", text: reply };
  }

  // A reply about a product the shopper has not seen yet ("do you have the
  // Aurora lamp?") comes with its card, so they can see and buy it — enforced
  // here rather than hoped for from the model. Products already on screen get
  // no repeat card (a follow-up like "is it waterproof?" stays text-only).
  if (cards.length === 0 && lookedUp.length > 0 && !cannotAnswer && config.settings.learn.products) {
    shownCache ??= await shownProducts(shopId, args.convoId).catch(() => []);
    const onScreen = new Set(shownCache.map((p) => p.shopifyProductId));
    const fresh = lookedUp.filter((gid) => !onScreen.has(gid)).slice(0, MAX_CARDS);
    if (fresh.length > 0) {
      const rows = await deps.cardsForShopifyIds(shopId, fresh, excludeOutOfStock);
      const byId = new Map(rows.map((r) => [r.shopifyProductId, r]));
      cards = fresh.map((gid) => byId.get(gid)).filter((c): c is ProductCard => Boolean(c));
    }
  }

  // Cross-sell companions belong under a fresh recommendation, not under an
  // answer about one product — there an extra card is "another product" the
  // shopper did not ask about.
  // …and they only fill free slots: the shopper sees at most MAX_CARDS cards in
  // total (4 picks + 2 companions made a 6-card reply).
  if (
    cards.length > 0 &&
    cards.length < MAX_CARDS &&
    toolsUsed.includes("search_products") &&
    config.settings.recommendationRules.crossSellEnabled
  ) {
    cards = (await deps.appendCrossSell(shopId, cards, excludeOutOfStock)).slice(0, MAX_CARDS);
  }
  if (cards.length > 0) yield { type: "cards", cards };
  if (actions.length > 0) yield { type: "actions", actions };

  // Saved under the existing reply kinds so analytics, the cannot-answer
  // escalation and the inbox keep reading agent turns without changes.
  const sourceLayer = cannotAnswer
    ? "rag_fallback"
    : cards.length > 0
      ? "buy"
      : toolsUsed.length > 0
        ? "question"
        : "chat";
  await deps.saveMessage(shopId, args.convoId, {
    role: "out",
    author: "ai",
    content: reply,
    sourceLayer,
    intent: { agent: true, tools: toolsUsed, facts: facts.slice(0, 6).map((f) => f.slice(0, 400)) },
    productCards: cards.length > 0 ? cards : undefined,
  });
  trace.step("agent_reply", "Agent reply", cannotAnswer ? "miss" : "info", {
    sourceLayer,
    tools: toolsUsed,
    cards: cards.map((c) => c.title),
    text: reply,
  });
  if (cards.length > 0) await args.track("recommendation_shown", { count: cards.length, agent: true });
  await args.track("turn_completed", { sourceLayer, agent: true });
  await args.meterPromise;

  if (cannotAnswer) {
    const escalation = await deps.escalateCannotAnswer(shopId, args.convoId, config);
    for (const frame of escalation) yield frame;
    if (escalation.length === 0) {
      const form = fallbackLeaveMessageForm(config.handover);
      if (form) {
        yield {
          type: "handover",
          data: { destination: config.handover.destination, messages: [], form, contactMethods: false, aiDormant: false },
        };
      }
    }
    yield { type: "done", outcome: escalation.length > 0 ? "handover" : "fell_back", conversationId: args.convoId };
    return;
  }
  yield { type: "done", outcome: sourceLayer, conversationId: args.convoId };
}
