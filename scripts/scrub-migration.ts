/* Prisma 6.16's differ does NOT ignore indexes on Unsupported columns: every
 * `migrate dev --create-only` regenerates DROP statements for our hand-written
 * HNSW/GIN indexes and tries to strip the generated tsvector column's
 * expression (proven 2026-08-06, see PROGRESS.md decisions log).
 *
 * This script scrubs those known-bad statements from the NEWEST migration.
 * Always create migrations via:  npm run migrate:new -- --name <name>
 * (which runs `prisma migrate dev --create-only`, scrubs, then applies).
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

const PROTECTED_INDEXES = [
  "products_embedding_hnsw",
  "knowledge_embedding_hnsw",
  "curated_answers_embedding_hnsw",
  "recommendations_embedding_hnsw",
  "products_search_text_gin",
  "analytics_events_payload_gin",
];

function newestMigrationDir(): string | null {
  const dirs = readdirSync(MIGRATIONS_DIR)
    .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
    .sort();
  return dirs.length > 0 ? dirs[dirs.length - 1] : null;
}

function main() {
  const dir = newestMigrationDir();
  if (!dir) {
    console.log("scrub: no migrations found");
    return;
  }
  const file = join(MIGRATIONS_DIR, dir, "migration.sql");
  const original = readFileSync(file, "utf-8");

  // Split into statements (Prisma writes them separated by blank lines with -- comments).
  const blocks = original.split(/\n\n+/);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const block of blocks) {
    const isProtectedDrop =
      /DROP INDEX/i.test(block) && PROTECTED_INDEXES.some((idx) => block.includes(idx));
    const isSearchTextDefault =
      /ALTER TABLE "products" ALTER COLUMN "searchText" DROP DEFAULT/i.test(block);
    if (isProtectedDrop || isSearchTextDefault) {
      removed.push(block.trim().split("\n").slice(-1)[0]);
    } else {
      kept.push(block);
    }
  }

  if (removed.length === 0) {
    console.log(`scrub: ${dir} clean (nothing to remove)`);
    return;
  }

  writeFileSync(file, kept.join("\n\n"), "utf-8");
  console.log(`scrub: ${dir} — removed ${removed.length} statement(s):`);
  for (const line of removed) console.log(`  - ${line}`);

  const remaining = readFileSync(file, "utf-8").trim();
  if (remaining.length === 0 || /^(--.*\n?)*$/.test(remaining)) {
    console.log(
      "scrub: WARNING — migration is now empty. Delete the folder if this migration had no real changes.",
    );
  }
}

main();
