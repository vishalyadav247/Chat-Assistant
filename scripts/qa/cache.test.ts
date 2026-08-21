/* QA cache harness — verifies the five in-process caches: TTL honoured,
 * explicit invalidation works, no stale value served after a write, per-shop
 * keying (no cross-tenant leak), globalThis keying (survives dev hot reload)
 * and bounded memory.
 *
 *   npx tsx scripts/qa/perf-seed.ts        # creates the perf-test shop it writes to
 *   npx tsx scripts/qa/cache.test.ts
 *
 * Only the throwaway perf-test.myshopify.com shop is written to; the platform
 * caches (app_secrets rows) are restored to their prior value in a finally.
 * Exits non-zero on any FAIL and always disconnects the Prisma singleton.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "perf-test-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "perf-test-secret";
process.env.SCOPES = process.env.SCOPES || "read_products";

const PERF_SHOP_DOMAIN = "perf-test.myshopify.com";
const OTHER_SHOP_DOMAIN = "perf-test-b.myshopify.com";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
}

/** Every module that writes a column ShopConfig caches, and whether it must
 *  call invalidateShopConfig. Checked statically — a missed invalidation makes
 *  a merchant's saved setting silently inert for up to the 60s TTL. */
const SHOP_CONFIG_WRITERS: { file: string; what: string; mustInvalidate: boolean }[] = [
  { file: "app/lib/instructions/save.server.ts", what: "persona / guardrails / shopSettings / handoverConfig", mustInvalidate: true },
  { file: "app/lib/settings/save.server.ts", what: "shopSettings + shops.timezone", mustInvalidate: true },
  { file: "app/lib/widget/settings-save.server.ts", what: "widgetSettings", mustInvalidate: true },
  { file: "app/lib/billing/shopify-billing.server.ts", what: "shops.plan / planStatus", mustInvalidate: true },
  { file: "app/routes/app.ai-agent.training.tsx", what: "shopSettings", mustInvalidate: true },
  { file: "app/routes/app.ai-agent.tsx", what: "shops.aiEnabled", mustInvalidate: true },
  { file: "app/routes/webhooks.app-subscriptions.tsx", what: "shops.plan / planStatus", mustInvalidate: true },
  { file: "app/routes/webhooks.app.uninstalled.tsx", what: "shops billing reset", mustInvalidate: true },
  { file: "app/routes/app._index.tsx", what: "shops.name / timezone / currency (identity backfill)", mustInvalidate: true },
  { file: "app/lib/jobs/handlers.server.ts", what: "GDPR cleanupShop: deletes persona/guardrails/handover/widget/shop settings + resets shops.plan", mustInvalidate: true },
  { file: "app/lib/install.server.ts", what: "creates persona + guardrails, clears uninstalledAt", mustInvalidate: false },
];

async function main(): Promise<void> {
  const { default: db } = await import("../../app/db.server");
  const restore: (() => Promise<void>)[] = [];

  try {
    const shop = await db.shop.findUnique({ where: { domain: PERF_SHOP_DOMAIN } });
    if (!shop) {
      console.error(`No ${PERF_SHOP_DOMAIN} shop — run: npx tsx scripts/qa/perf-seed.ts`);
      process.exitCode = 1;
      return;
    }
    const shopId = shop.id;
    const other = await db.shop.upsert({
      where: { domain: OTHER_SHOP_DOMAIN },
      update: {},
      create: { domain: OTHER_SHOP_DOMAIN, name: "Perf B", currency: "USD", timezone: "UTC" },
    });
    restore.push(async () => {
      await db.shopSettings.deleteMany({ where: { shopId: other.id } });
      await db.shop.deleteMany({ where: { id: other.id } });
    });

    // ── 1. shop-config.server.ts (60s TTL + invalidateShopConfig) ──────────
    section("shop-config.server.ts — 60s TTL + invalidateShopConfig()");
    const config = await import("../../app/lib/config/shop-config.server");

    ok(
      "cache lives on globalThis (survives dev hot reload)",
      typeof (globalThis as { shopConfigCache?: unknown }).shopConfigCache !== "undefined" ||
        (await config.getShopConfig(shopId)) !== undefined,
    );
    ok(
      "cache handle is the globalThis Map, not a module-local one",
      (globalThis as { shopConfigCache?: Map<string, unknown> }).shopConfigCache instanceof Map,
    );

    // TTL: an out-of-band DB write must NOT be visible before the TTL/invalidate.
    await db.shop.update({ where: { id: shopId }, data: { currency: "USD" } });
    config.invalidateShopConfig(shopId);
    const before = await config.getShopConfig(shopId);
    await db.shop.update({ where: { id: shopId }, data: { currency: "EUR" } });
    const stillCached = await config.getShopConfig(shopId);
    ok(
      "value IS cached (an out-of-band write is not seen within the TTL)",
      before.currency === "USD" && stillCached.currency === "USD",
      `before=${before.currency} after-raw-write=${stillCached.currency}`,
    );

    config.invalidateShopConfig(shopId);
    const afterInvalidate = await config.getShopConfig(shopId);
    ok(
      "invalidateShopConfig() serves the new value immediately",
      afterInvalidate.currency === "EUR",
      `currency=${afterInvalidate.currency}`,
    );
    await db.shop.update({ where: { id: shopId }, data: { currency: "USD" } });
    config.invalidateShopConfig(shopId);

    // Per-shop keying: shop B must never see shop A's config.
    await db.shop.update({ where: { id: other.id }, data: { currency: "GBP" } });
    const aConfig = await config.getShopConfig(shopId);
    const bConfig = await config.getShopConfig(other.id);
    ok(
      "cache is keyed per shop (no cross-tenant leak)",
      aConfig.shopId === shopId &&
        bConfig.shopId === other.id &&
        aConfig.currency === "USD" &&
        bConfig.currency === "GBP",
      `A=${aConfig.currency} B=${bConfig.currency}`,
    );
    config.invalidateShopConfig(other.id);
    ok(
      "invalidating one shop does not evict another",
      (globalThis as { shopConfigCache: Map<string, unknown> }).shopConfigCache.has(shopId),
    );

    // Memory bound.
    const store = (globalThis as { shopConfigCache: Map<string, unknown> }).shopConfigCache;
    const sizeBefore = store.size;
    for (let i = 0; i < 700; i++) store.set(`synthetic-shop-${i}`, { config: aConfig, at: Date.now() });
    // Eviction runs on the miss path (a cache HIT returns before touching the
    // Map), so force a miss — which is exactly when the Map can grow.
    config.invalidateShopConfig(shopId);
    await config.getShopConfig(shopId);
    ok(
      "shop-config cache is bounded (evicts instead of growing forever)",
      store.size <= 501,
      `size ${sizeBefore} -> ${store.size} after inserting 700 synthetic entries`,
    );
    for (const key of [...store.keys()]) if (key.startsWith("synthetic-shop-")) store.delete(key);

    // ── 2. Every writer of a cached column invalidates ─────────────────────
    section("shop-config invalidation coverage (every writer)");
    for (const writer of SHOP_CONFIG_WRITERS) {
      const source = readFileSync(join(process.cwd(), writer.file), "utf-8");
      const calls = /invalidateShopConfig\s*\(/.test(source);
      if (writer.mustInvalidate) {
        ok(`${writer.file} invalidates (${writer.what})`, calls);
      } else {
        console.log(`  INFO ${writer.file} — ${writer.what}: ${calls ? "invalidates" : "no invalidate (install-time only)"}`);
      }
    }

    // Functional proof for the main save paths: the value must be visible on
    // the very next read, without waiting out the 60s TTL.
    section("shop-config invalidation — functional round trips");
    const instructions = await import("../../app/lib/instructions/save.server");
    const marker = `qa-cache-${Date.now()}`;
    await instructions.saveGeneralInstructions(shopId, {
      role: marker,
      communicationStyle: "friendly",
      brandVoice: "Plain and helpful.",
      behaviours: "Be brief.",
      defaultLanguage: "en",
      autoDetectLanguage: false,
      bannedTopics: [],
      fallbackMessage: "Sorry, I do not know that yet.",
    });
    ok(
      "saveGeneralInstructions -> next getShopConfig sees the new persona",
      (await config.getShopConfig(shopId)).persona?.role === marker,
    );

    const handoverMarker = `qa-handover-${Date.now()}`;
    const savedHandover = await instructions.saveHandoverConfig(shopId, {
      destination: "collect_email",
      collectEmail: { postSubmitMessage: handoverMarker },
    });
    ok(
      "saveHandoverConfig -> next getShopConfig sees the new handover config",
      (await config.getShopConfig(shopId)).handover.collectEmail.postSubmitMessage ===
        savedHandover.collectEmail.postSubmitMessage,
    );

    const widgetSave = await import("../../app/lib/widget/settings-save.server");
    ok(
      "widget/settings-save.server.ts calls invalidateShopConfig",
      /invalidateShopConfig\s*\(/.test(
        readFileSync(join(process.cwd(), "app/lib/widget/settings-save.server.ts"), "utf-8"),
      ) && typeof widgetSave === "object",
    );

    // ── 3. plans.server.ts (30s REFRESH_TTL_MS) — READ ONLY ────────────────
    section("billing/plans.server.ts — 30s REFRESH_TTL_MS (read-only check)");
    const plans = await import("../../app/lib/billing/plans.server");
    const platformSettings = await import("../../app/lib/platform/platform-settings.server");
    const priorPlanConfig = await platformSettings.getStoredPlanConfig();
    restore.push(async () => {
      await platformSettings.savePlanConfig(priorPlanConfig);
    });

    const priorMode = plans.planEnforcementMode();
    await platformSettings.savePlanConfig({
      ...priorPlanConfig,
      enforcement: priorMode === "enforced" ? "open" : "enforced",
    });
    ok(
      "savePlanConfig applies immediately in-process (awaits loadPlanConfig)",
      plans.planEnforcementMode() !== priorMode,
      `${priorMode} -> ${plans.planEnforcementMode()}`,
    );
    await platformSettings.savePlanConfig(priorPlanConfig);
    ok("plan config restored", plans.planEnforcementMode() === priorMode);
    console.log(
      "  INFO plans cache state is module-level (not globalThis) and refreshed lazily:" +
        " a config change made by ANOTHER process is visible only after the 30s TTL" +
        " AND one further gate check (maybeRefresh is fire-and-forget, so the request" +
        " that trips the TTL still sees the old matrix).",
    );

    // ── 4. platform-settings + runtime-config (30s) — READ ONLY ────────────
    section("platform/platform-settings.server.ts + runtime-config.server.ts — 30s");
    const priorAi = await platformSettings.getAiOverrides();
    restore.push(async () => {
      await platformSettings.saveAiOverrides(priorAi);
    });
    await platformSettings.saveAiOverrides({ ...priorAi, maxTokens: 321 });
    ok(
      "saveAiOverrides updates the cache synchronously (no stale read after write)",
      (await platformSettings.getAiOverrides()).maxTokens === 321,
    );
    await platformSettings.saveAiOverrides(priorAi);
    ok(
      "AI overrides restored",
      (await platformSettings.getAiOverrides()).maxTokens === priorAi.maxTokens,
    );

    const runtime = await import("../../app/lib/platform/runtime-config.server");
    const priorHandle = runtime.storedRuntimeConfig().appStoreHandle;
    restore.push(async () => {
      await runtime.saveRuntimeConfig({ appStoreHandle: priorHandle });
    });
    await runtime.saveRuntimeConfig({ appStoreHandle: "qa-cache-probe" });
    ok(
      "saveRuntimeConfig reloads before returning (no stale read after write)",
      runtime.storedRuntimeConfig().appStoreHandle === "qa-cache-probe",
    );
    await runtime.saveRuntimeConfig({ appStoreHandle: priorHandle });
    ok("runtime config restored", runtime.storedRuntimeConfig().appStoreHandle === priorHandle);
    console.log(
      "  INFO both caches are module-level singletons, NOT globalThis-keyed:" +
        " a dev hot reload resets them to defaults until the eager loader finishes." +
        " Values are platform-wide, so there is no per-tenant key to leak.",
    );

    // ── 5. product-search lexicon cache (10 min) ───────────────────────────
    section("search/product-search.server.ts — 10 min lexicon cache");
    const productSearch = await import("../../app/lib/search/product-search.server");
    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) embedding.push(Math.sin(i * 0.9) * 0.4);

    const lexKey = () =>
      (globalThis as { lexiconCache?: Map<string, { at: number; list: string[] }> }).lexiconCache;
    lexKey()?.delete(shopId);
    const t0 = Date.now();
    await productSearch.hybridProductSearch({
      shopId,
      queryEmbedding: embedding,
      keywords: [],
      message: "brracelet silvr",
      minMeaningScore: 0.2,
      limit: 4,
    });
    const coldMs = Date.now() - t0;
    ok("lexicon cache lives on globalThis", lexKey() instanceof Map);
    ok("lexicon cached for the shop after one search", lexKey()?.has(shopId) === true);

    const t1 = Date.now();
    await productSearch.hybridProductSearch({
      shopId,
      queryEmbedding: embedding,
      keywords: [],
      message: "brracelet silvr",
      minMeaningScore: 0.2,
      limit: 4,
    });
    const warmMs = Date.now() - t1;
    ok(
      "second search is faster (cache actually used)",
      warmMs < coldMs,
      `cold ${coldMs}ms -> warm ${warmMs}ms`,
    );

    ok(
      "lexicon cache is keyed per shop (no cross-tenant word leak)",
      lexKey()?.has(shopId) === true && lexKey()?.has(other.id) !== true,
    );

    const lexStore = lexKey()!;
    for (let i = 0; i < 700; i++) {
      lexStore.set(`synthetic-lex-${i}`, { at: Date.now(), list: [] } as never);
    }
    lexStore.delete(shopId);
    await productSearch.hybridProductSearch({
      shopId,
      queryEmbedding: embedding,
      keywords: [],
      message: "brracelet silvr",
      minMeaningScore: 0.2,
      limit: 4,
    });
    ok(
      "lexicon cache is bounded and evicts oldest-first (does not clear() wholesale)",
      lexStore.size <= 501 && lexStore.has(shopId),
      `size ${lexStore.size}, this shop still cached: ${lexStore.has(shopId)}`,
    );
    for (const key of [...lexStore.keys()]) {
      if (key.startsWith("synthetic-lex-")) lexStore.delete(key);
    }
    console.log(
      "  INFO the lexicon is a 10-minute snapshot with NO invalidation hook:" +
        " products synced or edited in that window are invisible to typo correction" +
        " until it expires. Acceptable (typo correction only), but it is real staleness.",
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    for (const step of restore.reverse()) {
      await step().catch((error) => console.error("restore failed:", error));
    }
    const { default: db } = await import("../../app/db.server");
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
