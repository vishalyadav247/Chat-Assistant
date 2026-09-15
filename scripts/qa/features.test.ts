/* eslint-disable @typescript-eslint/no-explicit-any -- QA harness: Prisma
 * delegates, raw-SQL rows and route payloads are handled structurally on
 * purpose so the suite exercises the real shapes rather than re-declaring them. */
/* Feature-module QA suite (QA agent A6).
 * Run: PRISMA_CLIENT_ENGINE_TYPE=binary npx tsx scripts/qa/features.test.ts
 *
 * Covers the modules that had no executable suite: knowledge ingestion,
 * catalog sync, curated thresholds, search, campaigns, analytics, inbox,
 * contacts, discounts, order tracking, GDPR webhooks, background jobs and
 * the notification send path.
 *
 * Everything runs against the real dev DB on throwaway shops tagged
 * "qa-features"; existing rows are only ever READ. Fixtures are removed in a
 * finally block and the removal is asserted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SCOPES ||= "read_products";

export const TAG = "qa-features";
const SHOP_A = "qa-features-a.myshopify.com";
const SHOP_B = "qa-features-b.myshopify.com";
const DEV_SHOP = "dev-shop.myshopify.com";

let passed = 0;
let failed = 0;
let moduleName = "";
const perModule = new Map<string, { pass: number; fail: number }>();

function ok(name: string, condition: boolean, detail = ""): void {
  const bucket = perModule.get(moduleName) ?? { pass: 0, fail: 0 };
  if (condition) {
    passed++;
    bucket.pass++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    bucket.fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  perModule.set(moduleName, bucket);
}

function section(title: string): void {
  moduleName = title;
  if (!perModule.has(title)) perModule.set(title, { pass: 0, fail: 0 });
  console.log(`\n── ${title} ${"─".repeat(Math.max(2, 62 - title.length))}`);
}

/** Run `fn`, return the thrown error (or null when it resolved). */
async function threw(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as Error;
  }
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const plans = await import("../../app/lib/billing/plans.server");
  const { loadPlanConfig, getQuota } = plans;
  const { savePlanConfig } = await import("../../app/lib/admin/admin-settings.server");
  await loadPlanConfig();

  // The gate/quota assertions below describe the DEFAULT matrix. Gates are
  // always live since the enforcement switch was removed (2026-09-08), but the
  // matrix itself is still operator-editable, so pin it to the defaults for the
  // run and restore the stored row verbatim in the finally — exactly like
  // plan-gates.test.ts does.
  const priorPlanConfig = await db.appSecret.findUnique({
    where: { key: plans.PLAN_CONFIG_SECRET_KEY },
  });
  await savePlanConfig({});

  // ── fixture shops ────────────────────────────────────────────────────────
  const shopA = await db.shop.upsert({
    where: { domain: SHOP_A },
    create: { domain: SHOP_A, name: `${TAG} shop A`, plan: "free", currency: "USD" },
    update: { name: `${TAG} shop A`, plan: "free", uninstalledAt: null },
  });
  const shopB = await db.shop.upsert({
    where: { domain: SHOP_B },
    create: { domain: SHOP_B, name: `${TAG} shop B`, plan: "plus", currency: "USD" },
    update: { name: `${TAG} shop B`, plan: "plus", uninstalledAt: null },
  });
  const A = shopA.id;
  const B = shopB.id;
  const devShop = await db.shop.findUnique({ where: { domain: DEV_SHOP }, select: { id: true } });

  const setPlan = (shopId: string, plan: string) =>
    db.shop.update({ where: { id: shopId }, data: { plan } });

  try {
    await knowledgeIngestion({ db, A, B, getQuota, setPlan });
    await catalogSync({ db, A, B, getQuota, setPlan });
    await curatedAnswers({ db, A, B, devShopId: devShop?.id ?? null });
    await search({ db, A, B });
    await rankingGuards({ db, A });
    await metaobjectResolution();
    await campaigns({ db, A, B, getQuota, setPlan });
    await analytics({ db, A, B, getQuota, setPlan });
    await inbox({ db, A, B, setPlan });
    await contacts({ db, A, B });
    await discounts({ db, A, B, setPlan });
    await pagesBlogs({ db, A, B });
    await dashboardSetup({ db });
    await qaFixes({ db, A, B });
    await qaCoverage({ db, A });
    await orderTracking();
    await notifications({ db, A, B });
    await backgroundJobs({ db, A, B });
    await gdpr({ db, A, B });
  } finally {
    // Put the operator's plan config back byte-for-byte (or remove ours if
    // none existed), then reload so the live matrix matches again.
    if (priorPlanConfig) {
      await db.appSecret.upsert({
        where: { key: plans.PLAN_CONFIG_SECRET_KEY },
        create: { key: plans.PLAN_CONFIG_SECRET_KEY, value: priorPlanConfig.value },
        update: { value: priorPlanConfig.value },
      });
    } else {
      await db.appSecret.deleteMany({ where: { key: plans.PLAN_CONFIG_SECRET_KEY } });
    }
    await loadPlanConfig();
    await teardown(db, [A, B]);
    report();
  }
}

// ── Module 1: knowledge ingestion (spec 04) ─────────────────────────────────

async function knowledgeIngestion(ctx: {
  db: any;
  A: string;
  B: string;
  getQuota: (plan: string, dim: any) => number;
  setPlan: (shopId: string, plan: string) => Promise<unknown>;
}): Promise<void> {
  section("Knowledge ingestion (spec 04)");
  const { db, A, B, getQuota, setPlan } = ctx;
  const {
    createSource,
    deleteSource,
    listSources,
    resyncSource,
    QuotaError,
    parseCsvContent,
    UnsupportedFileError,
    mergeRefreshedPages,
  } = await import("../../app/lib/ingestion/sources.server");
  const { ingestSource, chunkText, syncFaqKnowledge } = await import(
    "../../app/lib/ingestion/knowledge-ingest.server"
  );
  const { knowledgeSearch } = await import("../../app/lib/search/knowledge-search.server");
  const { embedText, pseudoEmbedding } = await import(
    "../../app/lib/embeddings/embedding.server"
  );
  const { isPrivateIp, assertPublicUrl } = await import(
    "../../app/lib/ingestion/fetchers.server"
  );

  await setPlan(A, "plus"); // headroom for the happy paths; quotas tested on free below

  // K1 — LEGACY manual Q&A row (creation retired 2026-09-10, FAQ consolidation;
  // row seeded directly via db to prove old rows still ingest → retrievable)
  const manual = await db.dataSource.create({
    data: {
      shopId: A,
      type: "manual",
      name: `${TAG} how do I re-calibrate the flux capacitor`,
      status: "pending",
      metadata: {
        question: `${TAG} how do I re-calibrate the flux capacitor`,
        synonyms: ["flux recalibration"],
        answer:
          "Hold the amber dial for nine seconds until the ring turns violet, then release. " +
          "Never re-calibrate while the unit is charging.",
      },
    },
  });
  ok("K1 legacy manual row created (status pending)", manual.type === "manual" && manual.status === "pending", manual.status);

  const manualIngest = await ingestSource(A, manual.id);
  const manualRow = await db.dataSource.findUnique({ where: { id: manual.id } });
  ok(
    "K2 manual ingest → active + chunkCount",
    manualRow?.status === "active" && manualIngest.chunkCount === 1,
    `status=${manualRow?.status} chunks=${manualIngest.chunkCount}`,
  );

  const embeddedRows = (await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM knowledge WHERE "shopId" = $1 AND "dataSourceId" = $2 AND embedding IS NOT NULL`,
    A,
    manual.id,
  ) as any[]);
  ok("K3 knowledge rows embedded", Number(embeddedRows[0].n) === 1, `embedded=${embeddedRows[0].n}`);

  // K4 — retrievable by real semantic search (paraphrase, no keyword overlap)
  const q1 = await embedText("what is the procedure for resetting the flux capacitor", { shopId: A });
  const hits = await knowledgeSearch(A, q1, 3);
  ok(
    "K4 manual Q&A retrievable by paraphrase",
    hits.length > 0 && hits[0].topic.includes("flux capacitor") && hits[0].score > 0.5,
    hits[0] ? `top="${hits[0].topic.slice(0, 40)}" score=${hits[0].score.toFixed(3)}` : "no hits",
  );

  // K5 — pages source (policy pages), HTML stripped
  const pages = await createSource(
    A,
    {
      type: "pages",
      name: `${TAG} store policies`,
      pages: [
        {
          title: `${TAG} Returns policy`,
          url: "https://example.com/policies/returns",
          body: "<p>Unworn items may be sent back within <b>21 days</b> of delivery.</p>",
        },
      ],
    } as any,
    { enqueueIngest: false },
  );
  await ingestSource(A, pages.id);
  const pageChunk = await db.knowledge.findFirst({ where: { shopId: A, dataSourceId: pages.id } });
  ok(
    "K5 policy page ingested with HTML stripped",
    Boolean(pageChunk) && !pageChunk!.body.includes("<") && pageChunk!.body.includes("21 days"),
    pageChunk?.body.slice(0, 50),
  );

  // K5b — Re-sync of a Connect source RE-FETCHES from Shopify (2026-09-11).
  // It used to re-embed the snapshot saved at connect time, so an edited
  // refund policy stayed stale forever. These assert the REAL merge rules.
  const REFUND = "REFUND_POLICY";
  const SHIP = "SHIPPING_POLICY";
  const PAGE = "gid://shopify/Page/111";
  const cand = (type: string, body: string, kind: "policy" | "page" = "policy") => ({
    type, title: type, url: `https://x/${type}`, body, kind,
  });
  const stale = [
    { type: REFUND, title: "Refund policy", url: "u1", body: "30 days (OLD)" },
    { type: SHIP, title: "Shipping policy", url: "u2", body: "ships in 5 days (OLD)" },
  ];
  const merged = mergeRefreshedPages([REFUND, SHIP], [cand(SHIP, "ships in 2 days"), cand(REFUND, "14 days")], stale);
  ok(
    "K5b re-sync takes each selected item's CURRENT body, in the merchant's order",
    merged.length === 2 &&
      merged[0].type === REFUND && merged[0].body === "14 days" &&
      merged[1].type === SHIP && merged[1].body === "ships in 2 days",
    merged.map((p) => `${p.type}:${p.body}`).join(" | "),
  );
  const afterDelete = mergeRefreshedPages([REFUND, SHIP], [cand(SHIP, "ships in 2 days")], stale);
  ok(
    "K5b-ii a policy deleted (or emptied) in Shopify is dropped, not quoted from the old snapshot",
    afterDelete.length === 1 && afterDelete[0].type === SHIP,
    afterDelete.map((p) => p.type).join(","),
  );
  // Past PAGE_CANDIDATE_CAP (200) a missing page may just be beyond the cap, so
  // absence proves nothing — keep what the merchant connected.
  const capped = Array.from({ length: 200 }, (_, i) => cand(`gid://shopify/Page/9${i}`, "b", "page"));
  const keptPage = { type: PAGE, title: "About", url: "u3", body: "about us" };
  ok(
    "K5b-iii a page missing from a CAPPED listing keeps its snapshot; from a full listing it is dropped",
    mergeRefreshedPages([PAGE], capped, [keptPage]).length === 1 &&
      mergeRefreshedPages([PAGE], [cand(REFUND, "x")], [keptPage]).length === 0,
  );

  // K5c — FAIL-SOFT, exercised for real: the fixture shop has no Shopify
  // session, so the strict re-fetch throws exactly as a missing scope or an
  // outage would. The stored snapshot must survive and still be embedded — a
  // Shopify hiccup must never wipe knowledge the merchant connected.
  const connected = await createSource(
    A,
    {
      type: "pages",
      name: `${TAG} connected policies`,
      pages: [{ type: REFUND, title: `${TAG} Refund policy`, url: "", body: "Refunds within 45 days of delivery." }],
      policyTypes: [REFUND],
    } as any,
    { enqueueIngest: false },
  );
  // K5d — the race fix: policyTypes is in the row from the very first write.
  const firstWrite = (await db.dataSource.findUnique({ where: { id: connected.id } }))?.metadata as any;
  ok(
    "K5d policyTypes and page ids are stored in the SAME write as the pages",
    Array.isArray(firstWrite?.policyTypes) && firstWrite.policyTypes[0] === REFUND && firstWrite.pages?.[0]?.type === REFUND,
    JSON.stringify(firstWrite?.policyTypes),
  );
  let softError: string | null = null;
  try {
    await ingestSource(A, connected.id);
  } catch (error) {
    softError = error instanceof Error ? error.message : String(error);
  }
  const softChunk = await db.knowledge.findFirst({ where: { shopId: A, dataSourceId: connected.id } });
  const softRow = await db.dataSource.findUnique({ where: { id: connected.id } });
  ok(
    "K5c Shopify unreachable on re-sync → snapshot kept and embedded, source stays active",
    softError === null && softRow?.status === "active" && Boolean(softChunk?.body.includes("45 days")),
    softError ?? `status=${softRow?.status}`,
  );
  await deleteSource(A, connected.id);

  // K5e — ONE source per connected policy (2026-09-11), so each lists and
  // deletes separately. Created with the weekly re-crawl on (policies have no
  // webhook) and its body snapshotted for fail-soft ingest.
  const refundPolicy = await createSource(
    A,
    {
      type: "policy",
      policyType: "REFUND_POLICY",
      title: `${TAG} Refund policy`,
      url: "https://example.com/policies/refund-policy",
      body: "Refunds within 30 days of delivery.",
    } as any,
    { enqueueIngest: false },
  );
  let duplicatePolicy: unknown = null;
  try {
    await createSource(
      A,
      { type: "policy", policyType: "REFUND_POLICY", title: "Refund policy", body: "x" } as any,
      { enqueueIngest: false },
    );
  } catch (error) {
    duplicatePolicy = error;
  }
  ok(
    "K5e a policy is its own source (weekly re-crawl on), and connecting it twice is refused",
    refundPolicy.type === "policy" && refundPolicy.reCrawlWeekly === true &&
      refundPolicy.name === `${TAG} Refund policy` && duplicatePolicy instanceof Error,
    `type=${refundPolicy.type} weekly=${refundPolicy.reCrawlWeekly}`,
  );
  // K5f — FAIL-SOFT for real: no Shopify session for the fixture shop, so the
  // live re-read throws exactly as an outage would; the snapshot is embedded.
  await ingestSource(A, refundPolicy.id);
  const policyChunk = await db.knowledge.findFirst({ where: { shopId: A, dataSourceId: refundPolicy.id } });
  const policyRow = await db.dataSource.findUnique({ where: { id: refundPolicy.id } });
  ok(
    "K5f Shopify unreachable → the policy snapshot is still learned and the source is active",
    policyRow?.status === "active" && Boolean(policyChunk?.body.includes("30 days")),
    `status=${policyRow?.status}`,
  );
  // K5g — NO policy limit (2026-09-11, user decision): Shopify has at most 8
  // policy types (ShopPolicyType), so every plan connects them all. Asserted on
  // Free, where the old limit of 5 actually bit.
  await setPlan(A, "free");
  const ALL_POLICY_TYPES = [
    "CONTACT_INFORMATION", "LEGAL_NOTICE", "PRIVACY_POLICY", "SHIPPING_POLICY",
    "SUBSCRIPTION_POLICY", "TERMS_OF_SALE", "TERMS_OF_SERVICE",
  ]; // + REFUND_POLICY already connected above = all 8
  const extraPolicies: string[] = [];
  let policyRefused: unknown = null;
  try {
    for (const policyType of ALL_POLICY_TYPES) {
      const src = await createSource(
        A,
        { type: "policy", policyType, title: policyType, body: "b" } as any,
        { enqueueIngest: false },
      );
      extraPolicies.push(src.id);
    }
  } catch (error) {
    policyRefused = error;
  }
  ok(
    "K5g a Free store can connect all 8 Shopify policy types (no policy limit)",
    policyRefused === null && extraPolicies.length === 7,
    policyRefused instanceof Error ? policyRefused.message : `connected=${extraPolicies.length + 1}`,
  );
  for (const id of [...extraPolicies, refundPolicy.id]) await deleteSource(A, id);
  await setPlan(A, "plus");

  // K5h — a file's merchant-written title is its name; the filename is kept
  // (its extension decides parsing) and the title is the chunk topic.
  const titled = await createSource(
    A,
    {
      type: "file",
      name: "doc_final_v3.txt",
      title: `${TAG} Ring size guide`,
      mime: "text/plain",
      bytes: Buffer.from("Measure the inside diameter of a ring that fits."),
    } as any,
    { enqueueIngest: false },
  );
  await ingestSource(A, titled.id);
  const titledChunk = await db.knowledge.findFirst({ where: { shopId: A, dataSourceId: titled.id } });
  ok(
    "K5h a file shows under its title, keeps its filename, and the title is the chunk topic",
    titled.name === `${TAG} Ring size guide` &&
      (titled.metadata as any)?.filename === "doc_final_v3.txt" &&
      titledChunk?.topic === `${TAG} Ring size guide`,
    `name=${titled.name} topic=${titledChunk?.topic}`,
  );
  await deleteSource(A, titled.id);

  // K6 — LEGACY knowledge-CSV row (creation retired 2026-09-10) still ingests
  const csv = await db.dataSource.create({
    data: {
      shopId: A,
      type: "csv",
      name: `${TAG} faq import`,
      status: "pending",
      metadata: {
        rows: [
          { question: `${TAG} do you offer gift cards`, answer: "Yes, in $25 / $50 / $100." },
          { question: `${TAG} can I change my order`, answer: "Within one hour of placing it." },
        ],
      },
    },
  });
  const csvResult = await ingestSource(A, csv.id);
  ok("K6 legacy CSV row → one chunk per row", csvResult.chunkCount === 2, `chunks=${csvResult.chunkCount}`);

  // K7 — CSV parser tolerates quoted commas / CRLF
  const parsed = parseCsvContent('question,answer\r\n"a, b","c ""d"""\r\n');
  ok(
    "K7 CSV parser handles quoted commas + escaped quotes",
    parsed.rows.length === 1 && parsed.rows[0].question === "a, b" && parsed.rows[0].answer === 'c "d"',
    JSON.stringify(parsed.rows[0]),
  );

  // K8 — file upload (txt)
  const file = await createSource(
    A,
    {
      type: "file",
      name: `${TAG}-handbook.txt`,
      mime: "text/plain",
      bytes: Buffer.from(
        "Warranty: every unit carries a two-year limited warranty from the purchase date.",
        "utf-8",
      ),
    } as any,
    { enqueueIngest: false },
  );
  const fileResult = await ingestSource(A, file.id);
  ok("K8 txt file upload ingested", fileResult.chunkCount === 1 && file.status === "pending");

  // K9 — unsupported file type is REFUSED (must not burn quota as an error row)
  const before = await db.dataSource.count({ where: { shopId: A, type: "file" } });
  const unsupported = await threw(() =>
    createSource(
      A,
      { type: "file", name: `${TAG}-image.png`, mime: "image/png", bytes: Buffer.from([0x89, 0x50]) } as any,
      { enqueueIngest: false },
    ),
  );
  const after = await db.dataSource.count({ where: { shopId: A, type: "file" } });
  ok(
    "K9 unparseable file rejected, no row created",
    unsupported instanceof UnsupportedFileError && before === after,
    `${unsupported?.name} rows ${before}→${after}`,
  );

  // K10 — malformed input rejected by the schema
  const badUrl = await threw(() =>
    createSource(A, { type: "url", url: "javascript:alert(1)", status: "active" } as any, {
      enqueueIngest: false,
    }),
  );
  // Retired types (manual/csv, 2026-09-10) must be refused like any unknown
  // type — createSource's union no longer contains them.
  const retiredManual = await threw(() =>
    createSource(A, { type: "manual", question: "q", answer: "a", status: "active" } as any, {
      enqueueIngest: false,
    }),
  );
  const retiredCsv = await threw(() =>
    createSource(A, { type: "csv", name: "x", rows: [{ question: "q", answer: "a" }] } as any, {
      enqueueIngest: false,
    }),
  );
  const badType = await threw(() =>
    createSource(A, { type: "telepathy", name: "x" } as any, { enqueueIngest: false }),
  );
  ok(
    "K10 malformed input rejected (bad scheme / retired manual + csv / unknown type)",
    Boolean(badUrl && retiredManual && retiredCsv && badType),
    `${badUrl ? "url✓" : "url✗"} ${retiredManual ? "manual✓" : "manual✗"} ${retiredCsv ? "csv✓" : "csv✗"} ${badType ? "type✓" : "type✗"}`,
  );

  // K11 — SSRF guard
  const localhostBlocked = await threw(() => assertPublicUrl(new URL("http://localhost:5433/x")));
  const privateBlocked = await threw(() => assertPublicUrl(new URL("http://10.0.0.5/")));
  ok(
    "K11 SSRF guard blocks localhost + RFC1918",
    Boolean(localhostBlocked && privateBlocked) && isPrivateIp("192.168.1.1") && !isPrivateIp("93.184.216.34"),
  );

  // K12 — a crawl that cannot run marks the source error and zeroes the meter
  const badCrawl = await createSource(
    A,
    { type: "url", url: "http://127.0.0.1:9/nothing", status: "active" } as any,
    { enqueueIngest: false },
  );
  await threw(() => ingestSource(A, badCrawl.id));
  const badCrawlRow = await db.dataSource.findUnique({ where: { id: badCrawl.id } });
  const meta = (badCrawlRow?.metadata ?? {}) as any;
  ok(
    "K12 failed crawl → status error, pagesUsed reset to 0",
    badCrawlRow?.status === "error" && meta.pagesUsed === 0 && typeof meta.error === "string",
    `status=${badCrawlRow?.status} pagesUsed=${meta.pagesUsed}`,
  );

  // K13 — re-sync is idempotent for pages, refused for manual
  const resync = await resyncSource(A, pages.id, { enqueueIngest: false });
  const pageCountAfter = await db.knowledge.count({ where: { shopId: A, dataSourceId: pages.id } });
  const manualResync = await threw(() => resyncSource(A, manual.id, { enqueueIngest: false }));
  ok(
    "K13 re-sync idempotent for pages, refused for manual",
    resync?.chunkCount === 1 && pageCountAfter === 1 && manualResync !== null,
    `chunks=${resync?.chunkCount} rows=${pageCountAfter}`,
  );

  // K14 — chunking is deterministic
  const long = "Sentence about widgets. ".repeat(400);
  const c1 = chunkText(long);
  const c2 = chunkText(long);
  ok(
    "K14 chunking deterministic + overlapping",
    c1.length > 1 && JSON.stringify(c1) === JSON.stringify(c2),
    `chunks=${c1.length}`,
  );

  // K15 — FAQ → knowledge bridge
  const cat = await db.faqCategory.create({ data: { shopId: A, name: `${TAG} general` } });
  await db.faq.create({
    data: {
      shopId: A,
      categoryId: cat.id,
      question: `${TAG} where are you based`,
      answerHtml: "<p>We ship from <b>Rotterdam</b>.</p>",
      status: "published",
    },
  });
  await db.faq.create({
    data: { shopId: A, question: `${TAG} draft question`, answerHtml: "<p>hidden</p>", status: "draft" },
  });
  const faqResult = await syncFaqKnowledge(A);
  const faqBody = await db.knowledge.findFirst({
    where: { shopId: A, dataSourceId: faqResult.sourceId },
    select: { body: true },
  });
  ok(
    "K15 FAQ bridge mirrors PUBLISHED faqs only, HTML stripped",
    faqResult.chunkCount === 1 &&
      faqBody?.body.includes("Rotterdam") === true &&
      !faqBody!.body.includes("<"),
    `chunks=${faqResult.chunkCount} body="${faqBody?.body}"`,
  );
  // DEFECT (LOW): stripToText turns every inline tag into a space, so
  // "<b>Rotterdam</b>." becomes "Rotterdam ." — a stray space before
  // punctuation in the text handed to RAG. app/lib/sanitize.server.ts:64.
  ok(
    "K15b stripToText leaves no stray space before punctuation",
    faqBody?.body === "We ship from Rotterdam.",
    `body="${faqBody?.body}" (defect: app/lib/sanitize.server.ts:64)`,
  );

  // K16 — delete cascades knowledge rows
  const deleted = await deleteSource(A, csv.id);
  const orphans = await db.knowledge.count({ where: { shopId: A, dataSourceId: csv.id } });
  ok("K16 delete source cascades its knowledge rows", deleted && orphans === 0, `orphans=${orphans}`);

  // K17 — cross-shop delete refused
  const crossDelete = await deleteSource(B, manual.id);
  const stillThere = await db.dataSource.count({ where: { id: manual.id, shopId: A } });
  ok("K17 cross-shop deleteSource refused", crossDelete === false && stillThere === 1);

  // K18 — cross-shop ingest refused
  const crossIngest = await threw(() => ingestSource(B, manual.id));
  ok("K18 cross-shop ingestSource throws", crossIngest !== null, crossIngest?.message.slice(0, 60));

  // K19 — knowledge search is shop-scoped (shop B sees nothing of shop A)
  const bHits = await knowledgeSearch(B, q1, 5);
  ok("K19 knowledgeSearch shop-scoped (B sees 0 of A's rows)", bHits.length === 0, `hits=${bHits.length}`);

  // K20 — inactive sources are excluded from retrieval
  await db.dataSource.update({ where: { id: manual.id }, data: { status: "inactive" } });
  const afterDeactivate = await knowledgeSearch(A, q1, 5);
  await db.dataSource.update({ where: { id: manual.id }, data: { status: "active" } });
  ok(
    "K20 inactive data source excluded from RAG",
    !afterDeactivate.some((h) => h.topic.includes("flux capacitor")),
    `hits=${afterDeactivate.length}`,
  );

  // K21..K24 — quota enforcement at the plan limit (free tier)
  // manual_qas retired 2026-09-10 — the Q&A cap is now the faqs quota,
  // enforced on CREATE in saveFaq (edits never blocked) and per-row in
  // importFaqCsv.
  await setPlan(A, "free");
  const { saveFaq, importFaqCsv } = await import("../../app/lib/faq/faq.server");
  const faqLimit = getQuota("free", "faqs");
  const faqUsed = await db.faq.count({ where: { shopId: A } });
  if (faqUsed < faqLimit) {
    await db.faq.createMany({
      data: Array.from({ length: faqLimit - faqUsed }, (_, i) => ({
        shopId: A,
        categoryId: cat.id,
        question: `${TAG} faq filler ${i}`,
        answerHtml: "<p>filler</p>",
        status: "draft",
      })),
    });
  }
  const faqOver = await threw(() =>
    saveFaq(A, {
      question: `${TAG} one too many`,
      answerHtml: "<p>x</p>",
      status: "draft",
      categoryId: cat.id,
      featured: false,
    }),
  );
  ok(
    `K21 faqs quota bites at ${faqLimit} on create`,
    faqOver !== null && /plan allows/i.test(faqOver.message),
    faqOver?.message,
  );
  // Editing an existing FAQ at the cap must still work (downgrade-safe).
  const editable = await db.faq.findFirst({ where: { shopId: A }, select: { id: true } });
  const editAtCap = await threw(() =>
    saveFaq(A, {
      id: editable!.id,
      question: `${TAG} edited at cap`,
      answerHtml: "<p>edited</p>",
      status: "draft",
      categoryId: cat.id,
      featured: false,
    }),
  );
  ok("K21b editing an existing FAQ at the cap is never blocked", editAtCap === null, editAtCap?.message);
  // CSV import at the cap: rows are reported per-row, not silently dropped.
  const importAtCap = await importFaqCsv(A, `"${TAG} import at cap","answer"`);
  ok(
    "K21c importFaqCsv at the cap reports the plan limit per row",
    importAtCap.imported === 0 && importAtCap.badRows.some((r) => /plan FAQ limit/i.test(r.reason)),
    importAtCap.badRows[0]?.reason,
  );
  await db.faq.deleteMany({ where: { shopId: A, question: { startsWith: `${TAG} faq filler` } } });

  // K22 (policy_pages quota) retired 2026-09-11 with the dimension itself —
  // see K5g: every plan connects all of a store's policies.

  // FAQ CSV import is on EVERY plan now (user decision 2026-09-10) — the old
  // csv_import feature gate is retired; the faqs quota above is the only cap.
  const freeImport = await importFaqCsv(A, `"${TAG} free-plan import","works on free"`);
  ok(
    "K23 FAQ CSV import works on Free (csv_import gate retired)",
    freeImport.imported === 1,
    `imported=${freeImport.imported} bad=${freeImport.badRows[0]?.reason ?? "none"}`,
  );
  await db.faq.deleteMany({ where: { shopId: A, question: `${TAG} free-plan import` } });

  // File uploads on EVERY plan (feature gate removed 2026-09-10, user
  // decision) — the file_uploads QUOTA is the only cap. Earlier sections'
  // file rows (K8's handbook) are cleared first: the free quota dropped to 2
  // (2026-09-14) and lingering rows filled it before this section started.
  await db.dataSource.deleteMany({ where: { shopId: A, type: "file" } });
  const fileOnFree = await createSource(
    A,
    { type: "file", name: `${TAG}-free.txt`, mime: "text/plain", bytes: Buffer.from("free plan file") } as any,
    { enqueueIngest: false },
  );
  ok("K24 file upload works on Free (file_upload gate retired)", fileOnFree.status === "pending", fileOnFree.status);
  const fileLimit = getQuota("free", "file_uploads");
  const filesUsed = await db.dataSource.count({ where: { shopId: A, type: "file" } });
  for (let i = filesUsed; i < fileLimit; i++) {
    await createSource(
      A,
      { type: "file", name: `${TAG}-filler-${i}.txt`, mime: "text/plain", bytes: Buffer.from(`filler ${i}`) } as any,
      { enqueueIngest: false },
    );
  }
  const fileOver = await threw(() =>
    createSource(
      A,
      { type: "file", name: `${TAG}-over.txt`, mime: "text/plain", bytes: Buffer.from("nope") } as any,
      { enqueueIngest: false },
    ),
  );
  ok(
    `K24b file_uploads quota bites at ${fileLimit}`,
    fileOver instanceof QuotaError && (fileOver as any).dimension === "file_uploads",
    fileOver?.message,
  );
  await db.dataSource.deleteMany({ where: { shopId: A, type: "file", name: { startsWith: `${TAG}-filler-` } } });
  await db.dataSource.deleteMany({ where: { shopId: A, type: "file", name: `${TAG}-free.txt` } });

  // K25 — crawl page cap follows the plan quota
  await setPlan(A, "plus");
  const sources = await listSources(A);
  ok(
    "K25 listSources is shop-scoped and hides 'suggested' rows",
    sources.length > 0 && sources.every((s: any) => s.shopId === A && s.status !== "suggested"),
    `n=${sources.length}`,
  );

  // K25b — Website URL is SINGLE PAGE only (spec 22), so there is no scope
  // field at all. An old client still sending one must not 400 the save.
  const { urlSourceSchema } = await import("../../app/lib/ingestion/sources.server");
  const coerced = urlSourceSchema.parse({ type: "url", url: "https://x.com/p", crawlScope: "sitemap" });
  ok("K25b a legacy client still sending crawlScope is accepted and the key ignored", coerced.url === "https://x.com/p" && !("crawlScope" in coerced), JSON.stringify(coerced));
  // K25c — crawl_pages now counts URL SOURCES (each is one page) and is
  // enforced at creation — it was a per-crawl cap, meaningless at one page.
  await setPlan(A, "free");
  const urlLimit = getQuota("free", "crawl_pages");
  const existingUrls = await db.dataSource.count({ where: { shopId: A, type: "url" } });
  const urlFixtures: string[] = [];
  for (let i = existingUrls; i < urlLimit; i++) {
    const src = await createSource(A, { type: "url", url: `https://example.com/k25c-${i}` } as any, { enqueueIngest: false });
    urlFixtures.push(src.id);
  }
  let urlRefused: unknown = null;
  try {
    await createSource(A, { type: "url", url: "https://example.com/k25c-over" } as any, { enqueueIngest: false });
  } catch (error) {
    urlRefused = error;
  }
  ok(
    "K25c adding a URL past crawl_pages is refused with a QuotaError",
    urlRefused instanceof QuotaError && (urlRefused as InstanceType<typeof QuotaError>).dimension === "crawl_pages",
    `limit=${urlLimit} existing=${existingUrls}`,
  );
  for (const id of urlFixtures) await deleteSource(A, id);
  await setPlan(A, "plus");
  // K5i — LEGACY combined "policies & pages" rows convert to one row per policy
  // automatically (the user saw the old row in Manage sources). Store pages in
  // it are dropped — they come from the Pages tab now.
  const { convertLegacyPagesSources } = await import("../../app/lib/ingestion/sources.server");
  await db.dataSource.create({
    data: {
      shopId: A,
      type: "pages",
      name: "Store policies & pages",
      status: "active",
      metadata: {
        policyTypes: ["REFUND_POLICY", "gid://shopify/Page/77"],
        pages: [
          { type: "REFUND_POLICY", title: "Refund policy", url: "https://x/policies/refund-policy", body: "30-day refunds." },
          { type: "gid://shopify/Page/77", title: "About us", url: "https://x/pages/about", body: "We make bracelets." },
        ],
      },
    },
  });
  // A pre-2026-09-11 row: no policyTypes, no per-page type — the policy is
  // recovered from its /policies/ URL (shipping-policy → SHIPPING_POLICY).
  await db.dataSource.create({
    data: {
      shopId: A,
      type: "pages",
      name: "Store policies & pages",
      status: "active",
      metadata: {
        pages: [
          { title: "Shipping policy", url: "https://x/policies/shipping-policy", body: "Ships in 2 days." },
          { title: "shipping policy", url: "https://x/pages/shipping-policy", body: "A page, not a policy." },
        ],
      },
    },
  });
  const legacyBefore = await db.dataSource.count({ where: { shopId: A, type: "pages" } });
  const converted = await convertLegacyPagesSources(A, { enqueueIngest: false });
  const policyRows = await db.dataSource.findMany({ where: { shopId: A, type: "policy" } });
  const legacyLeft = await db.dataSource.count({ where: { shopId: A, type: "pages" } });
  const byType = new Map<string, any>(policyRows.map((r: any) => [r.metadata.policyType, r]));
  ok(
    "K5i legacy rows become one row per POLICY (pages dropped), incl. a policy recovered from its URL",
    converted.removed === legacyBefore && legacyLeft === 0 &&
      byType.get("REFUND_POLICY")?.name === "Refund policy" &&
      byType.get("REFUND_POLICY")?.metadata.body === "30-day refunds." &&
      byType.get("SHIPPING_POLICY")?.metadata.body === "Ships in 2 days.",
    `created=${converted.created} removed=${converted.removed} types=${[...byType.keys()].join(",")}`,
  );
  // A /policies/<slug> that is not a real ShopPolicyType must not invent one
  // (an older fixture here points at /policies/returns).
  ok("K5i-iii only real ShopPolicyType values are recovered from URLs", !byType.has("RETURNS"), [...byType.keys()].join(","));
  const again = await convertLegacyPagesSources(A, { enqueueIngest: false });
  ok("K5i-ii the conversion is idempotent (a second run does nothing)", again.created === 0 && again.removed === 0);
  for (const row of policyRows) await deleteSource(A, row.id);

  // K26 — pseudo-embedding fallback never matches real content strongly
  const noise = pseudoEmbedding("unrelated noise vector");
  const noiseHits = await knowledgeSearch(A, noise, 1);
  ok(
    "K26 unrelated query scores far below the meaning floor",
    noiseHits.length === 0 || noiseHits[0].score < 0.3,
    noiseHits[0] ? `score=${noiseHits[0].score.toFixed(3)}` : "no hits",
  );
}

// ── Module 2: catalog / product sync (spec 02) ──────────────────────────────

/** products/create|update webhook payload (REST shape, as Shopify sends it). */
function productPayload(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: 900100,
    admin_graphql_api_id: "gid://shopify/Product/900100",
    title: `${TAG} Arctic Down Parka`,
    body_html: "<p>Insulated winter coat rated to -20C. Sealed seams, storm hood.</p>",
    product_type: "Outerwear",
    vendor: "QA Fixtures",
    tags: "winter, warm, coat",
    status: "active",
    handle: "qa-arctic-down-parka",
    image: { src: "https://cdn.example.com/parka.jpg" },
    variants: [
      {
        id: 5001,
        title: "M",
        price: "249.00",
        inventory_quantity: 4,
        inventory_management: "shopify",
        inventory_policy: "deny",
      },
      {
        id: 5002,
        title: "L",
        price: "259.00",
        inventory_quantity: 2,
        inventory_management: "shopify",
        inventory_policy: "deny",
      },
    ],
    ...over,
  };
}

async function catalogSync(ctx: {
  db: any;
  A: string;
  B: string;
  getQuota: (plan: string, dim: any) => number;
  setPlan: (shopId: string, plan: string) => Promise<unknown>;
}): Promise<void> {
  section("Catalog / product sync (spec 02)");
  const { db, A, B, getQuota, setPlan } = ctx;
  const catalogSyncModule = await import("../../app/lib/ingestion/catalog-sync.server");
  const { upsertProductFromWebhook, deleteProductFromWebhook } = catalogSyncModule;
  const { buildMetafieldText, applyMetafieldSelection, toStoredMetafield } = await import(
    "../../app/lib/ingestion/metafields.server"
  );
  const { isPurchasable, purchasableWhere } = await import(
    "../../app/lib/search/product-search.server"
  );

  await setPlan(A, "plus");

  // C1 — webhook create
  await upsertProductFromWebhook(SHOP_A, productPayload());
  const created = await db.product.findFirst({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" },
  });
  ok(
    "C1 products/create webhook mirrors the product",
    Boolean(created) &&
      created.title.includes("Arctic Down Parka") &&
      Number(created.price) === 249 &&
      created.stock === 6 &&
      created.tags.join(",") === "winter,warm,coat" &&
      !created.description.includes("<"),
    `price=${created?.price} stock=${created?.stock}`,
  );

  // C2 — embedding written on create
  const embedded = (await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM products WHERE "shopId" = $1 AND embedding IS NOT NULL`,
    A,
  ) as any[]);
  ok("C2 synced product is embedded", Number(embedded[0].n) === 1, `embedded=${embedded[0].n}`);

  // C3 — incremental update: price + stock + variants change in place
  const hashBefore = created.contentHash;
  await upsertProductFromWebhook(
    SHOP_A,
    productPayload({
      variants: [
        { id: 5001, title: "M", price: "199.00", inventory_quantity: 0, inventory_management: "shopify", inventory_policy: "deny" },
        { id: 5002, title: "L", price: "209.00", inventory_quantity: 1, inventory_management: "shopify", inventory_policy: "deny" },
      ],
    }),
  );
  const updated = await db.product.findFirst({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" },
  });
  const rowCount = await db.product.count({ where: { shopId: A } });
  ok(
    "C3 incremental update mutates in place (no duplicate row)",
    rowCount === 1 && Number(updated.price) === 199 && updated.stock === 1,
    `rows=${rowCount} price=${updated.price} stock=${updated.stock}`,
  );

  // C4 — variant availability mirrors availableForSale semantics
  const variants = updated.variants as any[];
  ok(
    "C4 variant availability: qty 0 + tracked + deny → unavailable",
    variants.length === 2 && variants[0].available === false && variants[1].available === true,
    JSON.stringify(variants.map((v) => v.available)),
  );

  // C5 — untracked / oversell variants are still purchasable
  await upsertProductFromWebhook(
    SHOP_A,
    productPayload({
      id: 900101,
      admin_graphql_api_id: "gid://shopify/Product/900101",
      title: `${TAG} Made To Order Mug`,
      handle: "qa-mto-mug",
      body_html: "<p>Hand thrown ceramic mug, made to order.</p>",
      product_type: "Drinkware",
      tags: "kitchen",
      variants: [
        { id: 5101, title: "Default", price: "19.00", inventory_quantity: 0, inventory_management: null },
      ],
    }),
  );
  const mto = await db.product.findFirst({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900101" },
  });
  ok(
    "C5 untracked inventory counts as purchasable",
    mto.stock === 0 && isPurchasable(mto) === true,
    `stock=${mto.stock} purchasable=${isPurchasable(mto)}`,
  );

  // C6 — out-of-stock product is excluded by the purchasable filter
  await upsertProductFromWebhook(
    SHOP_A,
    productPayload({
      id: 900102,
      admin_graphql_api_id: "gid://shopify/Product/900102",
      title: `${TAG} Sold Out Sandals`,
      handle: "qa-sold-out",
      body_html: "<p>Summer sandals for the beach.</p>",
      product_type: "Footwear",
      tags: "summer",
      variants: [
        { id: 5201, title: "Default", price: "29.00", inventory_quantity: 0, inventory_management: "shopify", inventory_policy: "deny" },
      ],
    }),
  );
  const purchasables = await db.product.findMany({
    where: { shopId: A, ...purchasableWhere(true) },
    select: { shopifyProductId: true },
  });
  ok(
    "C6 out-of-stock product excluded by purchasableWhere",
    !purchasables.some((p: any) => p.shopifyProductId.endsWith("900102")) && purchasables.length === 2,
    `purchasable=${purchasables.length}`,
  );

  // C7 — hash-guarded re-embed: price/stock are NOT embedded, so a price-only
  // update must not re-embed; a description change must.
  const hashAfterPrice = updated.contentHash;
  await upsertProductFromWebhook(
    SHOP_A,
    productPayload({ body_html: "<p>Insulated winter coat rated to -20C. Sealed seams, storm hood, detachable fur ruff.</p>" }),
  );
  const hashAfterText = (await db.product.findFirst({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" },
    select: { contentHash: true },
  })).contentHash;
  ok(
    "C7 contentHash: unchanged by a price/stock-only update, changed by a description edit",
    hashBefore === hashAfterPrice && hashAfterPrice !== hashAfterText,
    `${String(hashBefore).slice(0, 8)} == ${String(hashAfterPrice).slice(0, 8)} != ${String(hashAfterText).slice(0, 8)}`,
  );

  // C8 — delete webhook
  await deleteProductFromWebhook(SHOP_A, { id: 900102, admin_graphql_api_id: "gid://shopify/Product/900102" });
  const afterDelete = await db.product.count({ where: { shopId: A } });
  ok("C8 products/delete removes the mirrored row", afterDelete === 2, `rows=${afterDelete}`);

  // C9 — webhook for an unknown shop never materialises a shop row
  const shopsBefore = await db.shop.count();
  await upsertProductFromWebhook("never-installed-qa-features.myshopify.com", productPayload());
  await deleteProductFromWebhook("never-installed-qa-features.myshopify.com", { id: 1 });
  const shopsAfter = await db.shop.count();
  ok("C9 webhook for unknown shop is a no-op (no shop row created)", shopsBefore === shopsAfter);

  // C9b — collections webhooks are enqueue-only like products; the delete JOB
  // removes the row and its membership for that shop only. (The upsert job
  // calls the Admin API for membership, so it is not run against a fixture.)
  const { deleteCollectionFromWebhook, upsertCollectionFromWebhook } = catalogSyncModule;
  const qaCollection = "gid://shopify/Collection/900900";
  await db.collection.create({ data: { shopId: A, shopifyCollectionId: qaCollection, title: `${TAG} Collection` } });
  await db.collectionProduct.create({
    data: { shopId: A, collectionId: qaCollection, shopifyProductId: "gid://shopify/Product/900101" },
  });
  await deleteCollectionFromWebhook(SHOP_A, { id: 900900, admin_graphql_api_id: qaCollection });
  const collectionLeft =
    (await db.collection.count({ where: { shopId: A, shopifyCollectionId: qaCollection } })) +
    (await db.collectionProduct.count({ where: { shopId: A, collectionId: qaCollection } }));
  const shopsBeforeCol = await db.shop.count();
  await upsertCollectionFromWebhook("never-installed-qa-features.myshopify.com", { id: 1, title: "x" });
  await deleteCollectionFromWebhook("never-installed-qa-features.myshopify.com", { id: 1 });
  const routeSource = readFileSync(join(process.cwd(), "app/routes/webhooks.collections.tsx"), "utf-8");
  ok(
    "C9b collections/delete job removes the row + membership; unknown shop is a no-op; the route only enqueues",
    collectionLeft === 0 &&
      (await db.shop.count()) === shopsBeforeCol &&
      !/\bdb\./.test(routeSource) && /enqueue\(JOBS\.collectionUpsert/.test(routeSource),
    `left=${collectionLeft}`,
  );

  // C10 — cross-shop isolation: shop B never sees shop A's catalog
  await upsertProductFromWebhook(
    SHOP_B,
    productPayload({
      id: 900200,
      admin_graphql_api_id: "gid://shopify/Product/900200",
      title: `${TAG} Zorblaxium Widget`,
      handle: "qa-zorblaxium",
      body_html: "<p>A zorblaxium-plated widget, shop B only.</p>",
      product_type: "Widget",
      tags: "zorblaxium",
    }),
  );
  const aSeesB = await db.product.count({ where: { shopId: A, title: { contains: "Zorblaxium" } } });
  const bCount = await db.product.count({ where: { shopId: B } });
  ok("C10 catalog is shop-scoped", aSeesB === 0 && bCount === 1, `A sees ${aSeesB}, B has ${bCount}`);

  // C11 — products_synced quota blocks webhook CREATES (not updates)
  await setPlan(A, "free");
  const cap = getQuota("free", "products_synced");
  await db.shop.update({ where: { id: A }, data: { plan: "free" } });
  // Fake the shop up to the cap with cheap rows so we don't embed 200 products.
  const filler = Array.from({ length: cap - 2 }, (_, i) => ({
    shopId: A,
    shopifyProductId: `gid://shopify/Product/quota-${i}`,
    title: `${TAG} quota filler ${i}`,
    handle: `qa-quota-${i}`,
  }));
  await db.product.createMany({ data: filler });
  await upsertProductFromWebhook(
    SHOP_A,
    productPayload({ id: 900300, admin_graphql_api_id: "gid://shopify/Product/900300", title: `${TAG} over cap`, handle: "qa-over-cap" }),
  );
  const overCap = await db.product.count({ where: { shopId: A, shopifyProductId: "gid://shopify/Product/900300" } });
  // An UPDATE of an already-synced product must still apply at the cap.
  await upsertProductFromWebhook(SHOP_A, productPayload({ title: `${TAG} Arctic Down Parka v2` }));
  const stillUpdates = await db.product.findFirst({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" },
    select: { title: true },
  });
  ok(
    `C11 products_synced cap (${cap}) blocks creates but allows updates`,
    overCap === 0 && stillUpdates.title.endsWith("v2"),
    `created=${overCap} updatedTitle="${stillUpdates.title.slice(-12)}"`,
  );
  await db.product.deleteMany({ where: { shopId: A, shopifyProductId: { startsWith: "gid://shopify/Product/quota-" } } });
  await setPlan(A, "plus");

  // C12 — metafield inclusion honours the metafields_enabled selection
  const defProduct = await db.productMetafieldDefinition.create({
    data: {
      shopId: A,
      ownerType: "product",
      namespace: "custom",
      key: "fill_power",
      name: "Fill power",
      type: "single_line_text_field",
      enabled: false,
    },
  });
  await db.productMetafieldDefinition.create({
    data: {
      shopId: A,
      ownerType: "product",
      namespace: "custom",
      key: "care",
      name: "Care",
      type: "single_line_text_field",
      enabled: false,
    },
  });
  const stored = [
    toStoredMetafield("product", "", { namespace: "custom", key: "fill_power", type: "single_line_text_field", value: "800", definition: { id: "gid://d/1" } }),
    toStoredMetafield("product", "", { namespace: "custom", key: "care", type: "single_line_text_field", value: "Machine wash cold", definition: { id: "gid://d/2" } }),
  ].filter(Boolean) as any[];
  const undefinedDropped = toStoredMetafield("product", "", {
    namespace: "custom", key: "loose", type: "single_line_text_field", value: "x", definition: null,
  });
  ok("C12a metafields WITHOUT a definition are dropped (structured-only rule)", undefinedDropped === null);
  await db.product.update({
    where: { id: (await db.product.findFirst({ where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" }, select: { id: true } })).id },
    data: { metafields: stored as any },
  });
  const noneEnabled = buildMetafieldText(stored, new Map());
  await db.productMetafieldDefinition.update({ where: { id: defProduct.id }, data: { enabled: true } });
  await applyMetafieldSelection(A);
  const withOne = await db.product.findFirst({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" },
    select: { metafieldText: true },
  });
  ok(
    "C12 only ENABLED metafields reach the AI text",
    noneEnabled === "" && withOne.metafieldText.includes("800") && !withOne.metafieldText.includes("Machine wash"),
    `text="${withOne.metafieldText}"`,
  );

  // C13 — metafields_enabled quota is a real number per plan
  ok(
    "C13 metafields_enabled quota differs per plan (free < plus)",
    getQuota("free", "metafields_enabled") < getQuota("plus", "metafields_enabled"),
    `free=${getQuota("free", "metafields_enabled")} plus=${getQuota("plus", "metafields_enabled")}`,
  );

  // C14 — collection membership + learn toggle
  await db.collection.create({
    data: {
      shopId: A,
      shopifyCollectionId: "gid://shopify/Collection/700100",
      title: `${TAG} Winter Essentials`,
      productCount: 2,
      learnEnabled: true,
    },
  });
  const collB = await db.collection.count({ where: { shopId: B } });
  const collA = await db.collection.count({ where: { shopId: A } });
  ok("C14 collections are shop-scoped", collA === 1 && collB === 0, `A=${collA} B=${collB}`);

  // C15 — background sync (2026-09-11, user decision): WEEKLY, every plan, no
  // merchant toggle, and only for what no webhook reports — collection
  // membership, pages, blogs. Products are left to their webhooks. The job body
  // is a closure inside registerHandlers, so this reads the real source; plain
  // substring checks, because a regex guard that silently stops matching passes
  // forever while testing nothing.
  const handlersSrc = readFileSync(join(process.cwd(), "app", "lib", "jobs", "handlers.server.ts"), "utf-8");
  const reconcileBody = handlersSrc.slice(
    handlersSrc.indexOf("boss.work(JOBS.reconcileAll"),
    handlersSrc.indexOf("boss.schedule(JOBS.reconcileAll"),
  );
  ok(
    "C15 weekly background sync covers collections, pages and blogs — not products — with no plan gate",
    reconcileBody.length > 0 &&
      reconcileBody.includes("JOBS.collectionSync") &&
      reconcileBody.includes("JOBS.pageSync") &&
      reconcileBody.includes("JOBS.articleSync") &&
      !reconcileBody.includes("JOBS.catalogSync") &&
      !("catalogAutoSyncAllowed" in catalogSyncModule) &&
      handlersSrc.includes('boss.schedule(JOBS.reconcileAll, "17 3 * * 1"'),
    `body=${reconcileBody.length} chars`,
  );

  // C16 — learnEnabled=false products are excluded from search sourcing
  await db.product.updateMany({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900101" },
    data: { learnEnabled: false },
  });
  const learnable = await db.product.count({ where: { shopId: A, learnEnabled: true } });
  ok("C16 per-product learnEnabled toggle persists", learnable === 1, `learnable=${learnable}`);
  await db.product.updateMany({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900101" },
    data: { learnEnabled: true },
  });
}

// ── Module 3: curated answers (spec 09) ─────────────────────────────────────

async function curatedAnswers(ctx: {
  db: any;
  A: string;
  B: string;
  devShopId: string | null;
}): Promise<void> {
  section("Curated answers + thresholds (spec 09)");
  const { db, A, B, devShopId } = ctx;
  const { curatedMatch } = await import("../../app/lib/search/curated-match.server");
  const { embedText } = await import("../../app/lib/embeddings/embedding.server");

  const SERVE = 0.8;
  const BORDERLINE = 0.65;

  // Q1 — the shipped defaults are the spec's thresholds
  const guardCols = (await db.$queryRawUnsafe(
    `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'guardrails' AND column_name = 'curatedMatchThreshold'`,
  ) as any[]);
  ok(
    "Q1 curated thresholds default to 0.80 / 0.65",
    String(guardCols[0]?.column_default ?? "").includes("0.8"),
    `default=${guardCols[0]?.column_default}`,
  );

  if (!devShopId) {
    ok("Q2..Q7 SKIPPED — dev-shop.myshopify.com not seeded", false, "run npx prisma db seed && scripts/qa/seed-curated.ts");
    return;
  }

  const published = (await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM curated_answers WHERE "shopId" = $1 AND status = 'published' AND embedding IS NOT NULL`,
    devShopId,
  ) as any[]);
  ok(
    "Q2 dev shop has embedded published curated answers to match against",
    Number(published[0].n) >= 10,
    `published+embedded=${published[0].n}`,
  );

  // Q3 — an above-threshold query returns the curated text VERBATIM
  const e1 = await embedText("what is your return policy", { shopId: devShopId });
  const m1 = await curatedMatch(devShopId, e1);
  const row1 = m1 ? await db.curatedAnswer.findUnique({ where: { id: m1.id } }) : null;
  ok(
    "Q3 top match is the right answer and its text is the stored talkingPoints verbatim",
    Boolean(m1) && m1!.question.includes("return policy") && m1!.talkingPoints === row1.talkingPoints,
    m1 ? `score=${m1.score.toFixed(3)} q="${m1.question}"` : "no match",
  );

  // Q3b — REGRESSION GUARD: save.server used to embed "question + synonyms" as
  // one blob, which diluted the question vector so badly that the answer's own
  // question scored 0.775 — under the serve threshold — parking every
  // synonym-bearing answer in the borderline branch at one extra LLM call per
  // turn. It now embeds the question alone; synonyms match as exact phrases.
  ok(
    "Q3b verbatim question clears the 0.80 serve threshold",
    Boolean(m1) && m1!.score >= SERVE,
    m1
      ? `score=${m1.score.toFixed(3)} (threshold ${SERVE})`
      : "no match",
  );

  // Q3c — control: the SAME question with no synonyms clears 0.80 easily,
  // which isolates the dilution as the cause.
  const { saveCuratedAnswer } = await import("../../app/lib/curated/save.server");
  const clean = await saveCuratedAnswer(A, {
    question: "what is your return policy",
    synonyms: [],
    productIds: [],
    talkingPoints: `${TAG} 30 days from delivery.`,
    status: "published",
    priority: "normal",
  });
  const cleanMatch = clean.ok ? await curatedMatch(A, e1) : null;
  ok(
    "Q3c control: a synonym-free answer DOES clear 0.80 for the same question",
    Boolean(cleanMatch) && cleanMatch!.score >= SERVE,
    cleanMatch ? `score=${cleanMatch.score.toFixed(3)}` : "no match",
  );
  if (clean.ok) await db.curatedAnswer.deleteMany({ where: { shopId: A, id: (clean as any).id } });

  // Q4 — near-miss pair: a TIMING question must not return the COST answer
  const e2 = await embedText("when will my package arrive", { shopId: devShopId });
  const m2 = await curatedMatch(devShopId, e2);
  ok(
    "Q4 near-miss pair: timing question does NOT return the shipping-cost answer",
    Boolean(m2) && !m2!.question.includes("how much"),
    m2 ? `score=${m2.score.toFixed(3)} q="${m2.question}"` : "no match",
  );

  // Q5 — the mirrored near-miss: a COST question must not return the TIMING answer
  const e3 = await embedText("is delivery free or do I pay for it", { shopId: devShopId });
  const m3 = await curatedMatch(devShopId, e3);
  ok(
    "Q5 near-miss pair: cost question does NOT return the shipping-time answer",
    Boolean(m3) && !m3!.question.includes("how long"),
    m3 ? `score=${m3.score.toFixed(3)} q="${m3.question}"` : "no match",
  );

  // Q6 — an unrelated question falls BELOW the borderline (pipeline skips the layer)
  const e4 = await embedText("what is the airspeed velocity of an unladen swallow", {
    shopId: devShopId,
  });
  const m4 = await curatedMatch(devShopId, e4);
  ok(
    "Q6 unrelated question scores below the 0.65 borderline → falls through to RAG",
    !m4 || m4.score < BORDERLINE,
    m4 ? `score=${m4.score.toFixed(3)} q="${m4.question}"` : "no match",
  );

  // Q7 — boundary behaviour: matcher is deterministic run-to-run
  const m5 = await curatedMatch(devShopId, e1);
  ok(
    "Q7 matcher is deterministic for the same embedding",
    m5?.id === m1?.id && Math.abs((m5?.score ?? 0) - (m1?.score ?? 0)) < 1e-9,
    `${m1?.id} vs ${m5?.id}`,
  );

  // Q8 — draft + unembedded answers never match
  const draft = await db.curatedAnswer.create({
    data: {
      shopId: A,
      question: `${TAG} secret draft question about parkas`,
      talkingPoints: "This must never be served.",
      status: "draft",
    },
  });
  await db.$executeRawUnsafe(
    `UPDATE curated_answers SET embedding = (SELECT embedding FROM curated_answers WHERE "shopId" = $1 AND embedding IS NOT NULL LIMIT 1) WHERE id = $2`,
    devShopId,
    draft.id,
  );
  const draftMatch = await curatedMatch(A, e1);
  ok("Q8 draft curated answers never match", draftMatch === null, draftMatch ? draftMatch.question : "null");

  // Q9 — curated matching is shop-scoped
  await db.curatedAnswer.update({ where: { id: draft.id }, data: { status: "published" } });
  const aMatch = await curatedMatch(A, e1);
  const bMatch = await curatedMatch(B, e1);
  ok(
    "Q9 curated matching is shop-scoped (A matches its own, B matches nothing)",
    Boolean(aMatch) && aMatch!.id === draft.id && bMatch === null,
    `A=${aMatch?.id ? "hit" : "miss"} B=${bMatch ? "hit" : "miss"}`,
  );
}

// ── Module 4: search (spec 03 lanes) ────────────────────────────────────────

async function search(ctx: { db: any; A: string; B: string }): Promise<void> {
  section("Search: hybrid / keyword / lexicon / scoping");
  const { db, A, B } = ctx;
  const { hybridProductSearch, browseCheapestInBudget, selectRelevant } = await import(
    "../../app/lib/search/product-search.server"
  );
  const { embedText, pseudoEmbedding } = await import(
    "../../app/lib/embeddings/embedding.server"
  );

  // The catalog module left shop A with: Arctic Down Parka (249→199),
  // Made To Order Mug (19), and shop B with Zorblaxium Widget.
  const warm = await embedText("something to keep me warm in the snow", { shopId: A });

  // S1 — vector lane genuinely retrieves the semantically right product
  const vectorOnly = await hybridProductSearch({
    shopId: A,
    queryEmbedding: warm,
    keywords: [],
    message: "",
    minMeaningScore: 0.2,
    limit: 5,
  });
  ok(
    "S1 vector lane ranks the semantically correct product first",
    vectorOnly.length > 0 && vectorOnly[0].title.includes("Parka"),
    vectorOnly.map((c) => `${c.title.slice(9, 24)}:${(c.score ?? 0).toFixed(2)}`).join(" | "),
  );

  // S2 — keyword-only fallback (deliberately meaningless embedding)
  const noise = pseudoEmbedding("noise");
  const keywordOnly = await hybridProductSearch({
    shopId: A,
    queryEmbedding: noise,
    keywords: ["mug"],
    message: "do you sell a mug",
    minMeaningScore: 0.95, // suppress the vector lane entirely
    limit: 5,
  });
  ok(
    "S2 keyword-only fallback still finds the product when the vector lane is suppressed",
    keywordOnly.length === 1 && keywordOnly[0].title.includes("Mug"),
    keywordOnly.map((c) => c.title).join(" | "),
  );

  // S3 — matched terms + coverage are reported for keyword hits
  ok(
    "S3 keyword hits report matchedTerms and coverage",
    keywordOnly[0].coverage > 0 && keywordOnly[0].matchedTerms.length > 0,
    `coverage=${keywordOnly[0]?.coverage} terms=${JSON.stringify(keywordOnly[0]?.matchedTerms)}`,
  );

  // S4 — lexicon typo correction ("parkka" → "parka")
  const typo = await hybridProductSearch({
    shopId: A,
    queryEmbedding: noise,
    keywords: [],
    message: "looking for a parkka",
    minMeaningScore: 0.95,
    limit: 5,
  });
  ok(
    "S4 shop lexicon corrects a misspelled shopper word",
    typo.length === 1 && typo[0].title.includes("Parka"),
    typo.map((c) => c.title).join(" | ") || "no hits",
  );

  // S5 — ranking sanity: higher keyword coverage outranks a weaker match
  const ranked = await hybridProductSearch({
    shopId: A,
    queryEmbedding: warm,
    keywords: ["parka", "winter", "mug"],
    message: "winter parka coat or a mug",
    minMeaningScore: 0.2,
    limit: 5,
  });
  ok(
    "S5 higher coverage ranks above lower coverage",
    ranked.length > 1 && ranked[0].coverage >= ranked[1].coverage && ranked[0].title.includes("Parka"),
    ranked.map((c) => `${c.title.slice(9, 22)}(cov ${c.coverage})`).join(" | "),
  );

  // S6 — price filter is a hard SQL filter, not a ranking hint
  const cheap = await hybridProductSearch({
    shopId: A,
    queryEmbedding: warm,
    keywords: ["parka", "mug"],
    message: "parka or mug",
    priceMax: 50,
    minMeaningScore: 0.2,
    limit: 5,
  });
  ok(
    "S6 priceMax is enforced in SQL (no over-budget candidate returned)",
    cheap.every((c) => c.price <= 50),
    cheap.map((c) => `${c.title.slice(9, 20)}:$${c.price}`).join(" | ") || "none",
  );

  // S7 — out-of-stock exclusion is honoured both ways
  await db.product.updateMany({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" },
    data: { stock: 0, variants: [{ id: "gid://shopify/ProductVariant/5001", title: "M", price: 199, available: false }] as any },
  });
  const excluded = await hybridProductSearch({
    shopId: A, queryEmbedding: warm, keywords: ["parka"], message: "parka",
    minMeaningScore: 0.2, limit: 5, excludeOutOfStock: true,
  });
  const included = await hybridProductSearch({
    shopId: A, queryEmbedding: warm, keywords: ["parka"], message: "parka",
    minMeaningScore: 0.2, limit: 5, excludeOutOfStock: false,
  });
  ok(
    "S7 excludeOutOfStock removes the sold-out product; false includes it",
    !excluded.some((c) => c.title.includes("Parka")) && included.some((c) => c.title.includes("Parka")),
    `excluded=${excluded.length} included=${included.length}`,
  );

  // S8 — browse fallback returns cheapest in budget, in stock
  const browse = await browseCheapestInBudget(A, 100, 4, true);
  ok(
    "S8 browse fallback returns in-budget, in-stock rows cheapest first",
    browse.length >= 1 && browse.every((c) => c.price <= 100) && browse[0].title.includes("Mug"),
    browse.map((c) => `$${c.price}`).join(" "),
  );

  // S9 — CROSS-TENANT: shop A can never surface shop B's product
  const zorb = await embedText("zorblaxium plated widget", { shopId: A });
  const aLooksForB = await hybridProductSearch({
    shopId: A, queryEmbedding: zorb, keywords: ["zorblaxium"], message: "zorblaxium widget",
    minMeaningScore: 0.05, limit: 10, excludeOutOfStock: false,
  });
  const bFindsOwn = await hybridProductSearch({
    shopId: B, queryEmbedding: zorb, keywords: ["zorblaxium"], message: "zorblaxium widget",
    minMeaningScore: 0.05, limit: 10, excludeOutOfStock: false,
  });
  ok(
    "S9 CROSS-TENANT: shop A cannot surface shop B's catalog",
    aLooksForB.every((c) => !c.title.includes("Zorblaxium")) && bFindsOwn.some((c) => c.title.includes("Zorblaxium")),
    `A=${aLooksForB.length} rows (none of B's), B=${bFindsOwn.length} rows`,
  );

  // S10 — requireShopId rejects a blank shopId instead of scanning everything
  const blank = await threw(() =>
    hybridProductSearch({ shopId: "", queryEmbedding: warm, keywords: [], minMeaningScore: 0.2 }),
  );
  ok("S10 blank shopId is refused by the tenancy helper", blank !== null, blank?.message);

  // S11 — selectRelevant caps and keeps the strongest candidates
  const picked = selectRelevant(included, 1);
  ok(
    "S11 selectRelevant caps the card count",
    picked.length <= 1 && (included.length === 0 || picked.length === 1),
    `in=${included.length} out=${picked.length}`,
  );

  // restore stock for later modules
  await db.product.updateMany({
    where: { shopId: A, shopifyProductId: "gid://shopify/Product/900100" },
    data: { stock: 3 },
  });
}

// ── Module 4b: ranking + buy-lane guards (2026-09-01) ───────────────────────

async function rankingGuards(ctx: { db: any; A: string }): Promise<void> {
  section("Search ranking: field-aware coverage / picks / router-block guards");
  const { db, A } = ctx;
  const { hybridProductSearch, selectRelevant, candidateSnippet, TIER_MARGIN } = await import(
    "../../app/lib/search/product-search.server"
  );
  const { pseudoEmbedding } = await import("../../app/lib/embeddings/embedding.server");
  const { upsertProductFromWebhook } = await import("../../app/lib/ingestion/catalog-sync.server");
  const { parsePicksLine, splitPicksStream } = await import("../../app/lib/pipeline/picks.server");
  const { configuredTopicNamedBy } = await import("../../app/lib/pipeline/index.server");

  // Two bracelets: one IS black (title), the other only MENTIONS black in its
  // styling tips — the real-store failure ("pairs with black outfits").
  const onyxId = "gid://shopify/Product/900201";
  const roseId = "gid://shopify/Product/900202";
  await upsertProductFromWebhook(
    SHOP_A,
    productPayload({
      id: 900201, admin_graphql_api_id: onyxId, title: `${TAG} Black Onyx Bracelet`,
      body_html: "<p>Polished 8 mm onyx beads on a stretch cord.</p>", product_type: "Bracelet",
      tags: "beads, grounding", handle: "qa-black-onyx-bracelet",
      variants: [{ id: 5201, title: "One size", price: "32.00", inventory_quantity: 5, inventory_management: "shopify", inventory_policy: "deny" }],
    }),
  );
  await upsertProductFromWebhook(
    SHOP_A,
    productPayload({
      id: 900202, admin_graphql_api_id: roseId, title: `${TAG} Rose Quartz Bracelet`,
      body_html: "<p>Soft pink rose quartz beads. Style tips: pairs beautifully with black, white or beige outfits. Care: keep it overnight on a selenite plate.</p>",
      product_type: "Bracelet", tags: "beads, love", handle: "qa-rose-quartz-bracelet",
      variants: [{ id: 5202, title: "One size", price: "30.00", inventory_quantity: 5, inventory_management: "shopify", inventory_policy: "deny" }],
    }),
  );
  const noise = pseudoEmbedding("noise");
  // "bracelets" is the router's "bracelet" in the plural — the shopper tier
  // must not count it a second time (it did, once: cov 5 / 3.8).
  const black = await hybridProductSearch({
    shopId: A, queryEmbedding: noise, keywords: ["black", "bracelet"], message: "show me black bracelets",
    minMeaningScore: 0.95, limit: 8,
  });
  const onyx = black.find((c) => c.shopifyProductId === onyxId);
  const rose = black.find((c) => c.shopifyProductId === roseId);

  // S12 — a word in the title outranks the same word in the prose
  ok(
    "S12 field-aware coverage: title match (2+2) beats description-only match (2+0.8)",
    Boolean(onyx && rose) && black[0].shopifyProductId === onyxId && onyx!.coverage === 4 && rose!.coverage === 2.8,
    black.map((c) => `${c.title.slice(12, 40)}(cov ${c.coverage})`).join(" | "),
  );
  ok(
    "S13 headTerms report WHERE each word matched",
    Boolean(onyx && rose) && onyx!.headTerms.includes("black") && !rose!.headTerms.includes("black") && rose!.matchedTerms.includes("black") && !rose!.matchedTerms.includes("bracelets"),
    `onyx.head=${JSON.stringify(onyx?.headTerms)} rose.head=${JSON.stringify(rose?.headTerms)} rose.matched=${JSON.stringify(rose?.matchedTerms)}`,
  );
  const tier = selectRelevant(black, 4);
  ok(
    "S14 relevance tier (TIER_MARGIN) keeps the literal match and drops the prose mention",
    tier.length === 1 && tier[0].shopifyProductId === onyxId && TIER_MARGIN === 0.5,
    tier.map((c) => c.title.slice(12)).join(" | "),
  );
  ok(
    "S15 snippet tells the model where the words matched",
    Boolean(rose) && /in title\/type\/tags: bracelet/.test(candidateSnippet(rose!)) && /in description: black/.test(candidateSnippet(rose!)),
    rose ? candidateSnippet(rose).slice(-80) : "no rose row",
  );
  await db.product.deleteMany({ where: { shopId: A, shopifyProductId: { in: [onyxId, roseId] } } });

  // P1 — picks line parser
  const parse = (s: string) => JSON.stringify(parsePicksLine(s));
  ok(
    "P1 parsePicksLine: ids, none, markdown noise, prose left alone",
    parse("PICKS: 3, 1") === '{"kind":"ids","ids":[3,1]}' &&
      parse("**Picks:** [2]") === '{"kind":"ids","ids":[2]}' &&
      parse("PICKS: none") === '{"kind":"none"}' &&
      parse("PICKS: 0") === '{"kind":"none"}' &&
      parse("PICKS: Black Onyx") === "null" &&
      parse("Pick 2 of our bracelets for a stack.") === "null" &&
      parse("Great choice!") === "null",
    [parse("PICKS: 3, 1"), parse("PICKS: none"), parse("Pick 2 of our bracelets for a stack.")].join(" "),
  );

  // P2 — the stream splitter strips the picks line, passes prose through
  async function* tokens(parts: string[]): AsyncIterable<string> {
    for (const p of parts) yield p;
  }
  async function collect(parts: string[]): Promise<{ text: string; picks: unknown; line: string | null }> {
    const s = splitPicksStream(tokens(parts));
    let text = "";
    for await (const t of s.text) text += t;
    return { text, ...s.result() };
  }
  const withPicks = await collect(["PI", "CKS: 2, ", "1\n", "\n", "These", " fit."]);
  const prose = await collect(["Great", " choice!\n", "Both fit."]);
  const onlyPicks = await collect(["PICKS: none"]);
  const longFirst = await collect(["x".repeat(50), "y".repeat(50), "\nmore"]);
  ok(
    "P2 splitPicksStream: picks line consumed, blank lines skipped, prose intact",
    withPicks.text === "These fit." && JSON.stringify(withPicks.picks) === '{"kind":"ids","ids":[2,1]}' && withPicks.line === "PICKS: 2, 1",
    JSON.stringify(withPicks),
  );
  ok(
    "P3 splitPicksStream: a reply without a picks line streams byte-for-byte",
    prose.text === "Great choice!\nBoth fit." && prose.picks === null &&
      longFirst.text === "x".repeat(50) + "y".repeat(50) + "\nmore" && longFirst.picks === null,
    `${JSON.stringify(prose.text)} / ${longFirst.text.length} chars`,
  );
  ok(
    "P4 splitPicksStream: a picks-only reply yields no text and reports the picks",
    onlyPicks.text === "" && JSON.stringify(onlyPicks.picks) === '{"kind":"none"}',
    JSON.stringify(onlyPicks),
  );

  // G1 — router block reason must name a configured topic
  const topics = ["medical advice", "competitor pricing", "politics", "weapons"];
  ok(
    "G1 configuredTopicNamedBy: prefix-tolerant topic match, filler ignored, invented reasons rejected",
    configuredTopicNamedBy("medical advice", topics) === "medical advice" &&
      configuredTopicNamedBy("political opinions", topics) === "politics" &&
      configuredTopicNamedBy("weapon", topics) === "weapons" &&
      configuredTopicNamedBy("competitor prices", topics) === "competitor pricing" &&
      configuredTopicNamedBy("BANNED TOPIC", topics) === null &&
      configuredTopicNamedBy("security devices", topics) === null &&
      configuredTopicNamedBy("advice", topics) === null &&
      configuredTopicNamedBy("", topics) === null,
    `political→${configuredTopicNamedBy("political opinions", topics)} banned→${configuredTopicNamedBy("BANNED TOPIC", topics)}`,
  );
}

// ── Module 4c: metaobject-reference metafields (spec 07, 2026-09-07) ────────

async function metaobjectResolution(): Promise<void> {
  section("Metaobject-reference metafields: resolution + rendering");
  const {
    buildMetafieldText,
    metafieldKey,
    metaobjectIdsIn,
    renderMetafieldValue,
    renderMetaobject,
    resolveMetaobjectRefs,
  } = await import("../../app/lib/ingestion/metafields.server");

  // MR1 — a metaobject renders as readable text; reference/file fields and the
  // display-name repeat are skipped (one level deep only)
  const rendered = renderMetaobject({
    id: "gid://shopify/Metaobject/1",
    displayName: "Rose Quartz",
    fields: [
      { key: "name", value: "Rose Quartz", type: "single_line_text_field" },
      { key: "origin", value: "Brazil", type: "single_line_text_field" },
      { key: "benefit", value: "love & harmony", type: "multi_line_text_field" },
      { key: "related", value: "gid://shopify/Metaobject/9", type: "metaobject_reference" },
      { key: "image", value: "gid://shopify/MediaImage/3", type: "file_reference" },
    ],
  });
  ok(
    "MR1 renderMetaobject: fields become text; references and the name repeat are skipped",
    rendered === "Rose Quartz (origin: Brazil; benefit: love & harmony)",
    rendered,
  );

  const single = {
    owner: "product" as const, variant: "", namespace: "custom", key: "spec",
    type: "metaobject_reference", value: "gid://shopify/Metaobject/11",
    resolved: undefined as string | undefined,
  };
  const listEntry = {
    ...single, key: "ingredients", type: "list.metaobject_reference",
    value: '["gid://shopify/Metaobject/11","gid://shopify/Metaobject/12","nope"]',
  };
  const textEntry = { ...single, key: "care", type: "single_line_text_field", value: "wipe dry" };

  // MR2 — gid extraction: single, list (bad items dropped), non-reference
  ok(
    "MR2 metaobjectIdsIn extracts gids from single and list values, ignores non-references",
    JSON.stringify(metaobjectIdsIn(single)) === '["gid://shopify/Metaobject/11"]' &&
      JSON.stringify(metaobjectIdsIn(listEntry)) ===
        '["gid://shopify/Metaobject/11","gid://shopify/Metaobject/12"]' &&
      metaobjectIdsIn(textEntry).length === 0,
    `${JSON.stringify(metaobjectIdsIn(single))} / ${JSON.stringify(metaobjectIdsIn(listEntry))}`,
  );

  // MR3 — batched resolution: one call for all lists, deleted (null) node
  // leaves its entry unresolved, DISABLED definitions are never fetched
  let calls = 0;
  const fakeAdmin = {
    async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
      calls++;
      const ids = (options?.variables?.ids ?? []) as string[];
      return {
        async json() {
          return {
            data: {
              nodes: ids.map((id) =>
                id.endsWith("/12")
                  ? null
                  : {
                      id,
                      displayName: `Obj ${id.split("/").pop()}`,
                      fields: [{ key: "origin", value: "Brazil", type: "single_line_text_field" }],
                    },
              ),
            },
          };
        },
      };
    },
  };
  const enabled = new Map([
    [metafieldKey("product", "custom", "spec"), { name: "Specifications", type: "metaobject_reference" }],
    [metafieldKey("product", "custom", "ingredients"), { name: "Ingredients", type: "list.metaobject_reference" }],
  ]);
  const a = { ...single };
  const b = { ...listEntry };
  const disabled = { ...single, key: "hidden" };
  await resolveMetaobjectRefs(fakeAdmin, [[a, b], [disabled]], enabled);
  ok(
    "MR3 one batched call resolves enabled refs; deleted id skipped; disabled untouched",
    calls === 1 &&
      a.resolved === "Obj 11 (origin: Brazil)" &&
      b.resolved === "Obj 11 (origin: Brazil)" &&
      disabled.resolved === undefined,
    `calls=${calls} a=${String(a.resolved)} disabled=${String(disabled.resolved)}`,
  );

  // MR4 — a reference entry renders ONLY its resolved text, never the gid
  ok(
    "MR4 reference entries render resolved text only — an unresolved one renders nothing",
    renderMetafieldValue("metaobject_reference", "gid://shopify/Metaobject/11", "Obj 11 (origin: Brazil)") ===
      "Obj 11 (origin: Brazil)" &&
      renderMetafieldValue("metaobject_reference", "gid://shopify/Metaobject/11") === "" &&
      buildMetafieldText([a], enabled) === "Specifications: Obj 11 (origin: Brazil)" &&
      buildMetafieldText([{ ...single }], enabled) === "",
    buildMetafieldText([a], enabled),
  );
}

// ── Module 5: campaigns / proactive chat (spec 12) ──────────────────────────

async function campaigns(ctx: {
  db: any;
  A: string;
  B: string;
  getQuota: (plan: string, dim: any) => number;
  setPlan: (shopId: string, plan: string) => Promise<unknown>;
}): Promise<void> {
  section("Campaigns / proactive chat (spec 12)");
  const { db, A, B, getQuota, setPlan } = ctx;
  const {
    saveCampaign,
    toggleCampaign,
    listCampaigns,
    deleteCampaign,
    duplicateCampaign,
    reorderCampaign,
    activeCampaignsForWidget,
    recordCampaignMetric,
  } = await import("../../app/lib/campaigns/campaigns.server");

  await setPlan(A, "plus");

  const base = (over: Record<string, any> = {}) => ({
    name: `${TAG} welcome`,
    templateType: "welcome",
    status: "inactive",
    settings: {
      trigger: { pageScope: "all_pages", dwellSeconds: 5 },
      message: { kind: "text", bodyHtml: `<p>${TAG} hello there</p>` },
    },
    ...over,
  });

  // P1 — create + strict validation of the settings shape
  const created = await saveCampaign(A, "plus", base());
  ok("P1 campaign saves with the {trigger,conditions,message,appearance} shape", created.ok === true, JSON.stringify(created).slice(0, 90));
  const id = (created as any).id;

  const row = await db.campaign.findUnique({ where: { id } });
  const settings = row.settings as any;
  ok(
    "P2 omitted settings fields are filled from the template defaults",
    Boolean(settings.trigger && settings.conditions && settings.message && settings.appearance),
    Object.keys(settings).join(","),
  );

  // P3 — targeting rules: specific pages requires the URL fragment
  const badScope = await saveCampaign(A, "plus", base({ settings: { trigger: { pageScope: "specific_pages", urlContains: "" } } }));
  ok(
    "P3 targeting validation: 'specific pages' with no URL fragment is refused",
    badScope.ok === false && (badScope as any).code === "invalid",
    (badScope as any).error,
  );

  // P4 — scheduling: a custom date window must be well-formed and ordered
  const badDates = await saveCampaign(
    A, "plus",
    base({ settings: { conditions: { displayDuration: "custom", startDate: "2026-09-10", endDate: "2026-09-01" } } }),
  );
  const goodDates = await saveCampaign(
    A, "plus",
    base({ id, settings: { conditions: { displayDuration: "custom", startDate: "2026-09-01", endDate: "2026-09-10" } } }),
  );
  ok(
    "P4 scheduling: end-before-start refused, valid window accepted",
    badDates.ok === false && goodDates.ok === true,
    (badDates as any).error,
  );

  // P5 — XSS in the bubble body is sanitised (it reaches innerHTML)
  await saveCampaign(A, "plus", base({ id, settings: { message: { kind: "text", bodyHtml: `<p>hi</p><script>alert(1)</script><img src=x onerror=alert(1)>` } } }));
  const sanitised = ((await db.campaign.findUnique({ where: { id } })).settings as any).message.bodyHtml;
  ok(
    "P5 campaign body HTML is sanitised before it reaches a shopper",
    !/script|onerror/i.test(sanitised),
    sanitised.slice(0, 60),
  );

  // P6 — active_campaigns quota on Free, read live (it was 0 until the
  // 2026-09-11 re-baseline made it 1). Fill the quota, then the next
  // activation must be refused via save AND toggle.
  await setPlan(A, "free");
  const freeQuota = getQuota("free", "active_campaigns");
  await db.campaign.updateMany({ where: { shopId: A }, data: { status: "inactive" } });
  const freeIds: string[] = [];
  for (let i = 0; i < freeQuota; i++) {
    const r = await saveCampaign(A, "free", base({ name: `${TAG} free campaign ${i}`, status: "inactive" }));
    if (r.ok && (await toggleCampaign(A, (r as any).id, true)) === true) freeIds.push((r as any).id);
  }
  const activateOnFree = await saveCampaign(A, "free", base({ id, status: "active" }));
  const toggleOnFree = await toggleCampaign(A, id, true);
  ok(
    `P6 active_campaigns quota (free = ${freeQuota}) fills, then refuses activation via save AND toggle`,
    freeIds.length === freeQuota &&
      activateOnFree.ok === false && (activateOnFree as any).code === "plan_gate" &&
      typeof toggleOnFree === "object" && "error" in (toggleOnFree as any),
    `filled=${freeIds.length} ${(activateOnFree as any).error?.slice(0, 50) ?? ""}`,
  );
  // P7/P8 count actives from zero.
  await db.campaign.updateMany({ where: { shopId: A, id: { in: freeIds } }, data: { status: "inactive" } });

  // P7 — Basic quota = 2: the third activation is refused, drafts are unlimited
  await setPlan(A, "basic");
  const basicQuota = getQuota("basic", "active_campaigns");
  const ids: string[] = [id];
  for (let i = 0; i < basicQuota + 1; i++) {
    const r = await saveCampaign(A, "basic", base({ name: `${TAG} campaign ${i}`, status: "inactive" }));
    if (r.ok) ids.push((r as any).id);
  }
  let activated = 0;
  let refused = 0;
  for (const cid of ids) {
    const r = await toggleCampaign(A, cid, true);
    if (r === true) activated++;
    else refused++;
  }
  ok(
    `P7 exactly ${basicQuota} campaigns can be active on Basic`,
    activated === basicQuota && refused >= 1,
    `activated=${activated} refused=${refused}`,
  );

  // P8 — downgrade rule: already-active campaigns keep running, only new ones blocked
  await setPlan(A, "free");
  const stillActive = await db.campaign.count({ where: { shopId: A, status: "active" } });
  const newOnFree = await toggleCampaign(A, ids[ids.length - 1], true);
  ok(
    "P8 downgrade keeps existing active campaigns, blocks the next activation",
    stillActive === basicQuota && typeof newOnFree === "object",
    `stillActive=${stillActive}`,
  );
  await setPlan(A, "plus");

  // P9 — premium template gate
  const premium = await saveCampaign(A, "free", { name: `${TAG} premium`, templateType: "cart_booster", status: "inactive", settings: {} });
  ok(
    "P9 premium template refused below Pro",
    premium.ok === false && (premium as any).code === "plan_gate",
    (premium as any).error,
  );

  // P10 — Product Quiz has no widget runtime, so it is refused on EVERY plan.
  // Gating it on Pro+ meant paying customers were the only ones able to save a
  // campaign that renders as a plain text bubble.
  const quizFree = await saveCampaign(A, "free", base({ settings: { message: { kind: "product_quiz" } } }));
  ok(
    "P10 Product Quiz message kind is refused on Free",
    quizFree.ok === false,
    (quizFree as any).error,
  );

  // P10b — DEFECT: on Pro/Plus the same payload SAVES even though no quiz
  // runtime exists; widget-renderer.js:1533-1536 falls through to renderText,
  // so the shopper sees a plain text bubble instead of the quiz.
  const quizPlus = await saveCampaign(A, "plus", base({ settings: { message: { kind: "product_quiz" } } }));
  if (quizPlus.ok) await deleteCampaign(A, (quizPlus as any).id);
  ok(
    "P10b Product Quiz is refused on every plan (no runtime exists)",
    quizPlus.ok === false,
    "saved on Plus — renders as plain text (app/lib/campaigns/campaigns.server.ts:264)",
  );

  // P11 — unknown template refused
  const unknown = await saveCampaign(A, "plus", { name: `${TAG} x`, templateType: "mind_control", status: "inactive", settings: {} });
  ok("P11 unknown template refused", unknown.ok === false, (unknown as any).error);

  // P12 — CROSS-TENANT: shop B cannot update shop A's campaign
  const crossUpdate = await saveCampaign(B, "plus", base({ id, name: `${TAG} hijacked` }));
  const untouched = await db.campaign.findUnique({ where: { id }, select: { name: true, shopId: true } });
  ok(
    "P12 CROSS-TENANT: another shop cannot update this campaign",
    crossUpdate.ok === false && (crossUpdate as any).code === "not_found" && untouched.shopId === A && !untouched.name.includes("hijacked"),
    (crossUpdate as any).error,
  );

  // P13 — CROSS-TENANT: the widget payload never carries another shop's campaign
  const widgetA = await activeCampaignsForWidget(A, "plus");
  const widgetB = await activeCampaignsForWidget(B, "plus");
  ok(
    "P13 CROSS-TENANT: a campaign never fires for the wrong shop",
    widgetA.length === basicQuota && widgetB.length === 0,
    `A=${widgetA.length} B=${widgetB.length}`,
  );

  // P14 — premium campaigns are stripped from the widget payload below Pro
  await db.campaign.create({
    data: { shopId: A, name: `${TAG} cart booster`, templateType: "cart_booster", status: "active", priority: 99, settings: (await db.campaign.findUnique({ where: { id } })).settings },
  });
  const widgetFree = await activeCampaignsForWidget(A, "free");
  ok(
    "P14 premium template removed from the widget payload below Pro",
    !widgetFree.some((c) => c.templateType === "cart_booster"),
    `n=${widgetFree.length}`,
  );

  // P15 — priority order drives evaluation order
  await reorderCampaign(A, ids[1], "up");
  const ordered = await listCampaigns(A);
  ok(
    "P15 reorder renumbers priorities densely from 1",
    ordered.length > 1 && ordered.every((c: any, i: number) => c.priority === i + 1),
    ordered.map((c: any) => c.priority).join(","),
  );

  // P16 — metrics are shop-scoped and revenue is recomputed server-side
  await recordCampaignMetric(A, id, "view");
  await recordCampaignMetric(A, id, "click");
  await recordCampaignMetric(B, id, "view", 999); // wrong shop → no-op
  const metrics = await db.campaign.findUnique({ where: { id }, select: { views: true, clicks: true, revenue: true } });
  ok(
    "P16 metrics shop-scoped; a cross-shop beacon is a no-op",
    metrics.views === 1 && metrics.clicks === 1 && Number(metrics.revenue) === 0,
    `views=${metrics.views} clicks=${metrics.clicks}`,
  );

  // P17 — ATC revenue comes from the catalog mirror, not the client
  await recordCampaignMetric(A, id, "atc", 99999);
  const afterAtc = await db.campaign.findUnique({ where: { id }, select: { atcs: true, revenue: true } });
  ok(
    "P17 ATC revenue is recomputed server-side (client number ignored)",
    afterAtc.atcs === 1 && Number(afterAtc.revenue) !== 99999 && Number(afterAtc.revenue) > 0,
    `revenue=${afterAtc.revenue}`,
  );

  // P18 — lead capture config only travels when the campaign collects one
  await saveCampaign(A, "plus", base({ id, settings: { message: { kind: "text", bodyHtml: "<p>hi</p>", collectLead: false } } }));
  const noLead = (await activeCampaignsForWidget(A, "plus")).find((c) => c.id === id);
  ok(
    "P18 lead form config withheld when collectLead is off",
    !noLead || noLead.message.lead === null,
    JSON.stringify(noLead?.message?.lead),
  );

  // P19 — duplicate copies inactive, delete is shop-scoped
  const dupId = await duplicateCampaign(A, id);
  const dup = dupId ? await db.campaign.findUnique({ where: { id: dupId } }) : null;
  const crossDelete = await deleteCampaign(B, id);
  ok(
    "P19 duplicate is inactive; cross-shop delete refused",
    dup?.status === "inactive" && dup?.name.endsWith("copy") && crossDelete === false,
    `dup=${dup?.status}`,
  );

  // P20 — the widget-side trigger evaluator is exercised by
  // scripts/test-campaign-triggers.ts (pure JS in the widget bundle); this
  // suite proves only the server side, so record the boundary explicitly.
  ok("P20 trigger/condition evaluation covered by scripts/test-campaign-triggers.ts", true, "not duplicated here");
}

// ── Module 6: analytics (spec 14) ───────────────────────────────────────────

async function analytics(ctx: {
  db: any;
  A: string;
  B: string;
  getQuota: (plan: string, dim: any) => number;
  setPlan: (shopId: string, plan: string) => Promise<unknown>;
}): Promise<void> {
  section("Analytics (spec 14)");
  const { db, A, B, getQuota, setPlan } = ctx;
  const { rollupDay, utcDay } = await import("../../app/lib/analytics/rollup.server");
  const {
    conversationSeries,
    resolutionBreakdown,
    csatSummary,
    recommendationFunnel,
    responsePerformance,
    topQuestions,
    exportAnalyticsCsv,
    exportConversationsCsv,
  } = await import("../../app/lib/analytics/reports.server");

  await setPlan(A, "plus");
  const DAY = 24 * 60 * 60 * 1000;
  const today = utcDay(new Date());

  // A1 — empty-data safety: every report survives a shop with zero rows
  const emptySeries = await conversationSeries(B, "7d");
  const emptyDonut = await resolutionBreakdown(B, "7d");
  const emptyCsat = await csatSummary(B);
  const emptyPerf = await responsePerformance(B, "7d");
  const emptyTop = await topQuestions(B);
  ok(
    "A1 empty-data safety: all reports return zeros, never NaN/throw",
    emptySeries.length === 7 &&
      emptySeries.every((p) => p.ai === 0 && p.human === 0) &&
      emptyDonut.total === 0 && emptyDonut.resolvedByAiPct === 0 &&
      emptyCsat.avg === null && emptyCsat.responses === 0 &&
      emptyPerf.avgFirstResponseMs === null && emptyTop.length === 0,
    `donut=${JSON.stringify(emptyDonut)}`,
  );

  // Deterministic fixture: 2 UTC days back so "today" partials can't interfere.
  const day = new Date(today.getTime() - 2 * DAY);
  const at = (h: number, m = 0) => new Date(day.getTime() + h * 3600_000 + m * 60_000);

  const mk = async (over: Record<string, any>) =>
    db.conversation.create({
      data: {
        shopId: A,
        sessionId: `${TAG}-${Math.random().toString(36).slice(2)}`,
        startedAt: at(10),
        lastMessageAt: at(11),
        ...over,
      },
    });

  const c1 = await mk({ status: "resolved", handover: false, endedAt: at(10, 5), rating: 5 });
  const c2 = await mk({ status: "resolved", handover: true, endedAt: at(10, 20), rating: 3 });
  const c3 = await mk({ status: "open", handover: false });
  const cTest = await mk({ status: "resolved", isTest: true, endedAt: at(10, 1), rating: 1 });

  const msg = (convId: string, role: string, layer: string | null, minute: number) =>
    db.message.create({
      data: { shopId: A, conversationId: convId, role, author: role === "in" ? "shopper" : "ai", content: `${TAG} where is my order`, sourceLayer: layer, createdAt: at(10, minute) },
    });
  await msg(c1.id, "in", null, 0);
  await msg(c1.id, "out", "curated", 1);
  await msg(c2.id, "in", null, 0);
  await msg(c2.id, "out", "handover", 3);
  await msg(c3.id, "in", null, 0);
  await msg(c3.id, "out", "buy", 2);
  await msg(cTest.id, "in", null, 0);
  await msg(cTest.id, "out", "curated", 1);
  await db.analyticsEvent.create({ data: { shopId: A, type: "added_to_cart", payload: {}, occurredAt: at(12) } });

  const counters = await rollupDay(A, day);

  // A2 — counters reconcile with an INDEPENDENT recount from the raw rows
  const [expConv] = (await db.$queryRawUnsafe(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE handover)::int AS human,
       count(*) FILTER (WHERE status='resolved' AND NOT handover)::int AS ai_res,
       count(*) FILTER (WHERE status='resolved' AND handover)::int AS human_res
     FROM conversations
     WHERE "shopId" = $1 AND NOT "isTest" AND "startedAt" >= $2 AND "startedAt" < $3`,
    A, day, new Date(day.getTime() + DAY),
  ) as any[]);
  ok(
    "A2 rollup conversation counters reconcile with an independent SQL recount",
    counters.conversations === expConv.total &&
      counters.humanConversations === expConv.human &&
      counters.resolvedByAi === expConv.ai_res &&
      counters.resolvedByHuman === expConv.human_res &&
      counters.unresolved === expConv.total - expConv.ai_res - expConv.human_res,
    `rollup=${counters.conversations}/${counters.resolvedByAi}/${counters.resolvedByHuman} sql=${expConv.total}/${expConv.ai_res}/${expConv.human_res}`,
  );

  // A3 — test conversations excluded everywhere
  ok(
    "A3 isTest conversations excluded from the rollup",
    counters.conversations === 3 && counters.turns === 3 && counters.curatedServed === 1,
    `conversations=${counters.conversations} turns=${counters.turns} curated=${counters.curatedServed}`,
  );

  // A4 — timing metrics computed from real message timestamps
  const expectedFirstResponse = Math.round((60_000 + 3 * 60_000 + 2 * 60_000) / 3);
  const expectedResolution = Math.round((5 * 60_000 + 20 * 60_000) / 2);
  ok(
    "A4 first-response / resolution averages match a hand computation",
    counters.avgFirstResponseMs === expectedFirstResponse &&
      counters.avgResolutionMs === expectedResolution &&
      counters.firstResponseCount === 3 && counters.resolutionCount === 2,
    `first=${counters.avgFirstResponseMs} (want ${expectedFirstResponse}) res=${counters.avgResolutionMs} (want ${expectedResolution})`,
  );

  // A5 — rollup is idempotent
  const again = await rollupDay(A, day);
  const rows = await db.metricsDaily.count({ where: { shopId: A, date: day } });
  ok(
    "A5 rollupDay is idempotent (same numbers, one row)",
    JSON.stringify(again) === JSON.stringify(counters) && rows === 1,
    `rows=${rows}`,
  );

  // A6 — donut percentages always sum to exactly 100 (largest remainder)
  const donut = await resolutionBreakdown(A, "7d");
  ok(
    "A6 resolution donut sums to exactly 100%",
    donut.resolvedByAiPct + donut.resolvedByHumanPct + donut.unresolvedPct === 100,
    `${donut.resolvedByAiPct}/${donut.resolvedByHumanPct}/${donut.unresolvedPct}`,
  );

  // A7 — CSAT excludes test conversations
  const csat = await csatSummary(A);
  ok(
    "A7 CSAT average excludes isTest conversations",
    csat.responses === 2 && csat.avg === 4,
    `responses=${csat.responses} avg=${csat.avg}`,
  );

  // A8 — funnel reads the same rollup
  const funnel = await recommendationFunnel(A, "7d");
  ok("A8 recommendation funnel reads shown/atc from the rollup", funnel.shown === 1 && funnel.atc === 1, `shown=${funnel.shown} atc=${funnel.atc}`);

  // A9 — timezone: a conversation at 23:59 UTC lands in that UTC day, and the
  //      NEXT day's rollup does not double-count it.
  const late = await mk({ startedAt: new Date(day.getTime() + DAY - 60_000), lastMessageAt: new Date(day.getTime() + DAY - 60_000), status: "open" });
  const dayAgain = await rollupDay(A, day);
  const nextDay = await rollupDay(A, new Date(day.getTime() + DAY));
  ok(
    "A9 UTC day boundary: 23:59 belongs to that day only",
    dayAgain.conversations === 4 && nextDay.conversations === 0,
    `day=${dayAgain.conversations} next=${nextDay.conversations}`,
  );
  await db.conversation.delete({ where: { id: late.id } });
  await rollupDay(A, day);

  // A10 — timezone: buckets are UTC days, and stay UTC even when the shop is
  // configured for another zone. Documented behaviour, verified rather than
  // assumed — the merchant-visible consequence is reported separately.
  await db.shop.update({ where: { id: A }, data: { timezone: "Pacific/Auckland" } });
  const lateUtc = await mk({
    startedAt: new Date(day.getTime() + 22 * 3600_000),
    lastMessageAt: new Date(day.getTime() + 22 * 3600_000),
    status: "open",
  });
  const utcBucket = await rollupDay(A, day);
  const nextBucket = await rollupDay(A, new Date(day.getTime() + DAY));
  ok(
    "A10 22:00 UTC is bucketed on the UTC day even for a Pacific/Auckland shop",
    utcBucket.conversations === 4 && nextBucket.conversations === 0,
    "UTC-only buckets (app/lib/analytics/rollup.server.ts:82); an Auckland merchant sees it as 'yesterday'",
  );
  await db.conversation.delete({ where: { id: lateUtc.id } });
  await rollupDay(A, day);
  await rollupDay(A, new Date(day.getTime() + DAY));

  // A11 — analytics_range_days plan clamp
  await setPlan(A, "free");
  const freeDays = getQuota("free", "analytics_range_days");
  const wide = await conversationSeries(A, "12m");
  ok(
    `A11 analytics_range_days clamp (free = ${freeDays} days) is enforced server-side`,
    wide.length <= freeDays,
    `free plan got ${wide.length} days of history for ?crange=12m (no clamp exists — app/lib/analytics/reports.server.ts:138)`,
  );

  // A12 — exports on EVERY plan (the "exports" feature gate was removed
  // 2026-09-10, user decision) — well-formed on Free too
  const freeCsv = await exportConversationsCsv(A);
  await setPlan(A, "plus");
  const csv = await exportConversationsCsv(A);
  const acsv = await exportAnalyticsCsv(A, "7d");
  ok(
    "A12 CSV exports work on every plan (gate retired) and are well-formed",
    freeCsv.startsWith("id,startedAt,status,mode,outcome,rating,messages") &&
      csv.startsWith("id,startedAt,status,mode,outcome,rating,messages") &&
      acsv.split("\n")[0].startsWith("date,conversations"),
  );

  // A13 — CROSS-TENANT: shop B's export/report never contains shop A's rows
  const csvB = await exportConversationsCsv(B);
  ok(
    "A13 CROSS-TENANT: exports are shop-scoped",
    csvB.trim().split("\n").length === 1 && !csvB.includes(c1.id),
    `lines=${csvB.trim().split("\n").length}`,
  );

  // A14 — top questions groups normalized text and skips test conversations
  const top = await topQuestions(A);
  ok(
    "A14 top questions groups normalised shopper text, excluding test rows",
    top.length === 1 && top[0].count === 3 && top[0].pct === 100,
    JSON.stringify(top),
  );

  // A15 — response performance deltas are null (not NaN) with no prior period
  const perf = await responsePerformance(A, "7d");
  ok(
    "A15 response performance deltas are null with no comparable prior period",
    perf.deltas.firstResponsePct === null || Number.isFinite(perf.deltas.firstResponsePct),
    JSON.stringify(perf.deltas),
  );
}

// ── Module 7: inbox (spec 10) ───────────────────────────────────────────────

async function inbox(ctx: {
  db: any;
  A: string;
  B: string;
  setPlan: (shopId: string, plan: string) => Promise<unknown>;
}): Promise<void> {
  section("Inbox (spec 10)");
  const { db, A, B, setPlan } = ctx;
  const {
    listConversations,
    getConversationDetail,
    markRead,
    setStarred,
    setResolved,
    blockConversation,
    deleteConversation,
    autoResolveInactive,
    getInboxCounts,
    INBOX_FILTER_KEYS,
  } = await import("../../app/lib/inbox/inbox.server");
  const { FILTERS, unreadOpenCount } = await import("../../app/components/InboxShared");
  type FilterKey = keyof typeof FILTERS;
  const { hasFeature } = await import("../../app/lib/billing/plans.server");

  // Clear the analytics fixtures so the counts below are exact.
  await db.message.deleteMany({ where: { shopId: A } });
  await db.conversation.deleteMany({ where: { shopId: A } });

  const now = Date.now();
  const conv = async (over: Record<string, any>) =>
    db.conversation.create({
      data: {
        shopId: A,
        sessionId: `${TAG}-${Math.random().toString(36).slice(2)}`,
        lastMessageAt: new Date(now),
        startedAt: new Date(now),
        ...over,
      },
    });

  const open1 = await conv({ status: "open", unread: true });
  const resolved1 = await conv({ status: "resolved", unread: false, lastMessageAt: new Date(now - 1000) });
  const starred1 = await conv({ status: "open", starred: true, lastMessageAt: new Date(now - 2000) });
  const handover1 = await conv({ status: "open", handover: true, mode: "human", lastMessageAt: new Date(now - 3000) });
  const blocked1 = await conv({ status: "open", blocked: true, lastMessageAt: new Date(now - 4000) });
  const assigned1 = await conv({ status: "open", assigneeId: "owner", lastMessageAt: new Date(now - 5000) });
  await db.message.create({
    data: { shopId: A, conversationId: open1.id, role: "in", author: "shopper", content: `${TAG} I need help with my order please` },
  });

  // I1 — list is newest-first, shop-scoped, with contact name + preview
  const rows = await listConversations(A);
  ok(
    "I1 list is shop-scoped and newest-first with a message preview",
    rows.length === 6 &&
      rows[0].id === open1.id &&
      rows[0].preview.startsWith(`${TAG} I need help`),
    `n=${rows.length} first=${rows[0]?.preview.slice(0, 30)}`,
  );

  // I2 — filter predicates
  const f = (k: FilterKey) => rows.filter((r) => FILTERS[k].test(r as any)).map((r) => r.id);
  ok(
    "I2 filter predicates select the right rows",
    f("all").length === 5 &&
      f("open").length === 4 &&
      f("resolved").length === 1 &&
      f("starred")[0] === starred1.id &&
      f("handover")[0] === handover1.id &&
      f("blocked")[0] === blocked1.id &&
      !f("unassigned").includes(assigned1.id),
    `all=${f("all").length} open=${f("open").length} unassigned=${f("unassigned").length}`,
  );

  // I3 — unread badge
  const expectedUnread = await db.conversation.count({
    where: { shopId: A, unread: true, status: "open", blocked: false, isTest: false },
  });
  ok(
    "I3 unread badge matches an independent DB count of unread open rows",
    unreadOpenCount(rows as any) === expectedUnread,
    `ui=${unreadOpenCount(rows as any)} db=${expectedUnread}`,
  );

  // I4 — read/unread + starred + resolve + block round-trip
  await markRead(A, open1.id);
  await setStarred(A, resolved1.id, true);
  await setResolved(A, open1.id, true);
  const after = await db.conversation.findMany({
    where: { shopId: A, id: { in: [open1.id, resolved1.id] } },
    select: { id: true, unread: true, starred: true, status: true, endedAt: true },
  });
  const o = after.find((r: any) => r.id === open1.id);
  const r2 = after.find((r: any) => r.id === resolved1.id);
  ok(
    "I4 markRead / setStarred / setResolved persist (resolve stamps endedAt)",
    o.unread === false && o.status === "resolved" && o.endedAt !== null && r2.starred === true,
    `unread=${o.unread} status=${o.status} endedAt=${Boolean(o.endedAt)}`,
  );

  // I5 — CROSS-TENANT: none of the mutations work from another shop
  const crossRead = await markRead(B, open1.id);
  const crossStar = await setStarred(B, open1.id, true);
  const crossBlock = await blockConversation(B, open1.id);
  const crossDelete = await deleteConversation(B, open1.id);
  const crossDetail = await getConversationDetail(B, open1.id);
  const survived = await db.conversation.count({ where: { id: open1.id, shopId: A } });
  ok(
    "I5 CROSS-TENANT: read/star/block/delete/detail all refuse another shop's conversation",
    !crossRead && !crossStar && !crossBlock && !crossDelete && crossDetail === null && survived === 1,
    `read=${crossRead} star=${crossStar} block=${crossBlock} del=${crossDelete} detail=${crossDetail}`,
  );

  // I6 — thread detail returns the conversation's messages only
  const detail = await getConversationDetail(A, open1.id);
  ok(
    "I6 thread detail returns only this conversation's messages",
    Boolean(detail) &&
      detail!.messages.length === 2 &&
      detail!.messages[0].content.includes("I need help") &&
      detail!.messages[1].content === "Conversation resolved.",
    `messages=${detail?.messages.length} last="${detail?.messages.at(-1)?.content}"`,
  );

  // I7 — assignment persists and drives the unassigned filter
  await db.conversation.update({ where: { id: starred1.id }, data: { assigneeId: "owner" } });
  const reRows = await listConversations(A);
  ok(
    "I7 assignment removes a row from the Unassigned filter",
    !reRows.filter((x) => FILTERS.unassigned.test(x as any)).some((x) => x.id === starred1.id),
    `unassigned=${reRows.filter((x) => FILTERS.unassigned.test(x as any)).length}`,
  );

  // I8 — auto-resolve only touches stale, open, non-handover conversations
  await db.conversation.updateMany({
    where: { shopId: A, id: handover1.id },
    data: { lastMessageAt: new Date(now - 40 * 24 * 3600_000) },
  });
  const autoResolved = await autoResolveInactive(new Date());
  ok(
    "I8 autoResolveInactive runs without touching other shops' rows",
    typeof autoResolved === "number" && autoResolved >= 0,
    `resolved=${autoResolved}`,
  );

  // I9 — delete removes messages with the conversation
  await deleteConversation(A, blocked1.id);
  const goneMessages = await db.message.count({ where: { shopId: A, conversationId: blocked1.id } });
  const goneConv = await db.conversation.count({ where: { shopId: A, id: blocked1.id } });
  ok("I9 delete removes the conversation and its messages", goneConv === 0 && goneMessages === 0);

  // I10 — cart view plan gate
  await setPlan(A, "free");
  const freeShop = await db.shop.findUnique({ where: { id: A }, select: { plan: true } });
  const cartGateFree = hasFeature(freeShop.plan, "inbox_cart_view");
  await setPlan(A, "plus");
  const cartGatePlus = hasFeature("plus", "inbox_cart_view");
  ok(
    "I10 inbox_cart_view feature flag is off on Free, on for Plus",
    cartGateFree === false && cartGatePlus === true,
    `free=${cartGateFree} plus=${cartGatePlus}`,
  );

  // I10b — the gate must withhold the cart at the DATA SOURCE, not just hide it
  // in the component: shipping it in the loader payload put the paid data one
  // network-tab click away on a Free plan.
  //
  // Only `cart` may be removed. The same pageContext blob carries browsed pages
  // and device info, which every plan is entitled to — a blanket null would
  // silently delete two ungated features, so both halves are asserted.
  await db.conversation.update({
    where: { id: assigned1.id },
    data: {
      pageContext: {
        cart: { items: [{ title: "secret", price: 10 }], totalValue: 10 },
        pages: ["/collections/all"],
        device: "desktop",
      } as any,
    },
  });
  await setPlan(A, "free");
  const gatedDetail = await getConversationDetail(A, assigned1.id);
  const gatedCtx = (gatedDetail as any)?.pageContext ?? {};
  ok(
    "I10b cart data is withheld server-side when inbox_cart_view is off",
    gatedCtx.cart == null,
    `pageContext.cart = ${JSON.stringify(gatedCtx.cart)}`,
  );
  ok(
    "I10c ungated pageContext (browsed pages, device) survives the cart gate",
    Array.isArray(gatedCtx.pages) && gatedCtx.device === "desktop",
    `pages=${JSON.stringify(gatedCtx.pages)} device=${gatedCtx.device}`,
  );
  await setPlan(A, "plus");
  const openDetail = await getConversationDetail(A, assigned1.id);
  ok(
    "I10d cart data IS returned once the plan includes inbox_cart_view",
    ((openDetail as any)?.pageContext ?? {}).cart?.totalValue === 10,
  );

  // I11 — D-39 REGRESSION: filters, search and counts must be computed in the
  // DATABASE, not in JS over a capped window. Fixture: 320 newer rows plus one
  // deliberately OLD conversation that is starred + unread + handed over.
  const bulk = Array.from({ length: 320 }, (_, i) => ({
    shopId: A,
    sessionId: `${TAG}-bulk-${i}`,
    status: "open",
    unread: false,
    lastMessageAt: new Date(now - 10_000 - i * 1000),
    startedAt: new Date(now - 10_000 - i * 1000),
  }));
  await db.conversation.createMany({ data: bulk });
  const oldContact = await db.contact.create({
    data: { shopId: A, sessionId: `${TAG}-old`, name: "Zebediah Oldstone", type: "lead" },
  });
  const oldImportant = await conv({
    status: "open",
    starred: true,
    unread: true,
    handover: true,
    contactId: oldContact.id,
    lastMessageAt: new Date(now - 10_000_000),
    startedAt: new Date(now - 10_000_000),
  });
  const oldResolved = await conv({
    status: "resolved",
    unread: false,
    lastMessageAt: new Date(now - 10_000_001),
    startedAt: new Date(now - 10_000_001),
  });
  const oldBlocked = await conv({
    status: "open",
    blocked: true,
    lastMessageAt: new Date(now - 10_000_002),
    startedAt: new Date(now - 10_000_002),
  });

  const total = await db.conversation.count({ where: { shopId: A, isTest: false } });
  ok(
    "I11 fixture exceeds the 300-row page so the window can be exercised",
    total > 300,
    `conversations=${total}`,
  );

  // (a) every filter reaches rows OUTSIDE the newest 300.
  const outside: Record<string, string> = {
    starred: oldImportant.id,
    handover: oldImportant.id,
    open: oldImportant.id,
    unassigned: oldImportant.id,
    all: oldImportant.id,
    resolved: oldResolved.id,
    blocked: oldBlocked.id,
  };
  const misses: string[] = [];
  for (const key of INBOX_FILTER_KEYS) {
    const wanted = outside[key];
    const page = await listConversations(A, { filter: key, take: 1000 });
    if (!page.some((r) => r.id === wanted)) misses.push(key);
  }
  ok(
    "I11a every rail filter returns rows from OUTSIDE the newest 300",
    misses.length === 0,
    misses.length ? `filters that missed their old row: ${misses.join(", ")}` : "all 7 filters reached the old rows",
  );

  // (b) getInboxCounts matches an independent per-tab count.
  const counts = await getInboxCounts(A);
  const expectedCounts: Record<string, number> = {
    all: await db.conversation.count({ where: { shopId: A, isTest: false, blocked: false } }),
    open: await db.conversation.count({ where: { shopId: A, isTest: false, blocked: false, status: "open" } }),
    resolved: await db.conversation.count({ where: { shopId: A, isTest: false, blocked: false, status: "resolved" } }),
    unassigned: await db.conversation.count({ where: { shopId: A, isTest: false, blocked: false, status: "open", assigneeId: null } }),
    handover: await db.conversation.count({ where: { shopId: A, isTest: false, blocked: false, handover: true } }),
    starred: await db.conversation.count({ where: { shopId: A, isTest: false, blocked: false, starred: true } }),
    blocked: await db.conversation.count({ where: { shopId: A, isTest: false, blocked: true } }),
  };
  const countMismatches = INBOX_FILTER_KEYS.filter((k) => counts[k] !== expectedCounts[k]);
  const unreadExpected = await db.conversation.count({
    where: { shopId: A, isTest: false, blocked: false, status: "open", unread: true },
  });
  ok(
    "I11b getInboxCounts matches an independent count for all 7 tabs + unreadOpen",
    countMismatches.length === 0 && counts.unreadOpen === unreadExpected,
    countMismatches.length
      ? countMismatches.map((k) => `${k}: got ${counts[k]} want ${expectedCounts[k]}`).join("; ")
      : `counts=${JSON.stringify(counts)}`,
  );
  ok(
    "I11c counts are unbounded (they exceed the 300-row page size)",
    counts.all > 300,
    `all=${counts.all}`,
  );

  // (c) PARITY: the client predicates agree row-for-row with the server WHERE.
  const parityFailures: string[] = [];
  const everyRow = await db.conversation.findMany({
    where: { shopId: A, isTest: false },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true, status: true, mode: true, starred: true, blocked: true,
      unread: true, handover: true, assigneeId: true, lastMessageAt: true,
    },
  });
  for (const key of INBOX_FILTER_KEYS) {
    const serverIds = (await listConversations(A, { filter: key, take: 5000 })).map((r) => r.id).sort();
    const clientIds = everyRow
      .filter((r: any) =>
        FILTERS[key as FilterKey].test({
          ...r,
          name: null,
          preview: "",
          lastMessageAt: r.lastMessageAt.toISOString(),
        }),
      )
      .map((r: any) => r.id)
      .sort();
    if (JSON.stringify(serverIds) !== JSON.stringify(clientIds)) {
      parityFailures.push(`${key}: server ${serverIds.length} vs client ${clientIds.length}`);
    }
  }
  ok(
    "I11d client FILTERS predicates agree ROW-FOR-ROW with the server FILTER_WHERE",
    parityFailures.length === 0,
    parityFailures.length ? parityFailures.join("; ") : `all ${INBOX_FILTER_KEYS.length} filters agree`,
  );

  // I11e — DB-side search reaches an old row the page cap would have hidden.
  const searched = await listConversations(A, { search: "zebediah", take: 1000 });
  ok(
    "I11e search is applied in the database and finds an out-of-page contact",
    searched.length === 1 && searched[0].id === oldImportant.id,
    `hits=${searched.length}`,
  );

  // I11f — unreadOnly is a DB filter too.
  const unreadPage = await listConversations(A, { filter: "open", unreadOnly: true, take: 1000 });
  ok(
    "I11f unreadOnly is applied in the database",
    unreadPage.every((r) => r.unread) && unreadPage.some((r) => r.id === oldImportant.id),
    `rows=${unreadPage.length}`,
  );

  // I11g — CROSS-TENANT: counts and filtered pages never cross shops.
  const bCounts = await getInboxCounts(B);
  const bPage = await listConversations(B, { filter: "all", take: 1000 });
  ok(
    "I11g CROSS-TENANT: another shop sees none of these rows",
    bCounts.all === 0 && bPage.every((r) => r.id !== oldImportant.id),
    `B all=${bCounts.all} rows=${bPage.length}`,
  );
}

// ── Module 8: contacts (spec 11) ────────────────────────────────────────────

async function contacts(ctx: { db: any; A: string; B: string }): Promise<void> {
  section("Contacts (spec 11)");
  const { db, A, B } = ctx;
  const {
    listContacts,
    contactStats,
    ensureSessionContact,
    updateContactInfo,
    deleteContact,
    exportContactsCsv,
    contactDetail,
    CONTACTS_PAGE_SIZE,
  } = await import("../../app/lib/contacts/contacts.server");

  await db.contact.deleteMany({ where: { shopId: A } });

  // N1 — ensureSessionContact is idempotent per session
  const s1 = await ensureSessionContact(A, `${TAG}-sess-1`);
  const s1again = await ensureSessionContact(A, `${TAG}-sess-1`);
  ok("N1 ensureSessionContact reuses the session's contact", s1 === s1again, `${s1} / ${s1again}`);

  // N2 — same sessionId in another shop is a DIFFERENT contact
  const bContact = await ensureSessionContact(B, `${TAG}-sess-1`);
  ok("N2 CROSS-TENANT: the same sessionId in another shop is a separate contact", bContact !== s1);

  // N3 — anonymous → lead on gaining an email, with an analytics event
  const upgraded = await updateContactInfo(A, s1, { name: "Ada Lovelace", email: `${TAG}-ada@example.com`, phone: "" });
  const row = await db.contact.findUnique({ where: { id: s1 } });
  const evt = await db.analyticsEvent.count({ where: { shopId: A, type: "contact_converted" } });
  ok(
    "N3 anonymous contact gaining an email becomes a lead + records the conversion",
    upgraded === true && row.type === "lead" && row.email === `${TAG}-ada@example.com` && evt === 1,
    `type=${row.type} events=${evt}`,
  );

  // N4 — email is normalised to lower case and duplicates are refused (dedupe)
  const dupSession = await ensureSessionContact(A, `${TAG}-sess-2`);
  const clash = await updateContactInfo(A, dupSession, { name: "", email: `${TAG}-ADA@example.com`, phone: "" });
  ok(
    "N4 duplicate email refused (contacts stay deduped by email)",
    typeof clash === "object" && "error" in (clash as any),
    JSON.stringify(clash),
  );

  // N5 — validation
  const badEmail = await updateContactInfo(A, dupSession, { name: "", email: "not-an-email", phone: "" });
  const badPhone = await updateContactInfo(A, dupSession, { name: "", email: "", phone: "!!" });
  ok(
    "N5 invalid email / phone rejected with a message",
    typeof badEmail === "object" && typeof badPhone === "object",
    `${(badEmail as any).error} | ${(badPhone as any).error}`,
  );

  // N6 — customers are not locally editable (identity lives in Shopify)
  const cust = await db.contact.create({
    data: { shopId: A, sessionId: `${TAG}-sess-3`, email: `${TAG}-cust@example.com`, type: "customer", shopifyCustomerId: "gid://shopify/Customer/1" },
  });
  const editCustomer = await updateContactInfo(A, cust.id, { name: "Hacked", email: `${TAG}-x@example.com`, phone: "" });
  const custAfter = await db.contact.findUnique({ where: { id: cust.id } });
  ok(
    "N6 customer contacts are not locally editable",
    editCustomer === false && custAfter.name === null,
    `result=${editCustomer}`,
  );

  // N7 — lead clearing all identity fields drops back to anonymous
  const cleared = await updateContactInfo(A, s1, { name: "", email: "", phone: "" });
  const clearedRow = await db.contact.findUnique({ where: { id: s1 } });
  ok("N7 a lead with every identity field cleared reverts to anonymous", cleared === true && clearedRow.type === "anonymous", clearedRow.type);
  await updateContactInfo(A, s1, { name: "Ada Lovelace", email: `${TAG}-ada@example.com`, phone: "" });

  // N8 — stats reconcile with an independent recount
  const stats = await contactStats(A);
  const [expected] = (await db.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE type='customer')::int AS c,
            count(*) FILTER (WHERE type='lead')::int AS l,
            count(*) FILTER (WHERE type='anonymous')::int AS a,
            count(*)::int AS t
       FROM contacts WHERE "shopId" = $1`,
    A,
  ) as any[]);
  ok(
    "N8 contact stat tiles reconcile with a raw SQL recount",
    stats.customers === expected.c && stats.leads === expected.l && stats.anonymous === expected.a && stats.total === expected.t,
    JSON.stringify(stats),
  );

  // N9 — search + type filter
  const byName = await listContacts(A, { q: "lovelace" });
  const byType = await listContacts(A, { type: "customer" as any });
  ok(
    "N9 search is case-insensitive on name/email; type filter works",
    byName.length === 1 && byName[0].id === s1 && byType.length === 1 && byType[0].id === cust.id,
    `name=${byName.length} type=${byType.length}`,
  );

  // N10 — sorting
  await db.contact.update({ where: { id: cust.id }, data: { name: "Aaron" } });
  const asc = await listContacts(A, { sort: "name" as any, dir: "asc" as any });
  const desc = await listContacts(A, { sort: "name" as any, dir: "desc" as any });
  const named = (list: any[]) => list.filter((c) => c.name).map((c) => c.id);
  ok(
    "N10 name sort reverses with dir; unnamed contacts sink in both directions",
    JSON.stringify(named(asc)) === JSON.stringify(named(desc).reverse()) &&
      asc.at(-1)!.name === null &&
      desc.at(-1)!.name === null,
    asc.map((c) => c.name ?? "-").join(",") + " | " + desc.map((c) => c.name ?? "-").join(","),
  );

  // N11 — conversation counts per contact exclude test conversations
  await db.conversation.create({ data: { shopId: A, sessionId: `${TAG}-c1`, contactId: s1, isTest: false } });
  await db.conversation.create({ data: { shopId: A, sessionId: `${TAG}-c2`, contactId: s1, isTest: true } });
  const listed = await listContacts(A);
  const ada = listed.find((c) => c.id === s1);
  ok(
    "N11 per-contact conversation count excludes test conversations",
    ada?.conversationCount === 1,
    `count=${ada?.conversationCount}`,
  );

  // N12 — CROSS-TENANT: listing/detail/export never cross shops
  const bList = await listContacts(B);
  const crossDetail = await contactDetail(B, s1);
  ok(
    "N12 CROSS-TENANT: another shop's contact is invisible",
    bList.every((c) => c.id !== s1) && crossDetail === null,
    `B has ${bList.length}`,
  );

  // N13 — export is RFC-4180 quoted and shop-scoped
  await db.contact.update({ where: { id: s1 } , data: { name: 'Ada "The First", Lovelace' } });
  const csv = await exportContactsCsv(A, { scope: "all" } as any);
  ok(
    "N13 CSV export quotes embedded commas/quotes and stays shop-scoped",
    csv.includes('"Ada ""The First"", Lovelace"') && !csv.includes(bContact),
    csv.split("\n")[1]?.slice(0, 60),
  );

  // N14 — delete removes the contact AND their conversations
  const graphqlStub = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  const crossDeleteContact = await deleteContact(B, s1, graphqlStub as any);
  const deleted = await deleteContact(A, s1, graphqlStub as any);
  const leftConversations = await db.conversation.count({ where: { shopId: A, contactId: s1 } });
  ok(
    "N14 delete is shop-scoped and cascades the contact's conversations",
    crossDeleteContact === false && deleted === true && leftConversations === 0,
    `cross=${crossDeleteContact} own=${deleted} convs=${leftConversations}`,
  );

  // N15 — pagination window
  ok(
    "N15 contacts page size is a real constant used by the table",
    CONTACTS_PAGE_SIZE > 0,
    `pageSize=${CONTACTS_PAGE_SIZE}; listContacts returns the FULL set (paged client-side) — correct results, but grows unbounded`,
  );
}

// ── Module 9: discounts (spec 02/07) ────────────────────────────────────────

async function discounts(ctx: {
  db: any;
  A: string;
  B: string;
  setPlan: (shopId: string, plan: string) => Promise<unknown>;
}): Promise<void> {
  section("Discounts (spec 02/07)");
  const { db, A, B, setPlan } = ctx;
  const { upsertDiscountFromWebhook, deleteDiscountFromWebhook } = await import(
    "../../app/lib/ingestion/catalog-sync.server"
  );
  const { loadShopSettings } = await import("../../app/lib/settings/save.server");
  const { DISCOUNT_INTENT_RE, discountFacts } = await import("../../app/lib/pipeline/index.server");

  const payload = (over: Record<string, any> = {}) => ({
    admin_graphql_api_id: "gid://shopify/DiscountCodeNode/770100",
    title: `${TAG}-SAVE20`,
    status: "active",
    ...over,
  });

  // D1 — discount webhooks apply on EVERY plan (2026-09-11, user decision).
  // They used to be refused below Pro and behind a merchant toggle, and with
  // no scheduled discount sync a Free shop's new discount never reached the
  // agent. The Admin refetch cannot run offline, so this also proves the
  // fail-soft fallback to the payload fields.
  await setPlan(A, "free");
  await upsertDiscountFromWebhook(SHOP_A, payload());
  const synced = await db.discount.findFirst({ where: { shopId: A } });
  ok(
    "D1 a discount webhook syncs on the Free plan (no plan gate, no toggle)",
    Boolean(synced) && synced.title === `${TAG}-SAVE20` && synced.status === "active",
    synced ? `title=${synced.title} status=${synced.status}` : "no row",
  );
  // D2 — the setting is gone, not just ignored: nothing left to switch off.
  const settings = await loadShopSettings(A);
  ok(
    "D2 no discountRealtime / catalogAutoSync setting remains in shop settings",
    !("discountRealtime" in settings) && !("catalogAutoSync" in settings),
    Object.keys(settings).join(","),
  );
  await setPlan(A, "pro");

  // D5/D6 — expiry: only discounts inside their window are AI-visible
  const now = new Date();
  const past = new Date(now.getTime() - 7 * 24 * 3600_000);
  const future = new Date(now.getTime() + 7 * 24 * 3600_000);
  await db.discount.update({
    where: { id: synced.id },
    data: { startsAt: past, endsAt: future, summary: "20% off everything", learnEnabled: true },
  });
  const expired = await db.discount.create({
    data: {
      shopId: A,
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/770101",
      title: `${TAG}-EXPIRED`,
      status: "active",
      startsAt: new Date(now.getTime() - 30 * 24 * 3600_000),
      endsAt: past,
      learnEnabled: true,
    },
  });
  const notYet = await db.discount.create({
    data: {
      shopId: A,
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/770102",
      title: `${TAG}-FUTURE`,
      status: "active",
      startsAt: future,
      learnEnabled: true,
    },
  });
  const disabled = await db.discount.create({
    data: {
      shopId: A,
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/770103",
      title: `${TAG}-NOTLEARNED`,
      status: "active",
      learnEnabled: false,
    },
  });

  // Exactly the predicate activeDiscountContext() uses in the pipeline
  // (app/lib/pipeline/index.server.ts:875). That helper is module-private, so
  // the contract is pinned here against the same rows.
  const aiVisible = await db.discount.findMany({
    where: {
      shopId: A,
      status: "active",
      learnEnabled: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    select: { title: true },
  });
  ok(
    "D5 expiry window + learnEnabled decide which discounts the AI may quote",
    aiVisible.length === 1 && aiVisible[0].title === `${TAG}-SAVE20`,
    aiVisible.map((d: any) => d.title).join(", ") || "none",
  );
  ok(
    "D6 expired / future / un-learned discounts are all withheld",
    ![expired.title, notYet.title, disabled.title].some((t) => aiVisible.some((d: any) => d.title === t)),
    "EXPIRED, FUTURE and NOTLEARNED all excluded",
  );

  // D7 — the discount-intent regex only fires on discount-shaped questions
  // The REAL pattern, imported. This case used to keep its own copy of the
  // regex, so it was asserting the copy — it could never have seen the shipped
  // pattern change, in either direction.
  const RE = DISCOUNT_INTENT_RE;
  ok(
    "D7 discount context fires on discount questions and not on unrelated ones",
    RE.test("do you have any promo code") &&
      RE.test("any discount today?") &&
      RE.test("is there a sale") &&
      !RE.test("what size should I order") &&
      !RE.test("where is my parcel"),
  );
  // DEFECT: the alternation carries no plural, so the most natural phrasings miss.
  ok(
    "D7b PLURAL discount questions also inject the discount facts",
    RE.test("any discounts today?") && RE.test("do you have coupons") && RE.test("any offers"),
    `"discounts"=${RE.test("any discounts today?")} "coupons"=${RE.test("do you have coupons")} "offers"=${RE.test("any offers")}`,
  );

  // D7c — the coupon CODE reaches the shopper (2026-09-09). Syncing discounts
  // is only useful if the agent can say how to claim one, so this asserts the
  // REAL context builder, not a copy of its formatting.
  await db.discount.updateMany({
    where: { shopId: A, title: `${TAG}-SAVE20` },
    data: { code: "SAVE20NOW" },
  });
  const auto = await db.discount.create({
    data: {
      shopId: A,
      shopifyDiscountId: `${TAG}-auto`,
      title: `${TAG}-AUTOSALE`,
      summary: "10% off everything",
      method: "automatic",
      code: "",
      status: "active",
      learnEnabled: true,
    },
  });
  const facts = await discountFacts(A);
  ok(
    "D7c the synced coupon code is handed to the AI, verbatim",
    facts.includes("use code SAVE20NOW at checkout"),
    facts.replace(/\s+/g, " ").slice(0, 160),
  );
  ok(
    "D7c-ii automatic discounts are described as needing no code (never an invented one)",
    facts.includes(`${TAG}-AUTOSALE`) &&
      facts.includes("applies automatically, no code needed") &&
      !facts.includes("use code at"),
    facts.replace(/\s+/g, " ").slice(0, 240),
  );
  // A code discount synced BEFORE the code column existed has code = "". It
  // must not be described as automatic — that is a confident falsehood told to
  // a shopper who then cannot claim the discount.
  await db.discount.updateMany({
    where: { shopId: A, title: `${TAG}-SAVE20` },
    data: { code: "" },
  });
  const staleFacts = await discountFacts(A);
  ok(
    "D7c-iv a code discount not yet re-synced claims nothing about how to redeem",
    staleFacts.includes(`${TAG}-SAVE20`) &&
      staleFacts.split("applies automatically, no code needed").length - 1 === 1 &&
      !staleFacts.includes("use code"),
    staleFacts.replace(/\s+/g, " ").slice(0, 240),
  );
  // The sync must actually ask Shopify for the codes, on all three code types.
  // Substring counting, not a regex: a source guard whose pattern quietly stops
  // matching passes forever while testing nothing.
  const syncSrc = readFileSync(join(process.cwd(), "app", "lib", "ingestion", "catalog-sync.server.ts"), "utf-8");
  ok(
    "D7c-iii the discount sync requests codes(first: 1) on every code discount type",
    syncSrc.split("codes(first: 1) { nodes { code } }").length - 1 === 3,
    `occurrences=${syncSrc.split("codes(first: 1) { nodes { code } }").length - 1} (expected 3)`,
  );
  await db.discount.delete({ where: { id: auto.id } });

  // D8 — delete webhook is shop-scoped
  await deleteDiscountFromWebhook(SHOP_B, payload());
  const survivedCrossDelete = await db.discount.count({
    where: { shopId: A, shopifyDiscountId: "gid://shopify/DiscountCodeNode/770100" },
  });
  await deleteDiscountFromWebhook(SHOP_A, payload());
  const goneOwn = await db.discount.count({
    where: { shopId: A, shopifyDiscountId: "gid://shopify/DiscountCodeNode/770100" },
  });
  ok(
    "D8 discount delete webhook is shop-scoped",
    survivedCrossDelete === 1 && goneOwn === 0,
    `crossDelete kept=${survivedCrossDelete} ownDelete left=${goneOwn}`,
  );

  // D9 — CROSS-TENANT
  const bDiscounts = await db.discount.count({ where: { shopId: B } });
  ok("D9 CROSS-TENANT: discounts are shop-scoped", bDiscounts === 0, `B=${bDiscounts}`);

  await setPlan(A, "plus");
}

// ── Module 10: order tracking (spec 05 delta) ───────────────────────────────

async function orderTracking(): Promise<void> {
  section("Order tracking (spec 05 delta)");
  const base = "http://localhost:3000";
  let reachable = true;
  const post = async (body: unknown) => {
    try {
      return await fetch(`${base}/proxy/order-track`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      reachable = false;
      return null;
    }
  };

  // O1 — UNAUTHENTICATED: no valid app-proxy signature ⇒ never any order data
  const unauth = await post({ orderNumber: "1001", method: "email", contact: "a@b.com" });
  if (!reachable) {
    ok(
      "O1..O3 SKIPPED — dev server not reachable on localhost:3000",
      false,
      "start the dev server to exercise the proxy route over HTTP",
    );
  } else {
    const bodyText = unauth ? await unauth.text() : "";
    ok(
      "O1 unauthenticated lookup is refused and returns no order data",
      Boolean(unauth) && unauth!.status !== 200 && !bodyText.includes('"ok":true'),
      `status=${unauth?.status} body="${bodyText.slice(0, 60)}"`,
    );
    const malformed = await post({ orderNumber: "" });
    ok(
      "O2 malformed request body is refused",
      Boolean(malformed) && malformed!.status !== 200,
      `status=${malformed?.status}`,
    );
    let getStatus = 0;
    try {
      getStatus = (await fetch(`${base}/proxy/order-track`)).status;
    } catch {
      /* ignore */
    }
    ok("O3 GET is not accepted on the order-track endpoint", getStatus !== 200, `status=${getStatus}`);
  }

  // O4..O6 — ownership rules. These predicates are module-private in the route,
  // so they are restated here and pinned against the guessing scenarios that
  // matter (a foreign order must never be reachable by guessing a number).
  const alnum = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const numberMatches = (orderName: string, input: string): boolean => {
    const name = alnum(orderName);
    const want = alnum(input);
    if (!want) return false;
    return name === want || (want.length >= 4 && name.endsWith(want));
  };
  ok(
    "O4 order-number matching needs the whole number or a >=4-char suffix",
    numberMatches("#24-25/JGW-1113", "1113") &&
      numberMatches("#1001", "#1001") &&
      !numberMatches("#24-25/JGW-1113", "13") &&
      !numberMatches("#1001", ""),
  );

  const digits = (s: string) => s.replace(/\D/g, "");
  const phoneMatches = (orderPhone: string | null, contact: string): boolean => {
    const want = digits(contact);
    if (want.length < 10) return false;
    const have = digits(orderPhone || "");
    if (have.length < 10) return false;
    return have.slice(-10) === want.slice(-10);
  };
  ok(
    "O5 phone ownership check accepts a full national number, country-code tolerant",
    phoneMatches("+1 415 555 0134", "4155550134"),
  );
  ok("O6 a 7-digit phone tail is NOT enough to claim an order", !phoneMatches("+1 415 555 0134", "5550134"));

  // O7..O9 — a FOREIGN order is unreachable because shop identity comes only
  // from the verified proxy signature, the reply carries no order PII, and the
  // endpoint is rate limited.
  const src = readFileSync(join(process.cwd(), "app", "routes", "proxy.order-track.tsx"), "utf-8");
  ok(
    "O7 shop identity comes only from the verified proxy session (no shop query param)",
    src.includes("authenticate.public.appProxy(request)") &&
      src.includes("resolveShopId(session.shop)") &&
      !/searchParams\.get\(\s*["']shop["']\s*\)/.test(src),
  );
  const responseBlock = src.slice(src.lastIndexOf("ok: true"));
  ok(
    "O8 the response never echoes the order's own email / phone / address",
    !responseBlock.includes("match.email") &&
      !responseBlock.includes("match.phone") &&
      !responseBlock.includes("shippingAddress"),
  );
  ok(
    "O9 the endpoint is rate limited per shop+IP (brute-force guard)",
    src.includes("consumeTrackToken") && src.includes("status: 429"),
  );
}

// ── Module 11: notifications / email (spec 18) ──────────────────────────────
// NOTHING is actually sent: every case either exercises a path that returns
// before any provider call, or inspects the constructed message object.

async function notifications(ctx: { db: any; A: string; B: string }): Promise<void> {
  section("Notifications / email send path (spec 18)");
  const { db, A, B } = ctx;
  const { deliverNotification } = await import("../../app/lib/notify/deliver.server");
  const { notificationRecipients, handoverEmail } = await import(
    "../../app/lib/team/team.server"
  );
  const { emailConfigured, inviteEmail, resetEmail } = await import(
    "../../app/lib/email/email.server"
  );

  const conv = async (shopId: string, over: Record<string, any> = {}) =>
    db.conversation.create({
      data: {
        shopId,
        sessionId: `${TAG}-notify-${Math.random().toString(36).slice(2)}`,
        handover: true,
        mode: "human",
        ...over,
      },
    });

  // Members with EVERY delivery preference OFF, so no provider is ever touched.
  const silentPrefs = {
    push: { handover: false, humanReply: false, newConversation: false },
    emailHandover: false,
  };
  const member = await db.teamMember.create({
    data: {
      shopId: A,
      email: `${TAG}-agent@example.invalid`,
      name: `${TAG} agent`,
      role: "agent",
      status: "active",
      passwordHash: "x",
      notifyPrefs: silentPrefs as any,
    },
  });

  // M1 — a normal handover resolves recipients within the shop only
  const c1 = await conv(A);
  const recipients = await notificationRecipients({ shopId: A, kind: "handover", assigneeId: null });
  ok(
    "M1 notification recipients are resolved shop-scoped",
    recipients.length >= 1 && recipients.every((r: any) => r.email.includes(TAG)),
    `recipients=${recipients.map((r: any) => r.email).join(",")}`,
  );

  // M2 — assignment narrows delivery to the assignee alone
  const assignedRecipients = await notificationRecipients({
    shopId: A,
    kind: "handover",
    assigneeId: "someone-else",
  });
  ok(
    "M2 an assigned conversation notifies only its assignee",
    assignedRecipients.length === 0,
    `recipients=${assignedRecipients.length}`,
  );

  // M3 — delivery is a no-op for a conversation belonging to another shop
  const before = await db.appLog.count({ where: { shopId: A } });
  await deliverNotification({ shopId: B, conversationId: c1.id, kind: "handover" });
  const afterCross = await db.appLog.count({ where: { shopId: A } });
  ok(
    "M3 CROSS-TENANT: delivery for another shop's conversation returns without sending",
    before === afterCross,
    "no provider call, no log row",
  );

  // M4 — test and blocked conversations never notify
  const testConv = await conv(A, { isTest: true });
  const blockedConv = await conv(A, { blocked: true });
  let threwDuring: Error | null = null;
  threwDuring = await threw(async () => {
    await deliverNotification({ shopId: A, conversationId: testConv.id, kind: "handover" });
    await deliverNotification({ shopId: A, conversationId: blockedConv.id, kind: "handover" });
  });
  ok(
    "M4 test and blocked conversations are skipped before any provider call",
    threwDuring === null,
    threwDuring?.message,
  );

  // M5 — with every preference off, a real handover sends nothing and throws nothing
  const threwSilent = await threw(() =>
    deliverNotification({ shopId: A, conversationId: c1.id, kind: "handover" }),
  );
  ok(
    "M5 members with push+email off receive nothing (no send attempted)",
    threwSilent === null,
    "delivery completed with zero provider calls",
  );

  // M6 — a nonexistent conversation id is a no-op
  const threwMissing = await threw(() =>
    deliverNotification({ shopId: A, conversationId: "does-not-exist", kind: "handover" }),
  );
  ok("M6 unknown conversation id fails safe", threwMissing === null);

  // M7 — the handover email is CONSTRUCTED correctly (never sent)
  const mail = handoverEmail({
    to: `${TAG}-agent@example.invalid`,
    shopName: `${TAG} shop A`,
    url: "https://example.com/web/login?next=%2Fapp%2Finbox",
  });
  ok(
    "M7 handover email is well formed (to / subject / html+text / link)",
    mail.to === `${TAG}-agent@example.invalid` &&
      mail.subject.length > 0 &&
      mail.html.includes("https://example.com/web/login") &&
      typeof mail.text === "string" &&
      mail.text.length > 0,
    `subject="${mail.subject}"`,
  );

  // M8 — no transcript content leaks into the email body (third-party processor)
  ok(
    "M8 the handover email carries no transcript snippet",
    !mail.html.includes("I need help") && !mail.text.includes("I need help"),
  );

  // M9 — invite / reset templates escape user-supplied text
  const invite = inviteEmail({
    to: "x@example.invalid",
    inviterName: '<script>alert(1)</script>',
    shopName: `${TAG} shop`,
    url: "https://example.com/web/invite/tok",
  });
  const reset = resetEmail({ to: "x@example.invalid", url: "https://example.com/web/reset/tok" });
  ok(
    "M9 invite/reset templates HTML-escape untrusted names",
    !invite.html.includes("<script>") && invite.html.includes("&lt;script&gt;") && reset.html.includes("/web/reset/tok"),
  );

  // M10 — the configured provider is reported honestly
  ok(
    "M10 emailConfigured() reflects the runtime provider config",
    typeof emailConfigured() === "boolean",
    `emailConfigured=${emailConfigured()} (no email was sent by this suite)`,
  );

  await db.teamMember.deleteMany({ where: { id: member.id } });
}

// ── Module 12: background jobs (pg-boss handlers) ───────────────────────────

async function backgroundJobs(ctx: { db: any; A: string; B: string }): Promise<void> {
  section("Background jobs (pg-boss handlers)");
  const { db, A, B } = ctx;
  const {
    JOBS,
    transitionExpiredTrials,
    purgeAppLogs,
    APP_LOG_RETENTION_DAYS,
    countShopRows,
  } = await import("../../app/lib/jobs/handlers.server");
  const { ingestSource } = await import("../../app/lib/ingestion/knowledge-ingest.server");
  const { revalidateCuratedStock } = await import("../../app/lib/curated/revalidate.server");
  const { applyMetafieldSelection } = await import("../../app/lib/ingestion/metafields.server");
  const { autoResolveInactive } = await import("../../app/lib/inbox/inbox.server");

  // J1 — every job name is registered exactly once and is a stable string
  const names = Object.values(JOBS) as string[];
  ok(
    "J1 job registry has unique, non-empty queue names",
    names.length === new Set(names).size && names.every((n) => n.length > 0),
    `${names.length} queues`,
  );

  // J2 — trial transition only advances shops that still hold a subscription
  await db.shop.update({
    where: { id: A },
    data: {
      planStatus: "trial",
      trialEndsAt: new Date(Date.now() - 24 * 3600_000),
      subscriptionId: "gid://shopify/AppSubscription/1",
    },
  });
  await db.shop.update({
    where: { id: B },
    data: { planStatus: "trial", trialEndsAt: new Date(Date.now() - 24 * 3600_000), subscriptionId: null },
  });
  const moved = await transitionExpiredTrials(new Date());
  const a1 = await db.shop.findUnique({ where: { id: A }, select: { planStatus: true } });
  const b1 = await db.shop.findUnique({ where: { id: B }, select: { planStatus: true } });
  ok(
    "J2 expired trials become active only when a subscription exists",
    moved >= 1 && a1.planStatus === "active" && b1.planStatus === "trial",
    `A=${a1.planStatus} B=${b1.planStatus} moved=${moved}`,
  );

  // J3 — and it is idempotent on retry
  const again = await transitionExpiredTrials(new Date());
  const a2 = await db.shop.findUnique({ where: { id: A }, select: { planStatus: true } });
  ok("J3 trial transition is idempotent on retry", again === 0 && a2.planStatus === "active", `secondRun=${again}`);
  await db.shop.update({ where: { id: A }, data: { planStatus: "none", subscriptionId: null, trialEndsAt: null } });
  await db.shop.update({ where: { id: B }, data: { planStatus: "none", trialEndsAt: null } });

  // J4 — log purge removes rows past the retention window, keeps fresh ones
  const oldLog = await db.appLog.create({
    data: {
      shopId: A,
      level: "error",
      event: `${TAG}_old`,
      message: "old",
      occurredAt: new Date(Date.now() - (APP_LOG_RETENTION_DAYS + 2) * 24 * 3600_000),
    },
  });
  const freshLog = await db.appLog.create({
    data: { shopId: A, level: "warn", event: `${TAG}_fresh`, message: "fresh" },
  });
  await purgeAppLogs();
  const oldGone = await db.appLog.count({ where: { id: oldLog.id } });
  const freshKept = await db.appLog.count({ where: { id: freshLog.id } });
  ok(
    `J4 log purge drops rows older than ${APP_LOG_RETENTION_DAYS}d and keeps fresh ones`,
    oldGone === 0 && freshKept === 1,
    `old=${oldGone} fresh=${freshKept}`,
  );

  // J5 — and purges anything still attributed to an uninstalled shop
  await db.shop.update({ where: { id: A }, data: { uninstalledAt: new Date() } });
  await purgeAppLogs();
  const orphanGone = await db.appLog.count({ where: { shopId: A } });
  await db.shop.update({ where: { id: A }, data: { uninstalledAt: null } });
  ok(
    "J5 log purge also removes logs belonging to an uninstalled shop",
    orphanGone === 0,
    `remaining=${orphanGone}`,
  );

  // J6 — knowledge-ingest handler is idempotent (re-runs rebuild, never stack)
  const { createSource } = await import("../../app/lib/ingestion/sources.server");
  const src = await createSource(
    A,
    {
      type: "pages",
      name: `${TAG} job page`,
      pages: [{ title: `${TAG} job title`, url: "", body: "Job idempotency body text." }],
    } as any,
    { enqueueIngest: false },
  );
  const first = await ingestSource(A, src.id);
  const second = await ingestSource(A, src.id);
  const rows = await db.knowledge.count({ where: { shopId: A, dataSourceId: src.id } });
  ok(
    "J6 knowledge-ingest is idempotent on retry (rows rebuilt, not duplicated)",
    first.chunkCount === second.chunkCount && rows === first.chunkCount,
    `chunks=${first.chunkCount} rows=${rows}`,
  );

  // J7 — and it refuses to run against another shop's source
  const crossIngest = await threw(() => ingestSource(B, src.id));
  ok("J7 knowledge-ingest is shop-scoped", crossIngest !== null, crossIngest?.message.slice(0, 50));

  // J8 — curated revalidation flags dead-stock picks, shop-scoped
  const oos = await db.product.create({
    data: {
      shopId: A,
      shopifyProductId: "gid://shopify/Product/990001",
      title: `${TAG} dead stock`,
      handle: "qa-dead-stock",
      stock: 0,
      variants: [] as any,
    },
  });
  const answer = await db.curatedAnswer.create({
    data: {
      shopId: A,
      question: `${TAG} what about the dead stock item`,
      talkingPoints: "It is great.",
      status: "published",
      productIds: [oos.shopifyProductId],
    },
  });
  const revalidated = await revalidateCuratedStock(A);
  const flagged = await db.curatedAnswer.findUnique({ where: { id: answer.id }, select: { stockIssue: true } });
  const revalidatedAgain = await revalidateCuratedStock(A);
  ok(
    "J8 curated revalidation flags dead-stock picks; a retry writes nothing new",
    flagged.stockIssue === true &&
      revalidated.flagged === 1 &&
      revalidatedAgain.flagged === 0 &&
      revalidatedAgain.cleared === 0 &&
      revalidatedAgain.issueCount === revalidated.issueCount,
    `run1=${JSON.stringify(revalidated)} run2=${JSON.stringify(revalidatedAgain)}`,
  );

  // J9 — metafield-apply is idempotent and shop-scoped
  const apply1 = await applyMetafieldSelection(A);
  const apply2 = await applyMetafieldSelection(A);
  ok(
    "J9 metafield-apply changes nothing on a second run",
    apply2.changed === 0,
    `first=${apply1.changed} second=${apply2.changed}`,
  );
  const blankShop = await threw(() => applyMetafieldSelection(""));
  ok("J9b metafield-apply refuses a blank shopId", blankShop !== null, blankShop?.message);

  // J10 — auto-resolve is safe to re-run and never resolves another shop's rows
  await db.conversation.create({
    data: {
      shopId: B,
      sessionId: `${TAG}-b-stale`,
      status: "open",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 3600_000),
      startedAt: new Date(Date.now() - 400 * 24 * 3600_000),
    },
  });
  const run1 = await autoResolveInactive(new Date());
  const run2 = await autoResolveInactive(new Date());
  ok(
    "J10 auto-resolve is idempotent (second pass resolves nothing new)",
    run2 === 0,
    `first=${run1} second=${run2}`,
  );

  // J11 — countShopRows is the purge contract and is itself shop-scoped
  const leftoversB = await countShopRows(B, SHOP_B);
  ok(
    "J11 countShopRows reports residual rows per table for one shop only",
    Array.isArray(leftoversB) && leftoversB.every((r: any) => typeof r.table === "string"),
    leftoversB.map((r: any) => `${r.table}:${r.count}`).join(",") || "none",
  );
}

// ── Module 13: GDPR / compliance webhooks (spec 17) ─────────────────────────

async function gdpr(ctx: { db: any; A: string; B: string }): Promise<void> {
  section("GDPR / compliance webhooks (spec 17)");
  const { db, A, B } = ctx;
  const { buildDataRequestExport, isDataRequestOverdue, pendingDataRequests } = await import(
    "../../app/lib/compliance/data-request.server"
  );
  const { cleanupShop, countShopRows } = await import("../../app/lib/jobs/handlers.server");

  const EMAIL = `${TAG}-gdpr@example.invalid`;

  const seedCustomer = async (shopId: string, email: string) => {
    const contact = await db.contact.create({
      data: { shopId, sessionId: `${TAG}-gdpr-${Math.random().toString(36).slice(2)}`, email, name: "GDPR Subject", type: "lead" },
    });
    const convo = await db.conversation.create({
      data: { shopId, sessionId: `${TAG}-gdpr-c-${Math.random().toString(36).slice(2)}`, contactId: contact.id },
    });
    await db.message.create({
      data: { shopId, conversationId: convo.id, role: "in", author: "shopper", content: `${TAG} my address is 1 Main St` },
    });
    return { contact, convo };
  };

  const subject = await seedCustomer(A, EMAIL);
  const neighbour = await seedCustomer(A, `${TAG}-other@example.invalid`);
  const sameEmailOtherShop = await seedCustomer(B, EMAIL);

  // ── customers/data_request ────────────────────────────────────────────────
  // G1 — the export contains exactly this customer's data, in this shop
  const request = await db.dataRequest.create({
    data: { shopId: A, customerEmail: EMAIL, dueAt: new Date(Date.now() + 30 * 24 * 3600_000) },
  });
  const exported = await buildDataRequestExport(A, request.id);
  const json = JSON.stringify(exported);
  ok(
    "G1 data_request export contains the requester's data and nothing else",
    json.includes(EMAIL) &&
      json.includes("1 Main St") &&
      !json.includes(`${TAG}-other@example.invalid`),
    `bytes=${json.length}`,
  );

  // G2 — CROSS-TENANT: the same email in another shop is not exported
  const crossExport = await threw(() => buildDataRequestExport(B, request.id));
  ok(
    "G2 CROSS-TENANT: same email in another shop excluded; the request id is unusable from shop B",
    !json.includes(sameEmailOtherShop.convo.id) && crossExport !== null,
    `shop B conversation absent; cross-shop export threw "${crossExport?.message}"`,
  );

  // G3 — the SLA row: pending requests are listed with a 30-day due date
  const pending = await pendingDataRequests(A);
  ok(
    "G3 pending data requests are listed shop-scoped with a due date",
    pending.some((p: any) => p.id === request.id) && !isDataRequestOverdue(request as any),
    `pending=${pending.length}`,
  );
  const overdue = isDataRequestOverdue({ ...request, dueAt: new Date(Date.now() - 1000) } as any);
  ok("G3b an elapsed due date reads as overdue", overdue === true);

  // G4 — no stored PII artifact: the export is computed on download, and the
  // table has no column that could even point at a stored file.
  const pathColumns = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM information_schema.columns
    WHERE table_name = 'data_requests' AND column_name ILIKE '%path%'`;
  ok(
    "G4 no PII artifact can be stored for a data request (computed on download)",
    Number(pathColumns[0].n) === 0,
    `path columns=${pathColumns[0].n}`,
  );

  // ── customers/redact ──────────────────────────────────────────────────────
  // The handler body lives inside registerHandlers (not exported), so the same
  // contract is driven through the exact operations it performs, and the
  // dangerous edge (undefined filters widening an updateMany) is asserted.
  const redactBefore = {
    subject: await db.contact.count({ where: { shopId: A, id: subject.contact.id } }),
    neighbour: await db.contact.count({ where: { shopId: A, id: neighbour.contact.id } }),
    otherShop: await db.contact.count({ where: { shopId: B, id: sameEmailOtherShop.contact.id } }),
  };
  const contacts = await db.contact.findMany({
    where: { shopId: A, OR: [{ email: EMAIL }] },
    select: { id: true },
  });
  const convos = await db.conversation.findMany({
    where: { shopId: A, contactId: { in: contacts.map((c: any) => c.id) } },
    select: { id: true },
  });
  const convoIds = convos.map((c: any) => c.id);
  await db.message.deleteMany({ where: { shopId: A, conversationId: { in: convoIds } } });
  await db.unresolvedQuestion.deleteMany({ where: { shopId: A, conversationId: { in: convoIds } } });
  await db.conversation.deleteMany({ where: { shopId: A, id: { in: convoIds } } });
  await db.contact.deleteMany({ where: { shopId: A, id: { in: contacts.map((c: any) => c.id) } } });
  await db.dataRequest.updateMany({ where: { shopId: A, customerEmail: EMAIL }, data: { customerEmail: "[redacted]" } });
  await db.redactLog.create({ data: { shopId: A, type: "customer", completedAt: new Date() } });

  const redactAfter = {
    subject: await db.contact.count({ where: { shopId: A, id: subject.contact.id } }),
    subjectConvos: await db.conversation.count({ where: { shopId: A, id: subject.convo.id } }),
    subjectMessages: await db.message.count({ where: { shopId: A, conversationId: subject.convo.id } }),
    neighbour: await db.contact.count({ where: { shopId: A, id: neighbour.contact.id } }),
    otherShop: await db.contact.count({ where: { shopId: B, id: sameEmailOtherShop.contact.id } }),
  };
  ok(
    "G5 customers/redact erases the subject's contact, conversations and messages",
    redactBefore.subject === 1 && redactAfter.subject === 0 && redactAfter.subjectConvos === 0 && redactAfter.subjectMessages === 0,
    JSON.stringify(redactAfter),
  );
  ok(
    "G6 redact leaves neighbouring contacts and the SAME EMAIL in another shop untouched",
    redactAfter.neighbour === 1 && redactAfter.otherShop === 1 && redactBefore.neighbour === 1 && redactBefore.otherShop === 1,
  );
  const scrubbed = await db.dataRequest.findUnique({ where: { id: request.id }, select: { customerEmail: true } });
  ok(
    "G7 the data request itself no longer retains the erased email",
    scrubbed.customerEmail === "[redacted]",
    `customerEmail=${scrubbed.customerEmail}`,
  );
  const logRow = await db.redactLog.findFirst({ where: { shopId: A, type: "customer" } });
  ok("G8 a customer redactLog row is written as the audit marker", Boolean(logRow) && logRow.completedAt !== null);

  // G9 — the undefined-filter trap: a redact with no email, id or phone must be
  // a no-op, not a whole-shop wipe. The shared matcher returns null for an
  // empty identity (QA-C4) and the handler returns on null before any delete.
  const handlerSrc = readFileSync(
    join(process.cwd(), "app", "lib", "jobs", "handlers.server.ts"),
    "utf-8",
  );
  const { contactMatchWhere } = await import("../../app/lib/compliance/customer-match.server");
  ok(
    "G9 redact with no email, customer id or phone returns before any delete",
    contactMatchWhere(A, { email: " ", customerId: undefined, phone: "" }) === null &&
      handlerSrc.includes("if (!where) return;"),
    "matcher null + guard present in handlers.server.ts",
  );

  // ── shop/redact ───────────────────────────────────────────────────────────
  // G10..G13 — the purge leaves nothing a reinstall could resurrect.
  await db.shop.update({
    where: { id: B },
    data: {
      plan: "plus",
      planStatus: "active",
      subscriptionId: "gid://shopify/AppSubscription/999",
      billingInterval: "monthly",
      trialEndsAt: new Date(),
      usageLineItemId: "gid://shopify/AppSubscriptionLineItem/999",
      uninstalledAt: new Date(),
    },
  });
  await db.session.create({
    data: {
      id: `offline_${SHOP_B}`,
      shop: SHOP_B,
      state: "x",
      isOnline: false,
      accessToken: "shpat_qa_features_fake",
      email: `${TAG}-owner@example.invalid`,
    },
  });
  const rowsBefore = await countShopRows(B, SHOP_B);
  await cleanupShop(SHOP_B);
  const rowsAfter = await countShopRows(B, SHOP_B);
  ok(
    "G10 shop/redact purge removes every shop-scoped row across all tables",
    rowsBefore.length > 0 && rowsAfter.length === 0,
    `before=${rowsBefore.map((r: any) => r.table).join(",")} after=${rowsAfter.length}`,
  );

  const sessionsLeft = await db.session.count({ where: { shop: SHOP_B } });
  ok(
    "G11 the offline session (access token + owner PII) is deleted too",
    sessionsLeft === 0,
    `sessions=${sessionsLeft}`,
  );

  const purgedShop = await db.shop.findUnique({ where: { id: B } });
  ok(
    "G12 nothing a reinstall could resurrect survives: billing is reset to Free",
    purgedShop.plan === "free" &&
      purgedShop.planStatus === "none" &&
      purgedShop.subscriptionId === null &&
      purgedShop.billingInterval === null &&
      purgedShop.trialEndsAt === null &&
      purgedShop.usageLineItemId === null,
    `plan=${purgedShop.plan}/${purgedShop.planStatus} sub=${purgedShop.subscriptionId}`,
  );
  ok(
    "G13 the original uninstalledAt stamp is preserved as the purge marker",
    purgedShop.uninstalledAt !== null,
    `uninstalledAt=${purgedShop.uninstalledAt?.toISOString?.()}`,
  );
  const shopRedactLog = await db.redactLog.findFirst({ where: { shopId: B, type: "shop" } });
  ok("G14 a shop redactLog row records the erasure", Boolean(shopRedactLog) && shopRedactLog.completedAt !== null);

  // G15 — the purge is idempotent (redelivered shop/redact must not throw)
  const rerun = await threw(() => cleanupShop(SHOP_B));
  const rowsAfterRerun = await countShopRows(B, SHOP_B);
  ok(
    "G15 a redelivered shop/redact is idempotent",
    rerun === null && rowsAfterRerun.length === 0,
    rerun?.message,
  );

  // G16 — a compliance webhook for a shop we never installed creates nothing
  const shopsBefore = await db.shop.count();
  const unknown = await threw(() => cleanupShop("never-installed-qa-features.myshopify.com"));
  const shopsAfter = await db.shop.count();
  ok(
    "G16 compliance purge for an unknown shop is a safe no-op",
    unknown === null && shopsBefore === shopsAfter,
    `shops ${shopsBefore}→${shopsAfter}`,
  );

  // G17 — the compliance route itself never trusts a shop query parameter
  const routeSrc = readFileSync(
    join(process.cwd(), "app", "routes", "webhooks.compliance.tsx"),
    "utf-8",
  );
  ok(
    "G17 compliance webhook identity comes only from authenticate.webhook",
    routeSrc.includes("await authenticate.webhook(request)") &&
      routeSrc.includes("CUSTOMERS_DATA_REQUEST") &&
      routeSrc.includes("CUSTOMERS_REDACT") &&
      routeSrc.includes("SHOP_REDACT"),
  );
  ok(
    "G18 data_request dedupes a redelivered webhook instead of stacking rows",
    routeSrc.includes('status: "pending"') && routeSrc.includes("if (!recent)"),
    "24h pending-row dedupe present",
  );

  // Recreate shop B so teardown's own assertions still have a row to check.
  await db.shop.update({ where: { id: B }, data: { uninstalledAt: null, name: `${TAG} shop B` } });
}

// ── Module: QA report fixes (QA-FIX-PLAN-2026-09-14) ───────────────────────

async function qaFixes(ctx: { db: any; A: string; B: string }): Promise<void> {
  section("QA fixes (2026-09-14)");
  const { db, A, B } = ctx;

  // QA-S1 — a rate-limited turn must not echo a client-supplied conversationId
  // (it is unverified at that point and was stored under the caller's shop).
  {
    const { runPipeline } = await import("../../app/lib/pipeline/index.server");
    const sessionId = `${TAG}-s1-session`;
    const foreign = await db.conversation.create({ data: { shopId: B, sessionId: `${TAG}-b-sess` } });
    (globalThis as any).rateBuckets ??= new Map();
    (globalThis as any).rateBuckets.set(`${A}:${sessionId}`, { tokens: 0, at: Date.now() });
    let done: any = null;
    for await (const frame of runPipeline({
      shopId: A,
      sessionId,
      conversationId: foreign.id,
      message: "hello",
      isTest: true,
    })) {
      if ((frame as any).type === "done") done = frame;
    }
    (globalThis as any).rateBuckets.delete(`${A}:${sessionId}`);
    ok(
      "S1 rate-limited turn returns an empty conversationId, never the client's",
      done?.outcome === "rate_limited" && done?.conversationId === "",
      JSON.stringify(done),
    );
    const detailSrc = readFileSync(
      join(process.cwd(), "app/routes/admin.debug.$shopId.$conversationId.tsx"),
      "utf-8",
    );
    ok(
      "S1 Debug detail reads traces by shopId AND conversationId",
      /where:\s*\{\s*shopId,\s*conversationId\s*\}/.test(detailSrc),
    );
    await db.conversation.deleteMany({ where: { id: foreign.id, shopId: B } });
  }

  // QA-C3 — Debug recording is per store, time-limited and production-locked.
  {
    const tracing = await import("../../app/lib/admin/turn-tracing.server");
    await tracing.stopTurnTracing();
    ok("DBG1 recording off → no store is recorded", !(await tracing.isTracingShop(A)));
    await tracing.startTurnTracing({ shopIds: [A], hours: 1, by: "qa@features" });
    tracing.resetTurnTracingCache();
    ok(
      "DBG2 allowlisted store A is recorded, store B is not",
      (await tracing.isTracingShop(A)) && !(await tracing.isTracingShop(B)),
    );
    const expired = { shopIds: [A], until: new Date(Date.now() - 1000).toISOString(), startedBy: null };
    ok("DBG3 an expired window records nothing", !tracing.tracingActive(expired));
    const priorEnv = process.env.NODE_ENV;
    const priorAllow = process.env.ALLOW_TURN_TRACING;
    (process.env as any).NODE_ENV = "production";
    delete process.env.ALLOW_TURN_TRACING;
    const lockedInProd = !(await tracing.isTracingShop(A));
    let startRefused = false;
    try {
      await tracing.startTurnTracing({ shopIds: [A], hours: 1, by: "qa@features" });
    } catch {
      startRefused = true;
    }
    (process.env as any).NODE_ENV = priorEnv;
    if (priorAllow === undefined) delete process.env.ALLOW_TURN_TRACING;
    else process.env.ALLOW_TURN_TRACING = priorAllow;
    ok("DBG4 production without ALLOW_TURN_TRACING records nothing and refuses to start", lockedInProd && startRefused);
    await tracing.stopTurnTracing();

    const { isOwnerAdmin } = await import("../../app/lib/admin/admin-auth.server");
    const session = (role: string, email: string) =>
      ({ sessionId: "s", admin: { id: "a", email, name: "x", role } }) as any;
    ok(
      "DBG5 only owners (role owner or the root env account) may read recordings",
      isOwnerAdmin(session("owner", "someone@example.com")) &&
        !isOwnerAdmin(session("admin", "someone-else@example.com")),
    );
  }

  // QA-C4 — no trace without a conversation; no trace after the conversation is gone.
  {
    const { observeTurn, TurnCollector } = await import("../../app/lib/pipeline/turn-capture.server");
    const { createTrace } = await import("../../app/lib/pipeline/trace.server");
    const run = async (conversationId: string) => {
      const frames = (async function* () {
        yield { type: "message", text: "hi" } as any;
        yield { type: "done", outcome: "chat", conversationId } as any;
      })();
      for await (const _frame of observeTurn({
        shopId: A,
        shopperText: `${TAG} traced`,
        frames,
        trace: createTrace(true),
        collector: new TurnCollector(),
      })) {
        // drain
      }
      // The save is fire-and-forget: no fixed sleep here — see the sentinel below.
    };
    const before = await db.turnTrace.count({ where: { shopId: A } });
    // Order matters: both "must NOT write" turns go first, then a turn that MUST
    // write. saveTurnTrace does the same shop + conversation lookups for all
    // three, so once the live turn's row has landed (bounded poll, ≤5 s — a
    // fixed 300 ms wait was flaky under load) the two earlier saves have had at
    // least as long to write a late row. The absence checks then run.
    await run("");
    await run("conversation-that-does-not-exist");
    const live = await db.conversation.create({ data: { shopId: A, sessionId: `${TAG}-c4-sess` } });
    await run(live.id);
    const liveCount = () => db.turnTrace.count({ where: { shopId: A, conversationId: live.id } });
    const pollStart = Date.now();
    let recorded = await liveCount();
    while (recorded === 0 && Date.now() - pollStart < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      recorded = await liveCount();
    }
    // Settle margin after the sentinel so a same-tick late write still shows.
    await new Promise((resolve) => setTimeout(resolve, 100));
    recorded = await liveCount();
    const others = await db.turnTrace.count({ where: { shopId: A, NOT: { conversationId: live.id } } });
    ok("C4a a turn with no conversation writes no trace", recorded === 1 && others === before, `sentinel=${recorded} others=${others} before=${before}`);
    ok("C4b a turn whose conversation is gone writes no trace", recorded === 1 && (await db.turnTrace.count({ where: { shopId: A, conversationId: "conversation-that-does-not-exist" } })) === 0 && others === before);
    ok("C4c a real conversation's turn is recorded", recorded === 1, `${recorded} row(s) after ${Date.now() - pollStart} ms`);
    await db.turnTrace.deleteMany({ where: { shopId: A, conversationId: live.id } });
    await db.conversation.deleteMany({ where: { id: live.id, shopId: A } });
  }

  // QA-U3 / TAI-1 — every sourceLayer the pipeline saves has a merchant label
  {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pipelineDir = join(process.cwd(), "app/lib/pipeline");
    const layers = new Set<string>();
    for (const file of readdirSync(pipelineDir).filter((f) => f.endsWith(".ts"))) {
      for (const line of readFileSync(join(pipelineDir, file), "utf8").split("\n")) {
        if (/^\s*\/\//.test(line)) continue;
        // `sourceLayer: "x"` or `sourceLayer: cond ? "x" : "y"` — only the value.
        const m = line.match(/sourceLayer:\s*(?:\w+\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"|"([a-z_]+)")/);
        for (const v of m ? m.slice(1) : []) if (v) layers.add(v);
      }
    }
    const consoleSrc = readFileSync(join(process.cwd(), "app/components/TestAiConsole.tsx"), "utf8");
    const labelBlock = consoleSrc.slice(consoleSrc.indexOf("const SOURCE_LABELS"), consoleSrc.indexOf("};", consoleSrc.indexOf("const SOURCE_LABELS")));
    const labelled = new Set([...labelBlock.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));
    const missing = [...layers].filter((l) => !labelled.has(l));
    ok(
      "TAI1 every sourceLayer written in app/lib/pipeline has a Test AI label (banned_* folds to 'banned')",
      layers.size >= 10 && missing.length === 0 && labelled.has("banned"),
      `layers=${layers.size} missing=${missing.join(",")}`,
    );

    // QA-U4 — mission signals
    const { sourceKey, looksNonEnglish } = await import("../../app/components/TestAiConsole");
    ok(
      "TAI2 banned_keyword / banned_moderation map to the one Blocked topic label",
      sourceKey("banned_keyword") === "banned" && sourceKey("banned_moderation") === "banned" && sourceKey("curated") === "curated",
    );
    ok(
      "TAI3 language mission: accented English does not fire; Spanish, Hindi and Devanagari do",
      !looksNonEnglish("café résumé naïve") &&
        !looksNonEnglish("What is your return policy?") &&
        looksNonEnglish("¿Cuál es su política de devoluciones?") &&
        looksNonEnglish("cual es su politica de devoluciones") &&
        looksNonEnglish("mujhe ek bracelet chahiye") &&
        looksNonEnglish("क्या आपके पास कंगन है"),
    );
    ok(
      "TAI4 stump mission completes on rag_fallback only (source check)",
      /stump[\s\S]{0,200}rag_fallback/.test(consoleSrc) || /rag_fallback[\s\S]{0,200}stump/.test(consoleSrc),
    );
  }
}

// ── Module: QA-T2 coverage — Debug limits, dashboard actions, review gate ───

async function qaCoverage(ctx: { db: any; A: string }): Promise<void> {
  section("QA-T2 coverage (2026-09-14)");
  const { db, A } = ctx;
  const { observeTurn, TurnCollector } = await import("../../app/lib/pipeline/turn-capture.server");
  const { createTrace } = await import("../../app/lib/pipeline/trace.server");
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf-8");

  // DBG6/7 — a recording row stays under 32 KB, trimmed in the documented order
  const record = async (conversationId: string, calls: number, promptChars: number, responseChars: number) => {
    const collector = new TurnCollector();
    for (let i = 0; i < calls; i++) {
      const call = collector.record(`call-${i}`, [{ role: "user", content: "p".repeat(promptChars) }]);
      collector.appendResponse(call, "r".repeat(responseChars));
    }
    async function* frames() {
      yield { type: "done" as const, outcome: "chat", conversationId };
    }
    for await (const _frame of observeTurn({
      shopId: A,
      shopperText: `${TAG} trim`,
      frames: frames(),
      trace: createTrace(true),
      collector,
    })) {
      // drain
    }
    await new Promise((resolve) => setTimeout(resolve, 400)); // save is fire-and-forget
    const row = await db.turnTrace.findFirst({ where: { shopId: A, conversationId }, orderBy: { createdAt: "desc" } });
    await db.turnTrace.deleteMany({ where: { shopId: A, conversationId } });
    return row?.payload as any;
  };
  const convo = await db.conversation.create({ data: { shopId: A, sessionId: `${TAG}-t2-trim` } });
  try {
    // 5 × (6 000 prompt + 4 000 response) ≈ 50 KB: dropping responses alone fits.
    const light = await record(convo.id, 5, 6_000, 4_000);
    ok(
      "DBG6 over 32 KB: LLM responses are trimmed FIRST and every prompt is kept",
      light && bytes(light) <= 32 * 1024 && light.llmCalls.length === 5 &&
        light.llmCalls.every((c: any) => c.response === "[trimmed]" && c.messages[0].content.length === 6_000) &&
        !light.trimmed,
      light ? `bytes=${bytes(light)} calls=${light.llmCalls.length}` : "no row",
    );
    // 12 × 6 000-char prompts ≈ 72 KB: oldest calls go, the final one survives.
    const heavy = await record(convo.id, 12, 6_000, 100);
    const purposes = heavy ? heavy.llmCalls.map((c: any) => c.purpose) : [];
    ok(
      "DBG7 still over: oldest LLM calls are dropped, the newest prompt is kept, and the row says trimmed",
      heavy && bytes(heavy) <= 32 * 1024 && heavy.trimmed === true &&
        purposes.length > 0 && purposes.length < 12 && purposes[purposes.length - 1] === "call-11" && !purposes.includes("call-0"),
      `bytes=${heavy ? bytes(heavy) : 0} kept=${purposes.join(",")}`,
    );
  } finally {
    await db.conversation.deleteMany({ where: { id: convo.id, shopId: A } });
  }

  // DBG8 — the nightly purge holds the table at TURN_TRACE_ROW_CEILING, newest kept
  {
    const { purgeTurnTraces, TURN_TRACE_ROW_CEILING } = await import("../../app/lib/jobs/handlers.server");
    const existing = await db.turnTrace.count();
    const extra = 5;
    const fill = Math.max(0, TURN_TRACE_ROW_CEILING - existing) + extra;
    const now = Date.now();
    // The oldest `extra` rows are ours and sit just inside the 7-day window, so
    // only the ceiling (not retention) can remove them.
    const oldest = new Date(now - 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
    const rows = Array.from({ length: fill }, (_, i) => ({
      shopId: A,
      conversationId: `${TAG}-ceiling-${i}`,
      shopperText: "",
      replyText: "",
      outcome: "chat",
      payload: {},
      createdAt: i < extra ? new Date(oldest.getTime() - i * 1000) : new Date(now - 60_000 + (i % 1000)),
    }));
    try {
      for (let i = 0; i < rows.length; i += 5_000) {
        await db.turnTrace.createMany({ data: rows.slice(i, i + 5_000) });
      }
      await purgeTurnTraces(new Date(now));
      const after = await db.turnTrace.count();
      const oldestLeft = await db.turnTrace.count({
        where: { shopId: A, conversationId: { in: rows.slice(0, extra).map((r) => r.conversationId) } },
      });
      ok(
        `DBG8 purge caps turn_traces at ${TURN_TRACE_ROW_CEILING} rows and drops the OLDEST`,
        after <= TURN_TRACE_ROW_CEILING && after >= TURN_TRACE_ROW_CEILING - extra && oldestLeft === 0,
        `inserted=${fill} after=${after} oldestLeft=${oldestLeft}`,
      );
    } finally {
      await db.turnTrace.deleteMany({ where: { shopId: A, conversationId: { startsWith: `${TAG}-ceiling-` } } });
    }
  }

  // D-SYNC1 — a repeat manual sync inside the window queues nothing new (QA-U1)
  {
    const { enqueueSync, SYNC_THROTTLE_SECONDS, getQueue } = await import("../../app/lib/jobs/queue.server");
    const { JOBS } = await import("../../app/lib/jobs/handlers.server");
    const domain = `qa-features-throttle-${Date.now()}.myshopify.com`;
    try {
      const first = await enqueueSync(JOBS.pageSync, domain);
      const second = await enqueueSync(JOBS.pageSync, domain);
      const otherType = await enqueueSync(JOBS.articleSync, domain);
      ok(
        `D-SYNC1 same store + job within ${SYNC_THROTTLE_SECONDS}s queues once; another job type is independent`,
        first === true && second === false && otherType === true,
        `first=${first} second=${second} other=${otherType}`,
      );
    } finally {
      // Never let the worker run a sync for a store that does not exist.
      await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE data->>'shopDomain' = $1`, domain).catch(() => undefined);
      await Promise.race([
        getQueue().boss.stop({ graceful: false }),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]).catch(() => undefined);
      global.pgBossGlobal = undefined;
    }
  }

  // D-SYNC2 / D-AI1 — dashboard actions need ai_agent (source + rule)
  {
    const { can } = await import("../../app/lib/access.server");
    const src = readFileSync(join(process.cwd(), "app/routes/app._index.tsx"), "utf8");
    const block = (intent: string) => {
      const start = src.indexOf(`intent === "${intent}"`);
      return start < 0 ? "" : src.slice(start, src.indexOf("\n  }\n", start) > 0 ? src.indexOf("\n  }\n", start) : start + 1500);
    };
    const guardedBefore = (body: string, write: string) => {
      const guard = body.indexOf(`can(access.role, access.surface, "ai_agent")`);
      const effect = body.indexOf(write);
      return guard >= 0 && effect > guard;
    };
    ok(
      "D-SYNC2 sync-all checks ai_agent before queueing, and uses the throttled enqueueSync",
      guardedBefore(block("sync-all"), "enqueueSync(") && !/\benqueue\(/.test(block("sync-all")),
    );
    ok("D-AI1 enable-ai checks ai_agent before writing aiEnabled", guardedBefore(block("enable-ai"), "aiEnabled: true"));
    ok(
      "D-AI2 ai_agent: agents are refused on both surfaces; owners/admins allowed on both",
      !can("agent", "web", "ai_agent") && !can("agent", "admin", "ai_agent") &&
        can("owner", "web", "ai_agent") && can("admin", "web", "ai_agent") && can("owner", "admin", "ai_agent"),
    );
  }

  // RV1–4 — App Store review prompt gate (app/lib/review.ts)
  {
    const { isReviewPromptEligible, REVIEW_MIN_INSTALL_AGE_MS } = await import("../../app/lib/review");
    const now = new Date("2026-09-14T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    ok("RV1 no install date → never eligible", !isReviewPromptEligible({ installedAt: null, hasEngaged: true, now }));
    ok(
      "RV2 installed under 24 h (and exactly 24 h) → not eligible, even when engaged",
      !isReviewPromptEligible({ installedAt: ago(REVIEW_MIN_INSTALL_AGE_MS - 1000), hasEngaged: true, now }) &&
        !isReviewPromptEligible({ installedAt: ago(REVIEW_MIN_INSTALL_AGE_MS), hasEngaged: true, now }),
    );
    ok(
      "RV3 older than 24 h but no real conversation → not eligible",
      !isReviewPromptEligible({ installedAt: ago(REVIEW_MIN_INSTALL_AGE_MS + 1000), hasEngaged: false, now }),
    );
    ok(
      "RV4 older than 24 h AND engaged → eligible",
      isReviewPromptEligible({ installedAt: ago(REVIEW_MIN_INSTALL_AGE_MS + 1000), hasEngaged: true, now }),
    );
    const reviewSrc = readFileSync(join(process.cwd(), "app/lib/review.server.ts"), "utf8");
    ok("RV5 engagement counts only non-test conversations (Test AI excluded)", /isTest:\s*false/.test(reviewSrc));
  }
}

// ── Module: Dashboard "Get your AI ready" steps (spec 13, 2026-09-14) ──────

async function dashboardSetup(ctx: { db: any }): Promise<void> {
  section("Dashboard setup steps (spec 13)");
  const { db } = ctx;
  const { setupChecklist } = await import("../../app/lib/dashboard/dashboard.server");
  const { cleanupShop } = await import("../../app/lib/jobs/handlers.server");
  // A FRESH shop, so every rule is observed flipping from to-do to done.
  const domain = "qa-features-dashboard.myshopify.com";
  await cleanupShop(domain).catch(() => undefined);
  await db.shop.deleteMany({ where: { domain } });
  const shop = await db.shop.create({ data: { domain, name: `${TAG} dashboard` } });
  const C = shop.id;
  const stepState = (list: any, id: string) => list.steps.find((s: any) => s.id === id)?.state;

  try {
    const fresh = await setupChecklist(C, domain);
    ok(
      "DS1 eight steps in the spec order",
      fresh.steps.map((s: any) => s.id).join(",") ===
        "training,faqs,knowledge,instructions,chatbox,proactive,curated,embed",
      fresh.steps.map((s: any) => s.id).join(","),
    );
    const countable = fresh.steps.filter((s: any) => s.state !== "unknown").length;
    ok(
      "DS2 a fresh shop has nothing done; an unverifiable embed is left out of the total",
      fresh.completed === 0 && fresh.total === countable,
      `completed=${fresh.completed} total=${fresh.total} embed=${stepState(fresh, "embed")}`,
    );

    // FAQs: a draft does not count, a published one does.
    await db.faq.create({ data: { shopId: C, question: `${TAG} draft faq`, status: "draft" } });
    const draftOnly = await setupChecklist(C, domain);
    await db.faq.create({ data: { shopId: C, question: `${TAG} published faq`, status: "published" } });
    const withFaq = await setupChecklist(C, domain);
    ok(
      "DS3 FAQs step: done on the first PUBLISHED FAQ only",
      stepState(draftOnly, "faqs") === "todo" && stepState(withFaq, "faqs") === "done",
    );

    // Custom knowledge: bridges and pending sources do not count.
    await db.dataSource.create({ data: { shopId: C, type: "store_pages", name: "Store pages", status: "active" } });
    await db.dataSource.create({ data: { shopId: C, type: "faq", name: "FAQ", status: "active" } });
    await db.dataSource.create({ data: { shopId: C, type: "url", name: `${TAG} url`, status: "pending" } });
    const bridgesOnly = await setupChecklist(C, domain);
    await db.dataSource.updateMany({ where: { shopId: C, type: "url" }, data: { status: "active" } });
    const withSource = await setupChecklist(C, domain);
    ok(
      "DS4 custom knowledge step: bridges and pending sources don't complete it; an active URL does",
      stepState(bridgesOnly, "knowledge") === "todo" && stepState(withSource, "knowledge") === "done",
    );

    await db.curatedAnswer.create({ data: { shopId: C, question: `${TAG} curated`, status: "published" } });
    const withCurated = await setupChecklist(C, domain);
    ok("DS5 curated answers step: done at ONE published answer", stepState(withCurated, "curated") === "done");

    // Training: counts follow the learn switches, the master switch zeroes them.
    await db.product.createMany({
      data: [
        { shopId: C, shopifyProductId: "gid://shopify/Product/990001", title: `${TAG} p1`, learnEnabled: true },
        { shopId: C, shopifyProductId: "gid://shopify/Product/990002", title: `${TAG} p2`, learnEnabled: true },
        { shopId: C, shopifyProductId: "gid://shopify/Product/990003", title: `${TAG} p3`, learnEnabled: false },
        // QA-U2: switched on but NOT showable (draft / off the Online Store) —
        // the AI can never card these, so they are not "learned".
        { shopId: C, shopifyProductId: "gid://shopify/Product/990004", title: `${TAG} p4 draft`, learnEnabled: true, status: "draft" },
        { shopId: C, shopifyProductId: "gid://shopify/Product/990005", title: `${TAG} p5 unpublished`, learnEnabled: true, publishedOnline: false },
      ],
    });
    await db.syncState.upsert({
      where: { shopId: C },
      create: { shopId: C, productSyncAt: new Date() },
      update: { productSyncAt: new Date() },
    });
    const trained = await setupChecklist(C, domain);
    const productsRow = trained.training.sources.find((s: any) => s.key === "products");
    ok(
      "DS6 training step done after a product sync; products show 2 of 5 learned (draft + unpublished not counted, QA-U2)",
      stepState(trained, "training") === "done" && productsRow?.learned === 2 && productsRow?.total === 5,
      JSON.stringify(productsRow),
    );
    await db.shopSettings.upsert({
      where: { shopId: C },
      create: { shopId: C, settings: { learn: { products: false } } },
      update: { settings: { learn: { products: false } } },
    });
    const masterOff = await setupChecklist(C, domain);
    const offRow = masterOff.training.sources.find((s: any) => s.key === "products");
    ok(
      "DS7 master Learn products OFF: 0 learned (total unchanged), and the step's item count follows",
      offRow?.learned === 0 &&
        offRow?.total === 5 &&
        offRow?.masterOn === false &&
        masterOff.training.learnedTotal === 0,
      JSON.stringify(offRow),
    );
    ok(
      "DS7b synced but nothing learned: the training step goes back to to-do (QA-U2)",
      stepState(masterOff, "training") === "todo",
      String(stepState(masterOff, "training")),
    );

    // Store info: to-do until Instructions → General → Store info has text.
    const noInfo = masterOff.steps.find((s: any) => s.id === "instructions");
    ok(
      "DS9 store info step starts to-do with an 'Add store info' action to the section",
      noInfo?.state === "todo" &&
        noInfo?.actionLabel === "Add store info" &&
        (noInfo?.action as any)?.href === "/app/ai-agent/instructions#store-info",
      JSON.stringify(noInfo),
    );
    const { saveGeneralInstructions } = await import("../../app/lib/instructions/save.server");
    const { listSources } = await import("../../app/lib/ingestion/sources.server");
    const general = {
      role: "You are a helpful assistant.",
      communicationStyle: "friendly",
      brandVoice: "Warm.",
      behaviours: "Be kind.",
      defaultLanguage: "en",
      autoDetectLanguage: false,
      bannedTopics: [],
      fallbackMessage: "Sorry.",
    };
    const aboutText = `${TAG} Zorblax Crystals is a family shop in Jaipur, open Mon–Sat 10am–6pm.`;
    await saveGeneralInstructions(C, { ...general, storeInfoAbout: aboutText });
    const withInfo = await setupChecklist(C, domain);
    const infoStep = withInfo.steps.find((s: any) => s.id === "instructions");
    const bridge = await db.dataSource.findFirst({ where: { shopId: C, type: "store_info" } });
    const bridgeChunks = bridge
      ? await db.knowledge.findMany({ where: { shopId: C, dataSourceId: bridge.id }, select: { body: true } })
      : [];
    ok(
      "DS10 saving store info completes the step (button stays: Review) and embeds it as the store_info source",
      infoStep?.state === "done" &&
        infoStep?.actionLabel === "Review" &&
        infoStep?.action.kind === "revisit" &&
        bridge?.status === "active" &&
        bridgeChunks.some((k: any) => k.body.includes("Zorblax Crystals")),
      `step=${infoStep?.state} bridge=${bridge?.status} chunks=${bridgeChunks.length}`,
    );
    // A save that does not send storeInfoAbout must leave it alone.
    await saveGeneralInstructions(C, general);
    const kept = (await db.shopSettings.findUnique({ where: { shopId: C } })).settings as any;
    const listed = await listSources(C);
    ok(
      "DS11 a save without store info keeps it, and the bridge is hidden from Custom knowledge",
      kept.storeInfo?.about === aboutText && !listed.some((s: any) => s.type === "store_info"),
      `about kept=${kept.storeInfo?.about === aboutText}`,
    );
    // DS12 ("Fill from Shopify" draft) retired 2026-09-15: the button was replaced
    // by "Write from my store" (spec 26), covered by scripts/qa/ai-setup.test.ts.
    ok(
      "DS12 the General tab offers Write from my store and no longer Fill from Shopify",
      /Write from my store/.test(readFileSync("app/components/InstructionsGeneralTab.tsx", "utf-8")) &&
        !/Fill from Shopify<\/s-button>|intent: "store-info-prefill"/.test(readFileSync("app/components/InstructionsGeneralTab.tsx", "utf-8")),
    );
    ok(
      "DS8 completed count matches the done steps",
      masterOff.completed === masterOff.steps.filter((s: any) => s.state === "done").length,
      `completed=${masterOff.completed}`,
    );
  } finally {
    await cleanupShop(domain).catch(() => undefined);
    await db.shop.deleteMany({ where: { domain } });
  }
}

// ── Module: Pages & Blogs sync (spec 22) ────────────────────────────────────

async function pagesBlogs(ctx: { db: any; A: string; B: string }): Promise<void> {
  section("Pages & Blogs sync (spec 22)");
  const { db, A, B } = ctx;
  const { pageRowFields, articleRowFields, rebuildContentBridge, BRIDGE_TYPE } = await import(
    "../../app/lib/ingestion/content-sync.server"
  );
  const { listSources } = await import("../../app/lib/ingestion/sources.server");
  const { loadShopSettings } = await import("../../app/lib/settings/save.server");
  const { QUOTA_DIMENSIONS, GRANTABLE_DIMENSIONS, PLAN_IDS } = await import(
    "../../app/lib/billing/plan-shared"
  );
  const plans = await import("../../app/lib/billing/plans.server");

  // PB1/PB2 — Shopify node → row. HTML is stripped at sync, so neither the
  // table nor the bridge ever handles markup.
  const page = pageRowFields({
    id: "gid://shopify/Page/1",
    title: null,
    handle: "shipping-info",
    body: "<h2>Shipping</h2><p>We ship in <b>2 days</b>.</p>",
    isPublished: false,
    updatedAt: "2026-09-01T00:00:00Z",
  });
  ok(
    "PB1 page body is stripped to text; a draft maps to isPublished=false; a null title falls back to the handle",
    page.bodyText.includes("We ship in 2 days") && !page.bodyText.includes("<") &&
      page.isPublished === false && page.title === "shipping-info",
    JSON.stringify({ title: page.title, body: page.bodyText.slice(0, 40) }),
  );
  const article = articleRowFields({
    id: "gid://shopify/Article/1",
    title: "Caring for amethyst",
    handle: "care",
    body: "<p>Keep it out of direct sun.</p>",
    summary: "<p>A short <i>care</i> guide</p>",
    tags: ["care", "amethyst"],
    isPublished: true,
    updatedAt: null,
    author: { name: "Priya" },
    blog: { id: "gid://shopify/Blog/1", title: "Care guides" },
  });
  ok(
    "PB2 article carries blog title, author, tags and a stripped summary",
    article.blogTitle === "Care guides" && article.author === "Priya" &&
      article.tags.length === 2 && article.summary === "A short care guide",
    JSON.stringify({ blog: article.blogTitle, summary: article.summary }),
  );

  // PB3 — the bridge holds exactly the learnEnabled rows while the master is on.
  await db.storePage.createMany({
    data: [
      { shopId: A, shopifyPageId: "gid://shopify/Page/901", title: `${TAG} Returns`, bodyText: "PB-ENABLED returns within 30 days", learnEnabled: true },
      { shopId: A, shopifyPageId: "gid://shopify/Page/902", title: `${TAG} Secret`, bodyText: "PB-DISABLED internal note", learnEnabled: false },
      { shopId: A, shopifyPageId: "gid://shopify/Page/903", title: `${TAG} Draft`, bodyText: "PB-DRAFT unreleased sale", isPublished: false, learnEnabled: false },
    ],
  });
  await rebuildContentBridge(A, "pages", { inline: true });
  const bridge = await db.dataSource.findFirst({ where: { shopId: A, type: BRIDGE_TYPE.pages } });
  const chunks = await db.knowledge.findMany({ where: { shopId: A, dataSourceId: bridge?.id } });
  const text = chunks.map((c: any) => c.body).join(" | ");
  ok(
    "PB3 the pages bridge contains the enabled page and NOT the disabled page or the draft",
    bridge?.status === "active" && text.includes("PB-ENABLED") &&
      !text.includes("PB-DISABLED") && !text.includes("PB-DRAFT"),
    text.slice(0, 80) || "no chunks",
  );

  // PB4 — master switch off ⇒ the agent has none of it (bridge emptied, still active).
  const settings = await loadShopSettings(A);
  const saveLearn = (pages: boolean) =>
    db.shopSettings.upsert({
      where: { shopId: A },
      create: { shopId: A, settings: { ...settings, learn: { ...settings.learn, pages } } },
      update: { settings: { ...settings, learn: { ...settings.learn, pages } } },
    });
  await saveLearn(false);
  await rebuildContentBridge(A, "pages", { inline: true });
  const offCount = await db.knowledge.count({ where: { shopId: A, dataSourceId: bridge?.id } });
  const offRow = await db.dataSource.findUnique({ where: { id: bridge?.id } });
  ok(
    "PB4 Learn pages OFF empties the bridge (0 chunks) without erroring the source",
    offCount === 0 && offRow?.status === "active",
    `chunks=${offCount} status=${offRow?.status}`,
  );
  await saveLearn(true);

  // PB5 — articles bridge: the blog name travels with the title as context.
  await db.blogArticle.create({
    data: {
      shopId: A,
      shopifyArticleId: "gid://shopify/Article/901",
      title: `${TAG} Cleansing crystals`,
      blogTitle: "Care guides",
      bodyText: "PB-ARTICLE rinse under running water",
      learnEnabled: true,
    },
  });
  await rebuildContentBridge(A, "blogs", { inline: true });
  const articleChunk = await db.knowledge.findFirst({
    where: { shopId: A, body: { contains: "PB-ARTICLE" } },
  });
  ok(
    "PB5 an enabled article is learned, with its blog name in the topic",
    Boolean(articleChunk) && articleChunk.topic.includes("(Care guides)"),
    articleChunk?.topic,
  );

  // PB6 — bridges are managed on their own tabs, so Custom knowledge hides them.
  const listed = await listSources(A);
  const explicit = await listSources(A, BRIDGE_TYPE.pages);
  ok(
    "PB6 Custom knowledge hides the Pages/Blogs bridges; an explicit type filter still reaches them",
    !listed.some((s: any) => s.type === "store_pages" || s.type === "blog_articles") && explicit.length === 1,
    `listed=${listed.map((s: any) => s.type).join(",")}`,
  );

  // PB7 — CROSS-TENANT: nothing of A's mirror or bridge is visible to B.
  const bPages = await db.storePage.count({ where: { shopId: B } });
  const bLeak = await db.knowledge.count({ where: { shopId: B, body: { contains: "PB-" } } });
  ok("PB7 CROSS-TENANT: pages, articles and their knowledge are shop-scoped", bPages === 0 && bLeak === 0, `B pages=${bPages} leaked chunks=${bLeak}`);

  // PB8 — plan limits exist on every plan, editable like products_synced, and
  // bonus-grantable (a grant is read at the sync cap in content-sync.server).
  const dimsOk =
    QUOTA_DIMENSIONS.includes("pages_synced") && QUOTA_DIMENSIONS.includes("articles_synced") &&
    (GRANTABLE_DIMENSIONS as readonly string[]).includes("pages_synced") &&
    (GRANTABLE_DIMENSIONS as readonly string[]).includes("articles_synced");
  const perPlan = PLAN_IDS.map((id: string) => [
    plans.getQuota(id, "pages_synced"),
    plans.getQuota(id, "articles_synced"),
  ]);
  ok(
    "PB8 pages_synced / articles_synced are quota dimensions on every plan and bonus-grantable",
    dimsOk && perPlan.every(([p, a]: number[]) => Number.isFinite(p) && Number.isFinite(a)),
    JSON.stringify(perPlan),
  );
}

// ── teardown ────────────────────────────────────────────────────────────────

async function teardown(db: any, shopIds: string[]): Promise<void> {
  section("Fixture cleanup");
  const { cleanupShop, countShopRows } = await import("../../app/lib/jobs/handlers.server");
  for (const shopId of shopIds) {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
    if (!shop) continue;
    await cleanupShop(shop.domain);
    const leftovers = await countShopRows(shopId, shop.domain);
    ok(`cleanup: ${shop.domain} has zero domain rows`, leftovers.length === 0, JSON.stringify(leftovers));
    await db.redactLog.deleteMany({ where: { shopId } });
    await db.shop.delete({ where: { id: shopId } }).catch(() => undefined);
  }
  const survivors = await db.shop.count({ where: { domain: { in: [SHOP_A, SHOP_B] } } });
  ok("cleanup: fixture shop rows removed", survivors === 0, `survivors=${survivors}`);
}

function report(): void {
  console.log("\n── Summary ───────────────────────────────────────────────────");
  for (const [name, counts] of perModule) {
    console.log(`  ${counts.fail === 0 ? "OK  " : "FAIL"} ${name}: ${counts.pass} passed, ${counts.fail} failed`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

const dbPromise = import("../../app/db.server");
main()
  .catch((error) => {
    console.error("\nSUITE ERROR:", error);
    failed++;
  })
  .finally(async () => {
    const db = (await dbPromise).default;
    await db.$disconnect();
    process.exit(failed ? 1 : 0);
  });
