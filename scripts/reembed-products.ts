/* Re-embed every stored vector that no longer matches the current embedding
 * formula OR the current embedding MODEL.
 *
 *   npx tsx scripts/reembed-products.ts                  # all shops, stale rows only
 *   npx tsx scripts/reembed-products.ts my.myshopify.com # one shop
 *   npx tsx scripts/reembed-products.ts --dry-run        # report, change nothing
 *   npx tsx scripts/reembed-products.ts --force          # rebuild every vector
 *
 * Covers ALL FOUR vector columns — products, knowledge, curated_answers,
 * recommendations — not just products. Uses the rows already in the DB (no
 * Shopify call), so it works without a live app session. Needs OPENAI_API_KEY.
 * Run from PowerShell on Windows (binary engine).
 *
 * ── Why the model matters (QA fix 2026-08-21) ──────────────────────────────
 * `products.contentHash` is a hash of the product's TEXT only. Switching
 * EMBEDDING_MODEL therefore changed nothing about any hash, this script
 * reported "0 to re-embed", and every stored vector silently stayed in the OLD
 * model's coordinate space while queries were embedded in the new one — the
 * writes still succeed (dimensions match), so nothing fails; retrieval just
 * quietly gets worse. The other three columns had no re-embed path at all.
 *
 * The fix is a marker row in app_secrets (`platform:embedding-model`) that
 * records which model built the vectors on disk. A mismatch against env
 * EMBEDDING_MODEL means EVERYTHING is stale, regardless of hashes.
 *
 * ── Switching to a DIFFERENT-DIMENSION model ───────────────────────────────
 * This script CANNOT migrate you to e.g. text-embedding-3-large (3072 dims).
 * The four vector columns are declared `vector(1536)` in prisma/schema.prisma
 * and the HNSW/IVFFlat indexes are built for that width, so a wider vector is
 * rejected by Postgres (and by toSqlVector() before it ever gets there). That
 * migration is:
 *   1. `npm run migrate:new` — ALTER each of products / knowledge /
 *      curated_answers / recommendations to `vector(<new dims>)`, dropping and
 *      recreating each vector index in the same migration file.
 *   2. Update EMBEDDING_DIMENSIONS in app/lib/embeddings/embedding.server.ts.
 *   3. Set EMBEDDING_MODEL in the environment.
 *   4. Run this script — it will rebuild all four columns.
 * Between 1 and 4 every vector column is empty and retrieval falls back to
 * keyword search, so do it in a maintenance window.
 * (text-embedding-3-large can also be requested AT 1536 dims via the
 * `dimensions` API parameter, which avoids the schema migration entirely — but
 * the provider does not pass that parameter today.)
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Load .env manually (tsx does not) BEFORE importing app modules.
try {
  const envFile = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* no .env — rely on ambient environment */
}

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");
const domainArg = args.find((a) => !a.startsWith("--"));

interface Target {
  /** Physical table name, used in the raw UPDATE. */
  table: string;
  label: string;
  /** Rows for one shop: id + the text to embed. `hash` only where one is stored. */
  load(shopId: string): Promise<Array<{ id: string; text: string; hash?: string; stored?: string | null }>>;
  /** True when this row's stored hash proves its text is unchanged. */
  hashed: boolean;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

let exitCode = 0;

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");

  const { default: db } = await import("../app/db.server");
  const { Prisma } = await import("@prisma/client");
  const { productEmbeddingText, embedTexts, toSqlVector, EMBEDDING_DIMENSIONS } = await import(
    "../app/lib/embeddings/embedding.server"
  );
  const { getEmbeddingModelMarker, setEmbeddingModelMarker } = await import(
    "../app/lib/platform/platform-settings.server"
  );

  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const marker = await getEmbeddingModelMarker();
  const modelChanged = marker !== null && marker !== model;

  console.log(`embedding model: ${model}`);
  console.log(`vectors on disk : ${marker ?? "(marker not recorded yet — assuming current model)"}`);
  if (modelChanged) {
    console.log(`MODEL CHANGED — every vector is stale, rebuilding all four columns.`);
  }
  if (FORCE) console.log("--force — rebuilding every vector regardless of hash.");
  if (DRY_RUN) console.log("--dry-run — nothing will be written.");

  // Fail fast on a dimension mismatch rather than part-way through a rebuild.
  const [probe] = await embedTexts(["dimension probe"], { shopId: "" });
  if (probe.length !== EMBEDDING_DIMENSIONS) {
    console.error(
      `\n${model} returns ${probe.length}-dimension vectors but the schema is pinned at ${EMBEDDING_DIMENSIONS}.\n` +
        `A schema migration is required first — see the header of this file for the exact steps.`,
    );
    exitCode = 1;
    return;
  }

  const targets: Target[] = [
    {
      table: "products",
      label: "products",
      hashed: true,
      async load(shopId) {
        const rows = await db.product.findMany({
          where: { shopId },
          select: {
            id: true, title: true, description: true, productType: true, vendor: true,
            tags: true, metafieldText: true, contentHash: true,
          },
        });
        return rows.map((p) => {
          const text = productEmbeddingText(p);
          return { id: p.id, text, hash: hashText(text), stored: p.contentHash };
        });
      },
    },
    {
      table: "knowledge",
      label: "knowledge chunks",
      hashed: false,
      async load(shopId) {
        const rows = await db.knowledge.findMany({
          where: { shopId },
          select: { id: true, topic: true, body: true },
        });
        // Must match knowledge-ingest.server.ts exactly.
        return rows.map((k) => ({ id: k.id, text: `${k.topic}. ${k.body}` }));
      },
    },
    {
      table: "curated_answers",
      label: "curated answers",
      hashed: false,
      async load(shopId) {
        const rows = await db.curatedAnswer.findMany({
          where: { shopId },
          select: { id: true, question: true, synonyms: true },
        });
        // Must match curated/save.server.ts exactly.
        return rows.map((c) => ({ id: c.id, text: `${c.question} ${c.synonyms.join(" ")}`.trim() }));
      },
    },
    {
      table: "recommendations",
      label: "recommendations",
      hashed: false,
      async load(shopId) {
        const rows = await db.recommendation.findMany({
          where: { shopId },
          select: { id: true, triggerQuestions: true },
        });
        // NOTE: recommendations.embedding is written by the seed but read by
        // nothing — recommendation-match.server.ts re-embeds trigger questions
        // at query time into an in-process cache, so that lane is already
        // model-change-safe. Kept in sync anyway so the column is never a lie.
        return rows
          .filter((r) => r.triggerQuestions.length > 0)
          .map((r) => ({ id: r.id, text: r.triggerQuestions.join(" ") }));
      },
    },
  ];

  const shops = await db.shop.findMany({
    where: domainArg ? { domain: domainArg } : { uninstalledAt: null },
    select: { id: true, domain: true },
  });
  if (shops.length === 0) {
    console.error(domainArg ? `no shop matching ${domainArg}` : "no installed shops");
    exitCode = 1;
    return;
  }

  let totalRebuilt = 0;
  let failures = 0;

  for (const shop of shops) {
    console.log(`\n${shop.domain}`);
    for (const target of targets) {
      const rows = await target.load(shop.id);
      if (rows.length === 0) {
        console.log(`  ${target.label}: 0 rows`);
        continue;
      }

      // A NULL vector always needs rebuilding, whatever the hash says.
      const missing = new Set(
        (
          await db.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${target.table}"`)}
                       WHERE "shopId" = ${shop.id} AND "embedding" IS NULL`,
          )
        ).map((r) => r.id),
      );

      const stale = rows.filter((row) => {
        if (FORCE || modelChanged) return true;
        if (missing.has(row.id)) return true;
        // Only products carry a stored hash; without one, unchanged text is
        // indistinguishable from changed text, so leave it alone unless the
        // model moved (handled above).
        return target.hashed ? row.hash !== row.stored : false;
      });

      console.log(`  ${target.label}: ${rows.length} rows, ${stale.length} to re-embed`);
      if (stale.length === 0 || DRY_RUN) continue;

      try {
        const vectors = await embedTexts(
          stale.map((s) => s.text),
          { shopId: shop.id },
        );
        for (let i = 0; i < stale.length; i++) {
          const setHash = target.hashed
            ? Prisma.sql`, "contentHash" = ${stale[i].hash}`
            : Prisma.empty;
          await db.$executeRaw(Prisma.sql`
            UPDATE ${Prisma.raw(`"${target.table}"`)}
            SET "embedding" = ${toSqlVector(vectors[i])}::vector${setHash}
            WHERE "id" = ${stale[i].id} AND "shopId" = ${shop.id}
          `);
        }
        totalRebuilt += stale.length;
        console.log(`  ${target.label}: re-embedded ${stale.length}`);
      } catch (error) {
        failures += 1;
        console.error(`  ${target.label}: FAILED — ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  console.log(`\nrebuilt ${totalRebuilt} vector(s) across ${shops.length} shop(s)`);

  // Advance the marker ONLY after a clean full-fleet pass — a single-shop or
  // dry run must not tell the fleet its vectors are current.
  if (DRY_RUN) {
    console.log("dry run — marker unchanged");
  } else if (failures > 0) {
    console.error(`${failures} target(s) failed — marker left at ${marker ?? "(unset)"}`);
    exitCode = 1;
  } else if (domainArg) {
    console.log(`single-shop run — marker left at ${marker ?? "(unset)"}`);
  } else {
    await setEmbeddingModelMarker(model);
    console.log(`marker set: vectors on disk are now ${model}`);
  }
}

main()
  .catch((error) => {
    console.error("reembed failed:", error instanceof Error ? error.message : error);
    exitCode = 1;
  })
  .finally(async () => {
    const { default: db } = await import("../app/db.server");
    await db.$disconnect();
    // runtime-config / plan modules keep their own DB work in flight and would
    // hold the event loop open; exit explicitly rather than waiting them out.
    process.exit(exitCode);
  });
