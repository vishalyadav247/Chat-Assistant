import { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../../db.server";
import { embedText, toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";
import { getQuota } from "../billing/plans.server";
import { recordEvent } from "../analytics/events.server";
import { logError } from "../log.server";

// Curated answers CRUD (spec 09). Rows are created/updated via the Prisma
// client; the embedding column is Unsupported("vector") and is written ONLY
// via raw SQL (seed.ts pattern). If embedding fails (no key / timeout) the row
// still saves with embedding NULL — published answers without an embedding
// simply never match (curated-match filters `embedding IS NOT NULL`); the UI
// shows them as "pending index".

// The client draft sends "" for absent optional ids — treat empty as undefined
// (z.optional() alone rejects "" with a confusing "too small" error).
const optionalId = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  z.string().min(1).max(128).optional(),
);

export const curatedAnswerInput = z.object({
  id: optionalId,
  question: z.string().trim().min(1, "Question is required").max(500),
  synonyms: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  // Values come from products.shopifyProductId (gids from catalog sync; the
  // seed uses opaque demo ids) — treat as opaque, only bound the size.
  productIds: z.array(z.string().min(1).max(128)).max(20).default([]),
  talkingPoints: z.string().max(4000).default(""),
  status: z.enum(["draft", "published"]).default("draft"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  /** When the form was prefilled from the suggestions sidebar (07 unresolved queue). */
  sourceUnresolvedId: optionalId,
});

export type CuratedAnswerInput = z.infer<typeof curatedAnswerInput>;

export type SaveCuratedResult =
  | { ok: true; id: string; warning?: "embedding_failed" }
  | { ok: false; error: string; code?: "cap" | "invalid" | "not_found" };

/** Talking points are plain text, one per line — strip any HTML per line.
 *  Script/style bodies are dropped before tag stripping, which otherwise kept
 *  their inner text (QA D12h). */
function sanitizeTalkingPoints(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

function dedupeSynonyms(synonyms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of synonyms) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export async function saveCuratedAnswer(
  shopId: string,
  raw: unknown,
): Promise<SaveCuratedResult> {
  requireShopId(shopId);
  const parsed = curatedAnswerInput.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? "Invalid input", code: "invalid" };
  }
  const input = parsed.data;
  const data = {
    question: input.question,
    synonyms: dedupeSynonyms(input.synonyms),
    productIds: [...new Set(input.productIds)],
    talkingPoints: sanitizeTalkingPoints(input.talkingPoints),
    status: input.status,
    priority: input.priority,
  };

  let id: string;
  if (input.id) {
    const existing = await db.curatedAnswer.findFirst({
      where: { id: input.id, shopId },
      select: { id: true },
    });
    if (!existing) return { ok: false, error: "Curated answer not found", code: "not_found" };
    await db.curatedAnswer.update({ where: { id: existing.id }, data });
    id = existing.id;
  } else {
    // Plan cap seam (spec 09/15). getQuota returns unlimited while enforcement
    // mode is "open"; flipping plans.server.ts to "enforced" activates this gate.
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    const quota = getQuota(shop?.plan ?? "free", "curated_answers");
    const count = await db.curatedAnswer.count({ where: { shopId } });
    if (count >= quota) {
      return {
        ok: false,
        error:
          "You've reached your plan's curated answer limit. Upgrade your plan to add more.",
        code: "cap",
      };
    }
    const created = await db.curatedAnswer.create({ data: { shopId, ...data } });
    id = created.id;
  }

  // Mark the source unresolved question handled (suggestions sidebar → Use → save).
  if (input.sourceUnresolvedId) {
    await db.unresolvedQuestion.updateMany({
      where: { id: input.sourceUnresolvedId, shopId },
      data: { status: "handled" },
    });
  }

  // Embed question + synonyms; write via raw SQL, always shop-scoped.
  let warning: "embedding_failed" | undefined;
  try {
    const vec = await embedText(`${data.question} ${data.synonyms.join(" ")}`.trim(), { shopId });
    await db.$executeRaw(Prisma.sql`
      UPDATE "curated_answers" SET "embedding" = ${toSqlVector(vec)}::vector
      WHERE "id" = ${id} AND "shopId" = ${shopId}
    `);
  } catch (error) {
    logError("curated_embedding_error", error, { shopId });
    // Question/synonyms may have changed — a stale vector would mismatch, so null it.
    await db.$executeRaw(Prisma.sql`
      UPDATE "curated_answers" SET "embedding" = NULL
      WHERE "id" = ${id} AND "shopId" = ${shopId}
    `);
    warning = "embedding_failed";
  }

  await recordEvent(shopId, "curated_answer_saved", {
    curatedId: id,
    status: data.status,
    embedded: !warning,
  });
  return warning ? { ok: true, id, warning } : { ok: true, id };
}

export async function deleteCuratedAnswer(shopId: string, id: string): Promise<boolean> {
  requireShopId(shopId);
  if (!id) return false;
  const result = await db.curatedAnswer.deleteMany({ where: { id, shopId } });
  return result.count > 0;
}

/** Ids of answers whose embedding is NULL ("pending index" pill in the UI). */
export async function pendingEmbeddingIds(shopId: string): Promise<string[]> {
  requireShopId(shopId);
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "curated_answers"
    WHERE "shopId" = ${shopId} AND "embedding" IS NULL
  `);
  return rows.map((r) => r.id);
}
