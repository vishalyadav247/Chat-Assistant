/* Install / reinstall / uninstall lifecycle QA (App Store submission gate).
 * Run with the dev DB up:  npx tsx scripts/qa/install-lifecycle.test.ts
 *
 * Everything here goes through the REAL code paths:
 *   - install        → app/lib/install.server.ts `onShopAuthenticated` (the
 *                      afterAuth hook wired in app/shopify.server.ts)
 *   - webhooks       → the route `action` exports are invoked with genuinely
 *                      HMAC-SIGNED requests, so `authenticate.webhook` runs for
 *                      real (invalid signature must 401 BEFORE handler code)
 *   - app proxy      → proxy.widget-config's loader with a genuinely signed
 *                      app-proxy query string
 *   - purge          → jobs/handlers.server `cleanupShop` / `countShopRows`
 *
 * Every throwaway shop is deleted at the end, and the shared Prisma singleton
 * plus the pg-boss singleton are torn down in `finally` — without that the
 * process never exits (this previously wedged `npm run smoke`).
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

// tsx does not load .env — hydrate process.env before any app import (ESM
// static imports hoist, so everything app-side is dynamically imported below).
try {
  const envFile = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {
  /* no .env — rely on ambient environment */
}
// shopify.server needs these to construct the library client. The webhook /
// app-proxy signatures below are computed with whatever secret ends up here,
// so a real .env and this stub both work.
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "install-lifecycle-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "install-lifecycle-secret";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";

const SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.SHOPIFY_APP_URL.replace(/\/$/, "");

const FRESH = "qa-install-fresh.myshopify.com";
const NEIGHBOR = "qa-install-neighbor.myshopify.com";
const ALL_DOMAINS = [FRESH, NEIGHBOR];

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: string) {
  checks += 1;
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
function section(title: string) {
  console.log(`\n${title}`);
}

// ── Signed-request helpers ───────────────────────────────────────────────────

/** Build a genuinely HMAC-signed Shopify webhook request. */
function webhookRequest(topic: string, shopDomain: string, payload: unknown, opts: { badHmac?: boolean } = {}): Request {
  const body = JSON.stringify(payload);
  const hmac = opts.badHmac
    ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    : createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
  return new Request(`${APP_URL}/webhooks/test`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": shopDomain,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": `qa-${topic}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body,
  });
}

/** Build a genuinely signed Shopify app-proxy GET request. */
function appProxyRequest(path: string, shopDomain: string, opts: { badSignature?: boolean } = {}): Request {
  const params: Record<string, string> = {
    shop: shopDomain,
    path_prefix: "/apps/ccwidget",
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");
  const signature = opts.badSignature
    ? "deadbeef".repeat(8)
    : createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex");
  const search = new URLSearchParams({ ...params, signature }).toString();
  return new Request(`${APP_URL}${path}?${search}`, { method: "GET" });
}

/** Run a route action/loader and normalise thrown Responses into a status. */
async function callRoute(
  fn: (args: { request: Request; params: Record<string, string>; context: unknown }) => unknown,
  request: Request,
): Promise<{ status: number; ms: number; error?: unknown }> {
  const started = Date.now();
  try {
    const result = (await fn({ request, params: {}, context: {} })) as Response | undefined;
    return { status: result instanceof Response ? result.status : 200, ms: Date.now() - started };
  } catch (error) {
    if (error instanceof Response) return { status: error.status, ms: Date.now() - started };
    return { status: 500, ms: Date.now() - started, error };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { default: db } = await import("../../app/db.server");
  const { onShopAuthenticated } = await import("../../app/lib/install.server");
  const { cleanupShop, countShopRows } = await import("../../app/lib/jobs/handlers.server");
  const uninstalledRoute = await import("../../app/routes/webhooks.app.uninstalled");
  const scopesRoute = await import("../../app/routes/webhooks.app.scopes_update");
  const complianceRoute = await import("../../app/routes/webhooks.compliance");
  const widgetConfigRoute = await import("../../app/routes/proxy.widget-config");

  // ── Reset leftovers from a previous run ────────────────────────────────────
  const wipe = async () => {
    for (const domain of ALL_DOMAINS) {
      const stale = await db.shop.findUnique({ where: { domain } });
      if (stale) {
        await cleanupShop(domain).catch(() => undefined);
        await db.promoRedemption.deleteMany({ where: { shopId: stale.id } });
        await db.redactLog.deleteMany({ where: { shopId: stale.id } });
        await db.appLog.deleteMany({ where: { shopId: stale.id } });
        await db.shop.delete({ where: { id: stale.id } }).catch(() => undefined);
      }
      await db.session.deleteMany({ where: { shop: domain } });
    }
  };
  await wipe();

  // ═════════════════════════════════════════════════════════════════════════
  section("1. INSTALL — afterAuth bootstrap on a brand-new shop");
  // ═════════════════════════════════════════════════════════════════════════
  // The real afterAuth hook (app/shopify.server.ts calls exactly this).
  await onShopAuthenticated(FRESH);

  const fresh = await db.shop.findUnique({ where: { domain: FRESH } });
  check("Shop row created", fresh !== null);
  if (!fresh) throw new Error("install did not create a Shop row — cannot continue");
  const shopId = fresh.id;

  check("uninstalledAt is null on a fresh install", fresh.uninstalledAt === null);
  check("installedAt stamped", fresh.installedAt instanceof Date);
  check("starts on the free plan", fresh.plan === "free" && fresh.planStatus === "none");
  check("no subscription id on a fresh install", fresh.subscriptionId === null);
  check("aiEnabled defaults to true", fresh.aiEnabled === true);

  const persona = await db.persona.findUnique({ where: { shopId } });
  check("default Persona seeded", persona !== null);
  check(
    "Persona has a non-empty role + welcome message",
    Boolean(persona?.role) && Boolean(persona?.welcomeMessage),
  );
  const guardrails = await db.guardrails.findUnique({ where: { shopId } });
  check("default Guardrails seeded", guardrails !== null);
  check(
    "Guardrails carry a fallback message + banned topics",
    Boolean(guardrails?.fallbackMessage) && (guardrails?.bannedTopics.length ?? 0) > 0,
  );
  const recCount = await db.recommendation.count({ where: { shopId } });
  check("seeded app recommendations", recCount === 2, `${recCount}`);

  // Idempotency: afterAuth also fires on every token refresh.
  await onShopAuthenticated(FRESH);
  check(
    "afterAuth is idempotent (no duplicate persona/guardrails/recommendations)",
    (await db.persona.count({ where: { shopId } })) === 1 &&
      (await db.guardrails.count({ where: { shopId } })) === 1 &&
      (await db.recommendation.count({ where: { shopId } })) === 2,
  );

  // Initial catalog sync must have been enqueued (never-synced shop).
  const enqueued = await db.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM pgboss.job
    WHERE name IN ('catalog-sync', 'collection-sync', 'discount-sync')
      AND data->>'shopDomain' = ${FRESH}
  `;
  const enqueuedNames = new Set(enqueued.map((row) => row.name));
  check(
    "initial catalog/collection/discount sync enqueued",
    enqueuedNames.has("catalog-sync") &&
      enqueuedNames.has("collection-sync") &&
      enqueuedNames.has("discount-sync"),
    [...enqueuedNames].join(",") || "none",
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("2. FRESH-SHOP LOAD TEST — every server module against a bare shop");
  // ═════════════════════════════════════════════════════════════════════════
  // install.server seeds only Persona/Guardrails/Recommendations. WidgetSettings,
  // ShopSettings, HandoverConfig and SyncState rows do NOT exist yet, so every
  // read path must fall back to schema defaults instead of 500-ing a page.
  const [
    dashboard,
    reports,
    usage,
    plans,
    campaigns,
    contacts,
    curatedSave,
    faq,
    inbox,
    sources,
    metafields,
    settingsSave,
    availability,
    widgetSave,
    widgetConfig,
    shopConfig,
    prefs,
    team,
    dataRequest,
    embedStatus,
    productSearch,
    promoCodes,
  ] = await Promise.all([
    import("../../app/lib/dashboard/dashboard.server"),
    import("../../app/lib/analytics/reports.server"),
    import("../../app/lib/billing/usage.server"),
    import("../../app/lib/billing/plans.server"),
    import("../../app/lib/campaigns/campaigns.server"),
    import("../../app/lib/contacts/contacts.server"),
    import("../../app/lib/curated/save.server"),
    import("../../app/lib/faq/faq.server"),
    import("../../app/lib/inbox/inbox.server"),
    import("../../app/lib/ingestion/sources.server"),
    import("../../app/lib/ingestion/metafields.server"),
    import("../../app/lib/settings/save.server"),
    import("../../app/lib/settings/availability.server"),
    import("../../app/lib/widget/settings-save.server"),
    import("../../app/lib/widget/config.server"),
    import("../../app/lib/config/shop-config.server"),
    import("../../app/lib/format/prefs.server"),
    import("../../app/lib/team/team.server"),
    import("../../app/lib/compliance/data-request.server"),
    import("../../app/lib/embed-status.server"),
    import("../../app/lib/search/product-search.server"),
    import("../../app/lib/billing/promo-codes.server"),
  ]);

  const loadCases: Array<[string, () => Promise<unknown>]> = [
    ["dashboard.dashboardMetrics", () => dashboard.dashboardMetrics(shopId, "7d")],
    ["dashboard.setupChecklist", () => dashboard.setupChecklist(shopId, FRESH)],
    ["dashboard.liveFeed", () => dashboard.liveFeed(shopId)],
    ["reports.analyticsCounters", () => reports.analyticsCounters(shopId, "7d")],
    ["reports.conversationSeries", () => reports.conversationSeries(shopId, "7d")],
    ["reports.resolutionBreakdown", () => reports.resolutionBreakdown(shopId, "7d")],
    ["reports.csatSummary", () => reports.csatSummary(shopId)],
    ["reports.recommendationFunnel", () => reports.recommendationFunnel(shopId, "7d")],
    ["reports.responsePerformance", () => reports.responsePerformance(shopId, "7d")],
    ["reports.topQuestions", () => reports.topQuestions(shopId)],
    ["reports.exportConversationsCsv", () => reports.exportConversationsCsv(shopId)],
    ["reports.exportAnalyticsCsv", () => reports.exportAnalyticsCsv(shopId, "7d")],
    ["usage.currentUsage", () => usage.currentUsage(shopId)],
    ["usage.aiAllowed", () => usage.aiAllowed(shopId)],
    ["plans.loadPlanConfig", () => plans.loadPlanConfig()],
    ["campaigns.listCampaigns", () => campaigns.listCampaigns(shopId)],
    ["campaigns.activeCampaignsForWidget", () => campaigns.activeCampaignsForWidget(shopId, "/")],
    ["contacts.listContacts", () => contacts.listContacts(shopId)],
    ["contacts.contactStats", () => contacts.contactStats(shopId)],
    ["contacts.exportContactsCsv", () => contacts.exportContactsCsv(shopId, { scope: "all" })],
    ["curated.pendingEmbeddingIds", () => curatedSave.pendingEmbeddingIds(shopId)],
    ["faq.listFaqTree", () => faq.listFaqTree(shopId)],
    ["faq.exportFaqCsv", () => faq.exportFaqCsv(shopId, "all")],
    ["inbox.listConversations", () => inbox.listConversations(shopId)],
    ["sources.listSources", () => sources.listSources(shopId)],
    ["sources.listSuggested", () => sources.listSuggested(shopId)],
    ["metafields.listMetafieldDefinitions", () => metafields.listMetafieldDefinitions(shopId)],
    ["settings.loadShopSettings", () => settingsSave.loadShopSettings(shopId)],
    ["widget.loadWidgetSettings", () => widgetSave.loadWidgetSettings(shopId)],
    ["widget.buildWidgetConfig", () => widgetConfig.buildWidgetConfig(shopId, FRESH)],
    ["config.getShopConfig", () => shopConfig.getShopConfig(shopId)],
    ["format.getDateTimePrefs", () => prefs.getDateTimePrefs(shopId)],
    ["team.listMembers", () => team.listMembers(shopId)],
    ["team.assigneeOptions", () => team.assigneeOptions(shopId)],
    ["compliance.pendingDataRequests", () => dataRequest.pendingDataRequests(shopId)],
    ["promoCodes.activeRedemptionFor", () => promoCodes.activeRedemptionFor(shopId, null)],
    ["productSearch.isPurchasable", async () => productSearch.isPurchasable({ stock: 1 })],
  ];

  for (const [name, run] of loadCases) {
    try {
      await run();
      check(name, true);
    } catch (error) {
      // A PlanGateError is the CORRECT answer for a free shop on a gated
      // feature — the route catches it and renders the upgrade prompt. Anything
      // else is a missing-default-row crash, which is what this section hunts.
      if (error instanceof plans.PlanGateError) {
        check(`${name} (plan-gated for free — enforced, not a crash)`, true);
      } else {
        check(name, false, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // Pure functions that page loaders call with the freshly-defaulted blobs.
  try {
    const shopSettings = await settingsSave.loadShopSettings(shopId);
    availability.resolveAvailability(shopSettings.availability, "UTC", false);
    check("availability.resolveAvailability on default settings", true);
  } catch (error) {
    check(
      "availability.resolveAvailability on default settings",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  // embed-status hits the Admin API; on a shop with no session it must degrade,
  // not throw (the dashboard checklist renders it).
  try {
    await embedStatus.getEmbedStatus(FRESH);
    check("embedStatus.getEmbedStatus degrades without a session", true);
  } catch (error) {
    check(
      "embedStatus.getEmbedStatus degrades without a session",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  section("3. WIDGET — app proxy on an installed shop");
  // ═════════════════════════════════════════════════════════════════════════
  await db.session.create({
    data: {
      id: `offline_${FRESH}`,
      shop: FRESH,
      state: "qa",
      isOnline: false,
      accessToken: "qa-token",
      scope: "read_products",
    },
  });

  const widgetOk = await callRoute(
    widgetConfigRoute.loader as never,
    appProxyRequest("/proxy/widget-config", FRESH),
  );
  check("widget-config returns 200 for an installed shop", widgetOk.status === 200, `status ${widgetOk.status}`);

  const widgetForged = await callRoute(
    widgetConfigRoute.loader as never,
    appProxyRequest("/proxy/widget-config", FRESH, { badSignature: true }),
  );
  check(
    "widget-config rejects a forged proxy signature (no 200)",
    widgetForged.status !== 200,
    `status ${widgetForged.status}`,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("4. app/scopes_update WEBHOOK");
  // ═════════════════════════════════════════════════════════════════════════
  // A second session row for the same shop: the handler must not leave a stale
  // scope string behind on any of them.
  await db.session.create({
    data: {
      id: `online_${FRESH}`,
      shop: FRESH,
      state: "qa",
      isOnline: true,
      accessToken: "qa-token-2",
      scope: "read_products",
    },
  });

  const scopesBad = await callRoute(
    scopesRoute.action as never,
    webhookRequest("app/scopes_update", FRESH, { current: ["read_products", "read_orders"] }, { badHmac: true }),
  );
  check("scopes_update rejects an invalid HMAC with 401", scopesBad.status === 401, `status ${scopesBad.status}`);

  const scopesOk = await callRoute(
    scopesRoute.action as never,
    webhookRequest("app/scopes_update", FRESH, { current: ["read_products", "read_orders"] }),
  );
  check("scopes_update accepts a valid HMAC (200)", scopesOk.status === 200, `status ${scopesOk.status}`);
  check("scopes_update responds well inside the 5s budget", scopesOk.ms < 5000, `${scopesOk.ms}ms`);

  const sessionsAfterScopes = await db.session.findMany({ where: { shop: FRESH }, select: { id: true, scope: true } });
  const stale = sessionsAfterScopes.filter((s) => s.scope !== "read_products,read_orders");
  check(
    "every stored session has the updated scope string",
    stale.length === 0,
    stale.map((s) => `${s.id}=${s.scope}`).join(" ") || "all updated",
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("5. COMPLIANCE WEBHOOKS — HMAC + real workflows");
  // ═════════════════════════════════════════════════════════════════════════
  for (const topic of ["customers/data_request", "customers/redact", "shop/redact"]) {
    const bad = await callRoute(
      complianceRoute.action as never,
      webhookRequest(topic, FRESH, { shop_domain: FRESH }, { badHmac: true }),
    );
    check(`${topic}: invalid HMAC → 401 before handler code`, bad.status === 401, `status ${bad.status}`);
  }
  check(
    "invalid-HMAC compliance calls produced no DataRequest rows",
    (await db.dataRequest.count({ where: { shopId } })) === 0,
  );

  const dataReq = await callRoute(
    complianceRoute.action as never,
    webhookRequest("customers/data_request", FRESH, {
      shop_domain: FRESH,
      customer: { id: 777001, email: "qa-shopper@example.com" },
      orders_requested: [],
    }),
  );
  check("customers/data_request: valid HMAC → 200", dataReq.status === 200, `status ${dataReq.status}`);
  check("customers/data_request responds inside the 5s budget", dataReq.ms < 5000, `${dataReq.ms}ms`);
  const dataRows = await db.dataRequest.findMany({ where: { shopId } });
  check("customers/data_request created a DataRequest row", dataRows.length === 1);
  check(
    "DataRequest carries the 30-day SLA due date",
    dataRows[0] !== undefined &&
      Math.abs(dataRows[0].dueAt.getTime() - (Date.now() + 30 * 24 * 3600 * 1000)) < 60_000,
  );
  // Shopify redelivers on timeout — must not stack duplicates.
  await callRoute(
    complianceRoute.action as never,
    webhookRequest("customers/data_request", FRESH, {
      shop_domain: FRESH,
      customer: { id: 777001, email: "qa-shopper@example.com" },
    }),
  );
  check(
    "customers/data_request is redelivery-safe (no duplicate row)",
    (await db.dataRequest.count({ where: { shopId } })) === 1,
  );

  const redact = await callRoute(
    complianceRoute.action as never,
    webhookRequest("customers/redact", FRESH, {
      shop_domain: FRESH,
      customer: { id: 777002, email: "qa-redact@example.com" },
    }),
  );
  check("customers/redact: valid HMAC → 200", redact.status === 200, `status ${redact.status}`);
  check(
    "customers/redact is enqueue-only (well inside 5s)",
    redact.ms < 5000,
    `${redact.ms}ms`,
  );

  // shop/redact must NOT stamp a shop that still has live sessions (reinstalled).
  const shopRedactLive = await callRoute(
    complianceRoute.action as never,
    webhookRequest("shop/redact", FRESH, { shop_domain: FRESH }),
  );
  check("shop/redact: valid HMAC → 200", shopRedactLive.status === 200, `status ${shopRedactLive.status}`);
  check(
    "shop/redact does not deactivate a shop with live sessions",
    (await db.shop.findUnique({ where: { id: shopId } }))?.uninstalledAt === null,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("6. UNINSTALL — app/uninstalled webhook");
  // ═════════════════════════════════════════════════════════════════════════
  // Give the shop a paid subscription + retained history first.
  await db.shop.update({
    where: { id: shopId },
    data: {
      plan: "pro",
      planStatus: "active",
      subscriptionId: "gid://shopify/AppSubscription/999",
      billingInterval: "monthly",
      trialEndsAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
      usageLineItemId: "gid://shopify/AppSubscriptionLineItem/999",
    },
  });
  const keptContact = await db.contact.create({
    data: { shopId, email: "qa-kept@example.com", type: "customer" },
  });
  const keptConvo = await db.conversation.create({
    data: { shopId, sessionId: "qa-kept-session", contactId: keptContact.id },
  });
  await db.message.create({
    data: { shopId, conversationId: keptConvo.id, role: "in", author: "shopper", content: "KEPT-ACROSS-REINSTALL" },
  });

  // Neighbor shop that must be untouched by everything below.
  const neighbor = await db.shop.create({ data: { domain: NEIGHBOR, name: "QA neighbor" } });
  await db.session.create({
    data: { id: `offline_${NEIGHBOR}`, shop: NEIGHBOR, state: "qa", accessToken: "qa", isOnline: false },
  });
  await db.contact.create({ data: { shopId: neighbor.id, email: "qa-kept@example.com", type: "customer" } });

  const uninstallBad = await callRoute(
    uninstalledRoute.action as never,
    webhookRequest("app/uninstalled", FRESH, { id: 1, domain: FRESH }, { badHmac: true }),
  );
  check("app/uninstalled rejects an invalid HMAC with 401", uninstallBad.status === 401, `status ${uninstallBad.status}`);
  check(
    "invalid-HMAC uninstall had no side effects (sessions intact)",
    (await db.session.count({ where: { shop: FRESH } })) === 2,
  );

  const uninstall = await callRoute(
    uninstalledRoute.action as never,
    webhookRequest("app/uninstalled", FRESH, { id: 1, domain: FRESH }),
  );
  check("app/uninstalled: valid HMAC → 200", uninstall.status === 200, `status ${uninstall.status}`);
  check("app/uninstalled responds inside the 5s budget", uninstall.ms < 5000, `${uninstall.ms}ms`);

  check(
    "all session rows deleted (revoked offline token + owner PII)",
    (await db.session.count({ where: { shop: FRESH } })) === 0,
  );
  const uninstalled = await db.shop.findUnique({ where: { id: shopId } });
  check("uninstalledAt stamped", uninstalled?.uninstalledAt instanceof Date);
  check(
    "plan fields reset to free (Shopify cancels every subscription on uninstall)",
    uninstalled?.plan === "free" &&
      uninstalled?.planStatus === "none" &&
      uninstalled?.subscriptionId === null &&
      uninstalled?.billingInterval === null &&
      uninstalled?.trialEndsAt === null &&
      uninstalled?.usageLineItemId === null,
    `${uninstalled?.plan}/${uninstalled?.planStatus}/${uninstalled?.subscriptionId}`,
  );
  check(
    "plan_changed analytics event recorded",
    (await db.analyticsEvent.count({ where: { shopId, type: "plan_changed" } })) >= 1,
  );
  check(
    "domain data retained through the 7-day grace window",
    (await db.conversation.count({ where: { shopId } })) === 1 &&
      (await db.message.count({ where: { shopId } })) === 1,
  );
  check(
    "neighbor shop untouched by the uninstall",
    (await db.session.count({ where: { shop: NEIGHBOR } })) === 1 &&
      (await db.contact.count({ where: { shopId: neighbor.id } })) === 1,
  );

  // Redelivery (Shopify retries; the session rows are already gone).
  const uninstallAgain = await callRoute(
    uninstalledRoute.action as never,
    webhookRequest("app/uninstalled", FRESH, { id: 1, domain: FRESH }),
  );
  check("app/uninstalled is redelivery-safe (200)", uninstallAgain.status === 200);
  const stampAfterRedeliver = await db.shop.findUnique({ where: { id: shopId } });
  check(
    "redelivery does not move the uninstalledAt stamp (grace clock is stable)",
    stampAfterRedeliver?.uninstalledAt?.getTime() === uninstalled?.uninstalledAt?.getTime(),
  );

  // ── Widget must render nothing for an uninstalled shop ─────────────────────
  const widgetGone = await callRoute(
    widgetConfigRoute.loader as never,
    appProxyRequest("/proxy/widget-config", FRESH),
  );
  check(
    "widget-config no longer serves an uninstalled shop (widget renders nothing)",
    widgetGone.status !== 200,
    `status ${widgetGone.status}`,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("7. shop/redact ON AN UNINSTALLED SHOP — stamp + billing backstop");
  // ═════════════════════════════════════════════════════════════════════════
  // Simulate the app/uninstalled webhook having been MISSED: uninstalledAt is
  // clear but the shop is on a paid plan and Shopify has already cancelled the
  // subscription. shop/redact is the only signal left, so it must both
  // deactivate the shop AND reset the (now dead) billing fields — otherwise a
  // reinstall inside the grace window resurrects a paid plan for free.
  await db.shop.update({
    where: { id: shopId },
    data: {
      uninstalledAt: null,
      plan: "pro",
      planStatus: "active",
      subscriptionId: "gid://shopify/AppSubscription/dead",
      billingInterval: "monthly",
      usageLineItemId: "gid://shopify/AppSubscriptionLineItem/dead",
    },
  });
  const shopRedact = await callRoute(
    complianceRoute.action as never,
    webhookRequest("shop/redact", FRESH, { shop_domain: FRESH }),
  );
  check("shop/redact on an uninstalled shop → 200", shopRedact.status === 200, `status ${shopRedact.status}`);
  check("shop/redact responds inside the 5s budget", shopRedact.ms < 5000, `${shopRedact.ms}ms`);
  const afterShopRedact = await db.shop.findUnique({ where: { id: shopId } });
  check("shop/redact stamps uninstalledAt", afterShopRedact?.uninstalledAt instanceof Date);
  check(
    "shop/redact also resets the dead subscription (no free paid plan on reinstall)",
    afterShopRedact?.plan === "free" &&
      afterShopRedact?.planStatus === "none" &&
      afterShopRedact?.subscriptionId === null &&
      afterShopRedact?.usageLineItemId === null,
    `${afterShopRedact?.plan}/${afterShopRedact?.planStatus}/${afterShopRedact?.subscriptionId}`,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("8. REINSTALL — inside the 7-day grace window");
  // ═════════════════════════════════════════════════════════════════════════
  await db.syncState.upsert({
    where: { shopId },
    create: { shopId, productSyncAt: new Date(Date.now() - 60_000) },
    update: { productSyncAt: new Date(Date.now() - 60_000) },
  });
  await db.$executeRaw`DELETE FROM pgboss.job WHERE data->>'shopDomain' = ${FRESH}`;

  await onShopAuthenticated(FRESH);
  const reinstalled = await db.shop.findUnique({ where: { id: shopId } });
  check("reinstall clears uninstalledAt", reinstalled?.uninstalledAt === null);
  check(
    "reinstall does NOT resume the cancelled subscription",
    reinstalled?.plan === "free" &&
      reinstalled?.planStatus === "none" &&
      reinstalled?.subscriptionId === null &&
      reinstalled?.billingInterval === null &&
      reinstalled?.trialEndsAt === null &&
      reinstalled?.usageLineItemId === null,
    `${reinstalled?.plan}/${reinstalled?.planStatus}/${reinstalled?.subscriptionId}`,
  );
  check(
    "retained data restored on reinstall (transcripts survived)",
    (await db.conversation.count({ where: { shopId } })) === 1 &&
      (await db.message.count({ where: { shopId, content: "KEPT-ACROSS-REINSTALL" } })) === 1,
  );
  check(
    "reinstall does not duplicate the default config",
    (await db.persona.count({ where: { shopId } })) === 1 &&
      (await db.guardrails.count({ where: { shopId } })) === 1 &&
      (await db.recommendation.count({ where: { shopId } })) === 2,
  );
  const reEnqueued = await db.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM pgboss.job WHERE data->>'shopDomain' = ${FRESH}
  `;
  check(
    "reinstall re-syncs the catalog (changes went unobserved while uninstalled)",
    reEnqueued.some((row) => row.name === "catalog-sync"),
    reEnqueued.map((r) => r.name).join(",") || "none",
  );
  check(
    "no install-once flag blocks a reinstall (App Store req 2.3.4)",
    reinstalled !== null && reinstalled.uninstalledAt === null,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("9. RETENTION PURGE — cleanupShop must zero EVERY shop-scoped table");
  // ═════════════════════════════════════════════════════════════════════════
  // Seed the two tables that the fresh-install path never creates but that a
  // real shop accumulates, so the zero-row assertion is meaningful.
  const promo = await db.promoCode.create({
    data: {
      code: `QA-INSTALL-${Date.now()}`,
      kind: "percent",
      value: 10,
      plans: [],
      intervals: [],
    },
  });
  await db.promoRedemption.create({
    data: { shopId, promoCodeId: promo.id, plan: "pro", interval: "monthly", status: "redeemed" },
  });
  await db.productMetafieldDefinition.create({
    data: { shopId, ownerType: "PRODUCT", namespace: "qa", key: "install", name: "QA", type: "single_line_text_field" },
  });
  await db.session.create({
    data: { id: `offline_${FRESH}_2`, shop: FRESH, state: "qa", accessToken: "qa", isOnline: false },
  });

  await db.shop.update({ where: { id: shopId }, data: { uninstalledAt: new Date() } });
  await cleanupShop(FRESH);

  const leftovers = await countShopRows(shopId, FRESH);
  check(
    "countShopRows() reports zero leftovers after cleanupShop",
    leftovers.length === 0,
    JSON.stringify(leftovers),
  );
  check(
    "promo redemptions purged with the shop (no orphan rows)",
    (await db.promoRedemption.count({ where: { shopId } })) === 0,
  );
  check(
    "product metafield definitions purged with the shop",
    (await db.productMetafieldDefinition.count({ where: { shopId } })) === 0,
  );
  check("sessions purged with the shop", (await db.session.count({ where: { shop: FRESH } })) === 0);
  const purged = await db.shop.findUnique({ where: { id: shopId } });
  check("shop row kept + still stamped uninstalled", purged?.uninstalledAt instanceof Date);
  check("shop billing fields reset by the purge", purged?.plan === "free" && purged?.subscriptionId === null);
  check(
    "RedactLog(type=shop) audit row written",
    (await db.redactLog.count({ where: { shopId, type: "shop", completedAt: { not: null } } })) >= 1,
  );
  check(
    "neighbor shop fully intact after the purge (tenancy)",
    (await db.contact.count({ where: { shopId: neighbor.id } })) === 1 &&
      (await db.session.count({ where: { shop: NEIGHBOR } })) === 1,
  );

  // A purged shop must still be reinstallable (Shopify allows it forever).
  await onShopAuthenticated(FRESH);
  const afterPurgeReinstall = await db.shop.findUnique({ where: { id: shopId } });
  check("a fully purged shop can reinstall", afterPurgeReinstall?.uninstalledAt === null);
  check(
    "reinstall after purge re-seeds the default config",
    (await db.persona.count({ where: { shopId } })) === 1 &&
      (await db.guardrails.count({ where: { shopId } })) === 1 &&
      (await db.recommendation.count({ where: { shopId } })) === 2,
  );

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section("Cleaning up throwaway shops…");
  await db.promoRedemption.deleteMany({ where: { shopId } });
  await db.promoCode.delete({ where: { id: promo.id } }).catch(() => undefined);
  await wipe();
  await db.$executeRaw`DELETE FROM pgboss.job WHERE data->>'shopDomain' IN (${FRESH}, ${NEIGHBOR})`;
  console.log("  removed", ALL_DOMAINS.join(", "));
}

let exitCode = 0;
main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    console.log(
      `\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECK(S) FAILED`}`,
    );
    exitCode = failures === 0 ? 0 : 1;
    // Tear down BOTH singletons or the process never exits: onShopAuthenticated
    // enqueues jobs, which starts the shared pg-boss poller.
    try {
      const { getQueue } = await import("../../app/lib/jobs/queue.server");
      if (global.pgBossGlobal) {
        await Promise.race([
          getQueue().boss.stop({ graceful: false }),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
    } catch {
      /* queue never started */
    }
    const { default: db } = await import("../../app/db.server");
    await db.$disconnect();
    process.exit(exitCode);
  });
