/* Live end-to-end check for per-shop token accounting (spec 19).
 *   npx tsx scripts/usage-check.ts
 * Makes one real call of each kind against the dev shop and asserts that
 * llm_usage_daily captured non-zero tokens — especially for the STREAMING
 * path, which only reports usage when stream_options.include_usage is set.
 * Restores the shop's llm_usage_daily counters afterwards: rows that existed
 * before are reset to their prior values and rows this run created are deleted,
 * so repeated runs don't inflate the operator's cost reporting for the dev shop
 * (QA D-24 — the header used to claim this while the code only diffed a
 * baseline, so counters accumulated on every run).
 */
import db from "../app/db.server";
import { getLlmProvider } from "../app/lib/llm/index.server";
import { embedText } from "../app/lib/embeddings/embedding.server";
import { usageForShop } from "../app/lib/platform/usage-report.server";
import { costOf } from "../app/lib/platform/llm-pricing";

const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";

function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required for the live check");
  const shop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN } });
  if (!shop) throw new Error(`seed first: ${DEV_SHOP_DOMAIN} not found`);
  const shopId = shop.id;

  // llm_usage_daily is unique on (shopId, date, model, purpose) — the date MUST
  // be part of the key. Without it the map collapsed every day's row for a
  // model+purpose onto one entry, so the deltas below compared today's counters
  // against an arbitrary older day (QA D-24).
  const rowKey = (r: { date: Date; model: string; purpose: string }) =>
    `${r.date.toISOString().slice(0, 10)}|${r.model}|${r.purpose}`;
  const today = new Date().toISOString().slice(0, 10);
  const before = await db.llmUsageDaily.findMany({ where: { shopId } });
  const baseline = new Map(before.map((r) => [rowKey(r), r]));
  const llm = getLlmProvider();

  // 1. Non-streaming chat
  await llm.chat([{ role: "user", content: "Reply with the single word: ok" }], {
    shopId,
    purpose: "router",
  });

  // 2. STREAMING chat — the path that needs stream_options.include_usage
  let streamed = "";
  for await (const token of llm.chatStream(
    [{ role: "user", content: "Count from one to five in words." }],
    { shopId, purpose: "reply" },
  )) {
    streamed += token;
  }
  assert(streamed.length > 0, "stream produced content");

  // 3. Embeddings
  await embedText("a warm winter glove for cold hands", { shopId });

  // Fire-and-forget writes need a moment to land.
  await new Promise((r) => setTimeout(r, 1500));

  const after = await db.llmUsageDaily.findMany({ where: { shopId } });
  const delta = (model: string, purpose: string, field: "promptTokens" | "completionTokens" | "calls") => {
    // Compare TODAY's row only — that is the one the calls above touched.
    const key = `${today}|${model}|${purpose}`;
    const now = after.find((r) => rowKey(r) === key);
    const was = baseline.get(key);
    return (now?.[field] ?? 0) - (was?.[field] ?? 0);
  };

  const chatModel = process.env.CHAT_MODEL || "gpt-4o-mini";
  const embedModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

  assert(delta(chatModel, "router", "promptTokens") > 0, "non-streaming call recorded prompt tokens");
  assert(delta(chatModel, "router", "completionTokens") > 0, "non-streaming call recorded completion tokens");
  assert(delta(chatModel, "reply", "promptTokens") > 0, "STREAMED call recorded prompt tokens");
  assert(delta(chatModel, "reply", "completionTokens") > 0, "STREAMED call recorded completion tokens");
  assert(delta(embedModel, "embedding", "promptTokens") > 0, "embedding call recorded tokens");
  assert(delta(chatModel, "reply", "calls") === 1, "one streamed call counted exactly once");

  // Report path
  const report = await usageForShop(shopId, 7);
  assert(report !== null, "usage report resolves the shop");
  assert(report!.totals.tokens > 0, "report totals include the new tokens");
  assert(report!.totals.costUsd > 0, "report prices the usage (cost > 0)");
  assert(report!.daily.length === 7, "daily series is dense (7 days)");
  assert(report!.byPurpose.length >= 3, "breakdown covers router/reply/embedding");

  const sample = costOf({ model: "gpt-4o-mini", promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 });
  assert(sample === 0.15, "price table math: 1M gpt-4o-mini input = $0.15");

  console.log("\nlive rows for this shop:");
  for (const row of after) {
    console.log(
      `  ${row.model} · ${row.purpose}: ${row.calls} calls, ${row.promptTokens} in / ${row.completionTokens} out`,
    );
  }
  console.log(`\ntotal estimated cost (7d): $${report!.totals.costUsd.toFixed(6)}`);

  // Put the counters back exactly as we found them.
  let restored = 0;
  let removed = 0;
  for (const row of after) {
    const prior = baseline.get(rowKey(row));
    if (prior) {
      if (
        prior.calls !== row.calls ||
        prior.promptTokens !== row.promptTokens ||
        prior.completionTokens !== row.completionTokens ||
        prior.cachedTokens !== row.cachedTokens
      ) {
        await db.llmUsageDaily.update({
          where: { id: row.id },
          data: {
            calls: prior.calls,
            promptTokens: prior.promptTokens,
            completionTokens: prior.completionTokens,
            cachedTokens: prior.cachedTokens,
          },
        });
        restored++;
      }
    } else {
      await db.llmUsageDaily.delete({ where: { id: row.id } });
      removed++;
    }
  }
  console.log(`counters restored: ${restored} reset, ${removed} deleted`);

  console.log("\nusage-check PASS");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
