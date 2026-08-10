import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// RAG retrieval over merchant knowledge (spec 03 lane B / spec 04 rows).

export interface KnowledgeHit {
  id: string;
  topic: string;
  body: string;
  score: number;
}

export async function knowledgeSearch(
  shopId: string,
  queryEmbedding: number[],
  k = 3,
): Promise<KnowledgeHit[]> {
  requireShopId(shopId);
  const vec = toSqlVector(queryEmbedding);
  const rows = await db.$queryRaw<KnowledgeHit[]>(Prisma.sql`
    SELECT k."id", k."topic", k."body",
           (1 - (k."embedding" <=> ${vec}::vector))::float8 AS score
    FROM "knowledge" k
    LEFT JOIN "data_sources" ds ON ds."id" = k."dataSourceId" AND ds."shopId" = k."shopId"
    WHERE k."shopId" = ${shopId}
      AND k."embedding" IS NOT NULL
      AND (k."dataSourceId" IS NULL OR ds."status" = 'active')
    ORDER BY k."embedding" <=> ${vec}::vector
    LIMIT ${k}
  `);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}
