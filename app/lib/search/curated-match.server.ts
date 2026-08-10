import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// Curated-answer matcher (spec 09 / pipeline step 3). Published answers only;
// thresholds come from the shop's guardrails row — never hard-coded here.

export interface CuratedMatch {
  id: string;
  question: string;
  talkingPoints: string;
  productIds: string[];
  priority: string;
  score: number;
}

export async function curatedMatch(
  shopId: string,
  queryEmbedding: number[],
): Promise<CuratedMatch | null> {
  requireShopId(shopId);
  const vec = toSqlVector(queryEmbedding);
  const rows = await db.$queryRaw<CuratedMatch[]>(Prisma.sql`
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
  return top ? { ...top, score: Number(top.score) } : null;
}
