import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// RAG retrieval over merchant knowledge (spec 03 lane B / spec 04 rows).
//
// Source filter (hardening spec 23 §1.2): only an explicit `inactive` (the
// merchant's off switch) excludes a source. `pending` and `error` sources keep
// serving their LAST GOOD chunks — a mid-rebuild or transiently failing source
// must degrade to stale answers, never to "the agent suddenly knows nothing".
// Chunks for a failed rebuild survive because ingestSource swaps atomically.

export interface KnowledgeHit {
  id: string;
  topic: string;
  body: string;
  score: number;
}

/** Extra rows fetched beyond k so near-duplicates can be skipped without
 *  coming home short (spec 23 §3.7). */
const DEDUP_OVERFETCH = 5;

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
      AND (k."dataSourceId" IS NULL OR ds."status" <> 'inactive')
    ORDER BY k."embedding" <=> ${vec}::vector
    LIMIT ${k + DEDUP_OVERFETCH}
  `);
  // Near-duplicate suppression (spec 23 §3.7): the FAQ bridge, a crawled FAQ
  // page and a synced store page can all hold the SAME answer, and with only k
  // slots the copies crowd out real context — worse, when the merchant updates
  // one copy, the stale twins outvote it. Copies are near-verbatim, so cheap
  // token-set overlap catches them without shipping vectors to JS; the
  // highest-scoring copy (which is also the first seen) wins the slot.
  const out: KnowledgeHit[] = [];
  for (const row of rows) {
    if (out.length >= k) break;
    if (!out.some((kept) => nearDuplicate(kept.body, row.body))) {
      out.push({ ...row, score: Number(row.score) });
    }
  }
  return out;
}

function nearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  const tokens = (text: string) =>
    new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size < 5 || tb.size < 5) return a.trim() === b.trim();
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.85;
}
