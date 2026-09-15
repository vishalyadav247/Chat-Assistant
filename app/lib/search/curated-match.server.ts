import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// Curated-answer matcher (spec 09 / pipeline step 3). Published answers only;
// thresholds come from the shop's guardrails row — never hard-coded here.
//
// Two lanes:
//   1. Vector similarity against the answer's QUESTION (save.server.ts embeds
//      the question alone — see the note there about synonym dilution).
//   2. Exact synonym phrase match against the shopper's message. A synonym is
//      the merchant stating "this wording means this answer", so a hit is a
//      stronger signal than any similarity score and wins outright.

export interface CuratedMatch {
  id: string;
  question: string;
  talkingPoints: string;
  productIds: string[];
  priority: string;
  score: number;
  /** True when lane 2 matched — the merchant's own phrasing, not a similarity. */
  synonymHit?: boolean;
}

/** Shortest synonym allowed into the phrase lane. Below this, a "synonym" like
 *  "eta" or "cod" appears inside ordinary sentences and fires constantly. */
const MIN_SYNONYM_CHARS = 4;

/** Lowercase, strip punctuation, collapse runs, and pad with spaces so a LIKE
 *  with space-wrapped needles matches whole words instead of substrings. */
function normalizeForPhrase(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim()} `;
}

export async function curatedMatch(
  shopId: string,
  queryEmbedding: number[],
  /** Raw shopper message. Omit to run the vector lane only. */
  message?: string,
): Promise<CuratedMatch | null> {
  requireShopId(shopId);
  const phrase = message ? normalizeForPhrase(message) : "";

  // Lane 2 first — an exact synonym phrase is a merchant instruction and wins
  // outright, so it serves at full confidence rather than being sent round the
  // borderline-confirm branch. Matching runs in JS with the SAME unicode
  // normalization on BOTH sides (hardening spec 23 §2.4/§3.10): the old SQL
  // `[[:alnum:]]` class was locale-dependent and could disagree with the JS
  // side on accented text, and the query required `embedding IS NOT NULL` —
  // an embedding this lane never uses — so a freshly published answer whose
  // embed job was still pending was invisible to the merchant's own phrasing.
  // Both sides are space-padded and punctuation-stripped, so the needle checks
  // whole words: "sale" cannot fire on "wholesale", and "free shipping" still
  // matches "...free shipping?..." across punctuation.
  if (phrase.trim().length > 0) {
    const synRows = await db.curatedAnswer.findMany({
      where: { shopId, status: "published", NOT: { synonyms: { isEmpty: true } } },
      select: { id: true, question: true, talkingPoints: true, productIds: true, priority: true, synonyms: true },
    });
    const hit = synRows.find((row) =>
      row.synonyms.some((syn) => {
        if (syn.trim().length < MIN_SYNONYM_CHARS) return false;
        const needle = normalizeForPhrase(syn).trim();
        return needle.length > 0 && phrase.includes(` ${needle} `);
      }),
    );
    if (hit) {
      return {
        id: hit.id,
        question: hit.question,
        talkingPoints: hit.talkingPoints,
        productIds: hit.productIds,
        priority: hit.priority,
        score: 1,
        synonymHit: true,
      };
    }
  }

  // Lane 1: vector similarity against the answer's question (embedded rows
  // only — by definition of the lane).
  const vec = toSqlVector(queryEmbedding);
  const rows = await db.$queryRaw<Array<CuratedMatch>>(Prisma.sql`
    SELECT "id", "question", "talkingPoints", "productIds", "priority",
           (1 - ("embedding" <=> ${vec}::vector))::float8 AS score
    FROM "curated_answers"
    WHERE "shopId" = ${shopId}
      AND "status" = 'published'
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vec}::vector,
             CASE "priority" WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
    LIMIT 1
  `);

  const top = rows[0];
  if (!top) return null;
  return {
    id: top.id,
    question: top.question,
    talkingPoints: top.talkingPoints,
    productIds: top.productIds,
    priority: top.priority,
    score: Number(top.score),
    synonymHit: false,
  };
}
