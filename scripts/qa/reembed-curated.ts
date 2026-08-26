/**
 * Re-embed every curated answer from its QUESTION ALONE.
 *
 * Rows written before this change hold an embedding of "question + synonyms" as
 * one blob. That blob pulls the vector away from the question: measured, an
 * answer's own question scored 0.775 against it, under the 0.80 serve threshold,
 * so every synonym-bearing answer sat permanently in the 0.65–0.80 borderline
 * branch — an extra LLM confirm call on every matching turn, and sometimes a
 * refusal to serve at all.
 *
 * `saveCuratedAnswer` now embeds the question alone (and `curatedMatch` matches
 * synonyms as exact phrases instead), but existing rows keep the old vector
 * until they are re-embedded. This does that, once, for every shop.
 *
 * Run:  PRISMA_CLIENT_ENGINE_TYPE=binary npx tsx scripts/qa/reembed-curated.ts [--dry]
 *
 * Requires OPENAI_API_KEY — an answer re-embedded without one would get a
 * pseudo-embedding and silently stop matching, so a missing key is fatal here.
 */
import "dotenv/config";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const db = (await import("../../app/db.server")).default;
  const { embedText, toSqlVector } = await import("../../app/lib/embeddings/embedding.server");
  const { Prisma } = await import("@prisma/client");

  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set. Refusing to run: pseudo-embeddings would leave every\n" +
          "curated answer unmatchable at runtime, which is worse than the bug being fixed.",
      );
      process.exitCode = 1;
      return;
    }

    const rows = await db.curatedAnswer.findMany({
      select: { id: true, shopId: true, question: true, synonyms: true },
      orderBy: { createdAt: "asc" },
    });
    console.log(`${rows.length} curated answer(s) across all shops`);
    const withSynonyms = rows.filter((r) => r.synonyms.length > 0).length;
    console.log(`${withSynonyms} carry synonyms and are the ones actually affected`);
    if (dry) {
      console.log("--dry: nothing written");
      return;
    }

    let done = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const vec = await embedText(row.question, { shopId: row.shopId });
        await db.$executeRaw(Prisma.sql`
          UPDATE "curated_answers" SET "embedding" = ${toSqlVector(vec)}::vector
          WHERE "id" = ${row.id} AND "shopId" = ${row.shopId}
        `);
        done++;
      } catch (error) {
        failed++;
        console.error(`  FAILED ${row.id}: ${String(error)}`);
      }
      if ((done + failed) % 25 === 0) console.log(`  …${done + failed}/${rows.length}`);
    }
    console.log(`re-embedded ${done}, failed ${failed}`);
    if (failed) process.exitCode = 1;
  } finally {
    // The db.server singleton keeps the process alive forever without this.
    await (await import("../../app/db.server")).default.$disconnect();
  }
}

void main();
