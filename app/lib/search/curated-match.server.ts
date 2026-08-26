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
  const vec = toSqlVector(queryEmbedding);
  const phrase = message ? normalizeForPhrase(message) : "";

  const rows = await db.$queryRaw<Array<CuratedMatch & { synonym_hit: boolean }>>(Prisma.sql`
    SELECT "id", "question", "talkingPoints", "productIds", "priority",
           (1 - ("embedding" <=> ${vec}::vector))::float8 AS score,
           (
             ${phrase} <> ''
             AND EXISTS (
               SELECT 1 FROM unnest("synonyms") AS syn
               WHERE length(trim(syn)) >= ${MIN_SYNONYM_CHARS}
                 -- Both sides are space-padded and punctuation-stripped, so the
                 -- wildcards match on word boundaries: "sale" cannot fire on
                 -- "wholesale", and "free shipping" still matches "...free
                 -- shipping?..." across punctuation.
                 AND ${phrase} LIKE
                     '% ' || trim(regexp_replace(lower(syn), '[^[:alnum:]]+', ' ', 'g')) || ' %'
             )
           ) AS synonym_hit
    FROM "curated_answers"
    WHERE "shopId" = ${shopId}
      AND "status" = 'published'
      AND "embedding" IS NOT NULL
    ORDER BY synonym_hit DESC,
             "embedding" <=> ${vec}::vector,
             CASE "priority" WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
    LIMIT 1
  `);

  const top = rows[0];
  if (!top) return null;
  const vectorScore = Number(top.score);
  return {
    id: top.id,
    question: top.question,
    talkingPoints: top.talkingPoints,
    productIds: top.productIds,
    priority: top.priority,
    // An explicit synonym match is a merchant instruction, so it serves at full
    // confidence rather than being sent round the borderline-confirm branch.
    score: top.synonym_hit ? 1 : vectorScore,
    synonymHit: top.synonym_hit,
  };
}
