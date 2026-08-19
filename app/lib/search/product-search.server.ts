import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// Hybrid product search — the accuracy core (spec 03 / PRODUCTION-BUILD-SPEC §8).
// Keyword (weighted tsvector: title A, type/vendor/tags B, description C) and
// vector (pgvector cosine) run in parallel and are fused by reciprocal rank;
// hard filters (shop, learn, stock, price) always in SQL WHERE.
//
// Keyword semantics match the validated demo: ANY router keyword qualifies a
// product (OR, stemmed) — the earlier AND query silently dropped most
// description-level matches. The shopper's own words form a second, lower
// tier so attributes the router paraphrased away ("rfid", "touchscreen") still
// reach the candidate list. `ts_headline` returns the matching fragment of a
// long description so the LLM sees WHY a product matched (index.server.ts).

export interface ProductVariantInfo {
  id: string; // gid://shopify/ProductVariant/...
  title: string;
  price: number;
  available: boolean;
}

export interface ProductCandidate {
  id: string;
  shopifyProductId: string;
  title: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  handle: string;
  variants: ProductVariantInfo[] | null;
  productType: string;
  tags: string[];
  description: string;
  /** Rendered ENABLED product/variant metafields ("Name: value" lines, spec 07 Manage metafields). */
  metafieldText: string;
  score: number | null; // vector similarity (null for keyword-only hits)
  /** Matching description fragment(s) from the keyword lane; null for vector-only rows. */
  headline: string | null;
  /** Shopper/router words this product's text actually contains (keyword lane). */
  matchedTerms: string[];
  /** Weighted count of distinct query words matched (router ×2, shopper ×1); 0 for vector-only rows. */
  coverage: number;
  /** Reciprocal-rank-fusion score — candidates are returned sorted by it. */
  fused: number;
}

export interface ProductSearchArgs {
  shopId: string;
  queryEmbedding: number[];
  keywords: string[];
  /** Raw shopper message — its significant words form the lower keyword tier. */
  message?: string;
  priceMax?: number | null;
  minMeaningScore: number; // guardrails.minMeaningScore
  limit?: number;
  /** Rules card (spec 08): when false, unavailable products may be recommended. */
  excludeOutOfStock?: boolean;
}

// Purchasable = tracked stock on hand OR any variant availableForSale (covers
// untracked inventory and "continue selling when out of stock").
const PURCHASABLE = Prisma.sql`("stock" > 0 OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(COALESCE("variants", '[]'::jsonb)) AS v
  WHERE (v->>'available')::boolean
))`;

function stockCondition(excludeOutOfStock: boolean): Prisma.Sql {
  return excludeOutOfStock ? PURCHASABLE : Prisma.sql`TRUE`;
}

const BASE_COLUMNS = Prisma.sql`"id", "shopifyProductId", "title", "price"::float8 AS price, "stock",
           "imageUrl", "handle", "variants", "productType", "tags", "description", "metafieldText"`;

const RRF_K = 60;
/** Message-word-only keyword hits count half as much as router-keyword hits. */
const MESSAGE_TIER_WEIGHT = 0.5;

export async function hybridProductSearch(args: ProductSearchArgs): Promise<ProductCandidate[]> {
  const shopId = requireShopId(args.shopId);
  const limit = args.limit ?? 8;
  const priceMax = args.priceMax ?? null;
  const excludeOutOfStock = args.excludeOutOfStock ?? true;

  const [keywordRows, vectorRows] = await Promise.all([
    keywordSearch(shopId, args.keywords, args.message ?? "", priceMax, limit, excludeOutOfStock),
    vectorSearch(shopId, args.queryEmbedding, priceMax, limit, excludeOutOfStock),
  ]);

  // Coverage first (a product containing MORE of the shopper's distinct words
  // — "birthstone" + "bracelet" + "february" — beats one matching fewer, no
  // matter how it scores elsewhere), then reciprocal rank fusion as the
  // tiebreak: products found by both lanes rise within a coverage tier;
  // vector-only rows (coverage 0) still need the meaning gate. This mirrors
  // the validated demo (keyword hits first, vector fills in) with a sharper
  // order inside the keyword tier.
  // A message-only hit on a SINGLE shopper word ("hand" in "hand-poured") is
  // too weak to outrank strong vector matches — it keeps its RRF share but no
  // coverage tier. Router-keyword hits and multi-word message hits do.
  const merged = new Map<string, ProductCandidate>();
  keywordRows.forEach((row, rank) => {
    const weight = row.kwHit ? 1 : MESSAGE_TIER_WEIGHT;
    const candidate = toCandidate(row);
    if (!row.kwHit && candidate.coverage < 2) candidate.coverage = 0;
    merged.set(row.id, { ...candidate, fused: weight / (RRF_K + rank) });
  });
  vectorRows.forEach((row, rank) => {
    const contribution = 1 / (RRF_K + rank);
    const existing = merged.get(row.id);
    if (existing) {
      existing.score = row.score;
      existing.fused += contribution;
      return;
    }
    if ((row.score ?? 0) < args.minMeaningScore) return;
    merged.set(row.id, { ...toCandidate(row), fused: contribution });
  });
  return [...merged.values()]
    .sort((a, b) => b.coverage - a.coverage || b.fused - a.fused)
    .slice(0, limit);
}

/** Fallback when nothing matched but a budget exists: cheapest in-stock, in-budget items. */
export async function browseCheapestInBudget(
  shopId: string,
  priceMax: number,
  limit = 4,
  excludeOutOfStock = true,
): Promise<ProductCandidate[]> {
  requireShopId(shopId);
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${BASE_COLUMNS}, NULL::float8 AS score, NULL::text AS headline, FALSE AS "kwHit",
           NULL::text[] AS matched, 0::int AS coverage
    FROM "products"
    WHERE "shopId" = ${shopId}
      AND "learnEnabled" = true AND "status" = 'active'
      AND ${stockCondition(excludeOutOfStock)} AND "price" <= ${priceMax}
    ORDER BY "price" ASC
    LIMIT ${limit}
  `);
  return rows.map((row, i) => ({ ...toCandidate(row), fused: 1 / (RRF_K + i) }));
}

interface RawRow {
  id: string;
  shopifyProductId: string;
  title: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  handle: string;
  variants: ProductVariantInfo[] | null;
  productType: string | null;
  tags: string[] | null;
  description: string | null;
  metafieldText: string | null;
  score: number | null;
  headline: string | null;
  kwHit: boolean | null;
  matched: string[] | null;
  coverage: number | null;
}

// Chat filler that carries no product meaning (Postgres' english config already
// drops classic stop-words; these are the extras a shopper types).
const FILLER = new Set([
  "something", "anything", "someone", "looking", "look", "show", "need", "want", "like",
  "please", "recommend", "recommendation", "suggest", "suggestion", "have", "there", "what",
  "which", "would", "could", "should", "thanks", "thank", "hello", "some", "that", "this",
  "with", "from", "under", "over", "about", "around", "cheap", "cheapest", "budget", "dollar",
  "dollars", "price", "priced", "buy", "get", "find", "give", "best", "good", "great", "nice",
  "help", "any", "kind", "sort", "thing", "things", "item", "items", "product", "products",
  "store", "shop", "sell", "selling", "available", "can", "use", "for", "and", "the",
  "you", "your", "yours", "me", "my", "mine", "our", "ours", "we", "they", "them", "their",
  "his", "her", "hers", "its", "him", "she", "who", "how", "why", "when", "where", "does",
  "did", "will", "just", "also", "very", "much", "many", "more", "most", "than", "then",
]);

function messageTerms(message: string, exclude: Set<string>, priceMax: number | null): string[] {
  const out: string[] = [];
  const priceToken = priceMax !== null ? String(Math.round(priceMax)) : "";
  for (const word of message.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length === 0 || FILLER.has(word) || exclude.has(word)) continue;
    // Numbers matter ("ruling number 8", "size 7", "750ml") — keep 1–4 digit
    // tokens except the budget the router already extracted ("under 30").
    if (/^\d+$/.test(word)) {
      if (word.length > 4 || word === priceToken) continue;
    } else if (word.length <= 2) {
      continue;
    }
    if (!out.includes(word)) out.push(word);
  }
  return out.slice(0, 10);
}

// ── Typo tolerance ──────────────────────────────────────────────────────────
// Shoppers misspell ("rulling", "sugget"). A message word whose stem doesn't
// exist anywhere in this shop's catalog is snapped to the closest catalog
// lexeme by trigram similarity (≥ 0.5) — pure JS over a per-shop lexicon from
// ts_stat, cached 10 min. No extension, no LLM call.

declare global {
  // eslint-disable-next-line no-var
  var lexiconCache: Map<string, { at: number; words: Set<string>; list: string[] }> | undefined;
}
const LEXICON_TTL_MS = 10 * 60 * 1000;

async function shopLexicon(shopId: string): Promise<{ words: Set<string>; list: string[] }> {
  if (!global.lexiconCache) global.lexiconCache = new Map();
  const hit = global.lexiconCache.get(shopId);
  if (hit && Date.now() - hit.at < LEXICON_TTL_MS) return hit;
  // Raw (unstemmed) distinct words from title / type / vendor / tags /
  // description / enabled metafields — misspellings are compared against real spellings, and the
  // stem check below uses the same set. Cached per shop.
  const rows = await db.$queryRaw<{ word: string }[]>(Prisma.sql`
    SELECT DISTINCT w AS word
    FROM "products" p,
         regexp_split_to_table(
           lower(coalesce(p."title", '') || ' ' || coalesce(p."productType", '') || ' ' ||
                 coalesce(p."vendor", '') || ' ' || array_to_string(p."tags", ' ') || ' ' ||
                 coalesce(p."description", '') || ' ' || coalesce(p."metafieldText", '')),
           '[^a-z0-9]+') AS w
    WHERE p."shopId" = ${shopId} AND p."learnEnabled" = true AND length(w) >= 3`);
  const list = rows.map((r) => r.word);
  const entry = { at: Date.now(), words: new Set(list), list };
  global.lexiconCache.set(shopId, entry);
  if (global.lexiconCache.size > 500) global.lexiconCache.clear();
  return entry;
}

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Replace misspelled shopper words with the closest catalog lexeme. Words that
 * already stem to something in the catalog (or are numbers / short) are kept.
 */
async function correctTerms(shopId: string, terms: string[]): Promise<string[]> {
  const candidates = terms.filter((t) => t.length >= 4 && !/^\d+$/.test(t));
  if (candidates.length === 0) return terms;
  const lexicon = await shopLexicon(shopId);
  const fixes = new Map<string, string>();
  for (const term of candidates) {
    if (lexicon.words.has(term)) continue; // spelled like something in the catalog
    // Plural/inflection guard: "bracelets" vs "bracelet" — same stem, no fix.
    if (lexicon.words.has(term.replace(/s$/, "")) || lexicon.words.has(term + "s")) continue;
    let best = "";
    let bestScore = 0.5;
    for (const word of lexicon.list) {
      if (Math.abs(word.length - term.length) > 2) continue;
      const score = trigramSimilarity(term, word);
      if (score > bestScore) {
        bestScore = score;
        best = word;
      }
    }
    if (best) fixes.set(term, best);
  }
  if (fixes.size === 0) return terms;
  return terms.map((t) => fixes.get(t) ?? t);
}

/** OR of one plainto_tsquery per term (stemmed). Empty terms → null. */
function orQuery(terms: string[]): Prisma.Sql | null {
  const clean = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  if (clean.length === 0) return null;
  return Prisma.sql`(${Prisma.join(
    clean.map((t) => Prisma.sql`plainto_tsquery('english', ${t})`),
    " || ",
  )})`;
}

async function keywordSearch(
  shopId: string,
  keywords: string[],
  message: string,
  priceMax: number | null,
  limit: number,
  excludeOutOfStock: boolean,
): Promise<RawRow[]> {
  const routerTerms = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0);
  const msgTerms = await correctTerms(
    shopId,
    messageTerms(message, new Set(routerTerms), priceMax),
  ).catch((error) => {
    console.error("term_correction_error", error);
    return messageTerms(message, new Set(routerTerms), priceMax);
  });
  // Adjacent shopper words ("ruling number", "number 8") as phrases: a product
  // where the words sit TOGETHER outranks ones that merely contain both
  // somewhere ("8 mm beads" + "number of…"). Weight 2, like router terms.
  const phraseTerms: string[] = [];
  for (let i = 0; i < msgTerms.length - 1; i++) phraseTerms.push(`${msgTerms[i]} ${msgTerms[i + 1]}`);
  const kwQuery = orQuery(routerTerms);
  const msgQuery = orQuery(msgTerms);
  if (!kwQuery && !msgQuery) return [];

  const anyQuery =
    kwQuery && msgQuery ? Prisma.sql`(${kwQuery} || ${msgQuery})` : (kwQuery ?? msgQuery!);
  const kwHit = kwQuery ? Prisma.sql`("searchText" @@ ${kwQuery})` : Prisma.sql`FALSE`;
  const kwRank = kwQuery ? Prisma.sql`ts_rank_cd("searchText", ${kwQuery})` : Prisma.sql`0::float4`;
  const msgRank = msgQuery ? Prisma.sql`ts_rank_cd("searchText", ${msgQuery})` : Prisma.sql`0::float4`;

  // Coverage: how many DISTINCT shopper/router words this product's text
  // contains. A product that matches "birthstone" + "bracelet" + "february"
  // must beat the 40 bracelets that only match the first two — ts_rank alone
  // (frequency × field weight) buries description-level attributes. Router
  // words count double so they still lead among equal coverage.
  const allTerms = [
    ...routerTerms.map((t) => ({ t, w: 2, phrase: false })),
    ...msgTerms.map((t) => ({ t, w: 1, phrase: false })),
    ...phraseTerms.map((t) => ({ t, w: 2, phrase: true })),
  ];
  const tsq = (term: { t: string; phrase: boolean }) =>
    term.phrase
      ? Prisma.sql`phraseto_tsquery('english', ${term.t})`
      : Prisma.sql`plainto_tsquery('english', ${term.t})`;

  // Phrases are built from adjacent shopper words after filler removal, so
  // adjacency can be accidental ("sign is Cancer" → "sign cancer"). A phrase
  // only counts toward coverage when it narrows the catalog beyond its own
  // rarest word: that word must match ≥ 4 products and the pair at most half
  // of them — "number 8" (number/8 in dozens, the pair in two) yes; "sign
  // cancer" ("cancer" alone already narrows to two) no. One cheap
  // document-frequency scan per turn.
  if (phraseTerms.length > 0) {
    const dfExprs = allTerms.map(
      (term, i) => Prisma.sql`count(*) FILTER (WHERE "searchText" @@ ${tsq(term)})::int AS d${Prisma.raw(String(i))}`,
    );
    const dfRow = (
      await db.$queryRaw<Record<string, number>[]>(Prisma.sql`
        SELECT count(*)::int AS n, ${Prisma.join(dfExprs, ", ")}
        FROM "products"
        WHERE "shopId" = ${shopId} AND "learnEnabled" = true AND "status" = 'active'`)
    )[0];
    const n = Number(dfRow?.n ?? 0);
    if (n > 0) {
      const dfOf = (t: string) => {
        const idx = allTerms.findIndex((x) => x.t === t && !x.phrase);
        return idx >= 0 ? Number(dfRow[`d${idx}`] ?? 0) : 0;
      };
      allTerms.forEach((term, i) => {
        if (!term.phrase) return;
        const df = Number(dfRow[`d${i}`] ?? 0);
        const [a, b] = term.t.split(" ");
        const minWordDf = Math.min(dfOf(a), dfOf(b));
        const informative = df > 0 && minWordDf >= 4 && df * 2 <= minWordDf;
        term.w = informative ? 2 : 0;
      });
    }
  }
  const hitExprs = allTerms.map(
    (term) => Prisma.sql`("searchText" @@ ${tsq(term)})::int * ${term.w}`,
  );
  const coverage = hitExprs.length > 0 ? Prisma.join(hitExprs, " + ") : Prisma.sql`0`;
  const matchedExprs = allTerms.map(
    (term) => Prisma.sql`CASE WHEN "searchText" @@ ${tsq(term)} THEN ${term.t} END`,
  );
  const matched =
    matchedExprs.length > 0
      ? Prisma.sql`array_remove(ARRAY[${Prisma.join(matchedExprs, ", ")}]::text[], NULL)`
      : Prisma.sql`ARRAY[]::text[]`;

  // Order: coverage first, then router-keyword hit, then weighted ts_rank_cd
  // (title > type/tags > description). Headline is computed only for the
  // LIMITed rows (outer query), never the whole catalog — over the description
  // AND the enabled metafield text, so a metafield-only match still shows the
  // model the fragment that matched.
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT p.*,
           ts_headline('english', coalesce(p."description", '') || ' ' || coalesce(p."metafieldText", ''), ${msgQuery ?? kwQuery!},
             'MaxFragments=2, MaxWords=35, MinWords=12, FragmentDelimiter=" … "') AS headline
    FROM (
      SELECT ${BASE_COLUMNS}, NULL::float8 AS score, ${kwHit} AS "kwHit",
             (${coverage}) AS coverage, ${kwRank} AS kw_rank, ${msgRank} AS msg_rank,
             ${matched} AS matched
      FROM "products"
      WHERE "shopId" = ${shopId}
        AND "learnEnabled" = true AND "status" = 'active'
        AND ${stockCondition(excludeOutOfStock)}
        AND (${priceMax}::float8 IS NULL OR "price" <= ${priceMax}::float8)
        AND "searchText" @@ ${anyQuery}
      ORDER BY coverage DESC, "kwHit" DESC, kw_rank DESC, msg_rank DESC, "title" ASC
      LIMIT ${limit}
    ) p
    ORDER BY p.coverage DESC, p."kwHit" DESC, p.kw_rank DESC, p.msg_rank DESC, p."title" ASC
  `);
  return rows;
}

async function vectorSearch(
  shopId: string,
  queryEmbedding: number[],
  priceMax: number | null,
  limit: number,
  excludeOutOfStock: boolean,
): Promise<RawRow[]> {
  const vec = toSqlVector(queryEmbedding);
  return db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${BASE_COLUMNS},
           (1 - ("embedding" <=> ${vec}::vector))::float8 AS score,
           NULL::text AS headline, FALSE AS "kwHit", NULL::text[] AS matched, 0::int AS coverage
    FROM "products"
    WHERE "shopId" = ${shopId}
      AND "learnEnabled" = true AND "status" = 'active'
      AND ${stockCondition(excludeOutOfStock)}
      AND (${priceMax}::float8 IS NULL OR "price" <= ${priceMax}::float8)
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vec}::vector
    LIMIT ${limit}
  `);
}

function toCandidate(row: RawRow): ProductCandidate {
  return {
    id: row.id,
    shopifyProductId: row.shopifyProductId,
    title: row.title,
    price: Number(row.price),
    stock: row.stock,
    imageUrl: row.imageUrl,
    handle: row.handle,
    variants: row.variants,
    productType: row.productType ?? "",
    tags: row.tags ?? [],
    description: row.description ?? "",
    metafieldText: row.metafieldText ?? "",
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    headline: cleanHeadline(row.headline),
    matchedTerms: row.matched ?? [],
    coverage: Number(row.coverage ?? 0),
    fused: 0,
  };
}

/** ts_headline marks matches with <b>…</b>; the model gets plain text. */
function cleanHeadline(headline: string | null | undefined): string | null {
  if (!headline) return null;
  const text = headline.replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/**
 * Relevance cut (user decision 2026-08-17: "don't show 4 items just to fill
 * the count"). Candidates arrive sorted (coverage, then fused). Keep only the
 * top relevance tier:
 *  - keyword tier present (top coverage > 0): every candidate with that same
 *    coverage — one black bracelet or four, whatever actually matched all the
 *    shopper's words; lower-coverage rows are dropped;
 *  - vector-only results: rows within 0.04 cosine of the best score (flat
 *    scores → several; one clear winner → one);
 *  - browse / hand-picked pools (no scores): unchanged.
 * Always at least one, at most `max`.
 */
export function selectRelevant(candidates: ProductCandidate[], max = 4): ProductCandidate[] {
  if (candidates.length === 0) return [];
  const top = candidates[0];
  let kept: ProductCandidate[];
  if (top.coverage > 0) {
    kept = candidates.filter((c) => c.coverage === top.coverage);
  } else if (top.score !== null) {
    const floor = top.score - 0.04;
    kept = candidates.filter((c) => c.score !== null && c.score >= floor);
  } else {
    kept = candidates;
  }
  if (kept.length === 0) kept = [top];
  return kept.slice(0, max);
}

/**
 * Short, relevant excerpt handed to the LLM per candidate: type · tags · the
 * matching description/metafield fragment (or the description's start for
 * vector-only rows) · the enabled metafields (bounded). Long descriptions
 * stay full-length in the index; only the payload is bounded.
 */
export function candidateSnippet(candidate: ProductCandidate): string {
  const parts: string[] = [];
  if (candidate.productType) parts.push(candidate.productType);
  if (candidate.tags.length > 0) parts.push(candidate.tags.slice(0, 5).join(", "));
  const body = candidate.headline ?? candidate.description.replace(/\s+/g, " ").trim().slice(0, 220);
  if (body) parts.push(body);
  // Merchant-enabled metafields (materials, care, dimensions…) are the facts
  // shoppers ask about most — always present when set, bounded like the body.
  const meta = candidate.metafieldText.replace(/\s+/g, " ").trim();
  if (meta) parts.push(meta.length > 300 ? `${meta.slice(0, 300)}…` : meta);
  // Tell the model WHICH of the shopper's words this product matched — the
  // deciding detail is often deep in a long description ("Birthstone for
  // Month: February") and may not survive the headline cut.
  if (candidate.matchedTerms.length > 0) parts.push(`matches: ${candidate.matchedTerms.join(", ")}`);
  return parts.join(" · ");
}
