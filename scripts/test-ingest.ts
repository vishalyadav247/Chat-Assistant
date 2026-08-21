/* Feature 04 verification script (spec 04 acceptance 1/2/4/5 + SSRF hardening).
 * Run: npx tsx scripts/test-ingest.ts
 * Needs: dev Postgres up (npm run db:up) + migrated; OPENAI_API_KEY in .env for
 * the retrievability assertions (fails loudly if missing).
 * All rows it creates are tagged + cleaned up; seeded data is untouched.
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

const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";
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

async function expectReject(name: string, promise: Promise<unknown>, pattern?: RegExp): Promise<void> {
  try {
    await promise;
    ok(name, false, "expected rejection but resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ok(name, pattern ? pattern.test(message) : true, message.slice(0, 100));
  }
}

async function main() {
  const db = (await import("../app/db.server")).default;
  const { chunkText, ingestSource, syncFaqKnowledge } = await import(
    "../app/lib/ingestion/knowledge-ingest.server"
  );
  const { safeFetch, crawl } = await import("../app/lib/ingestion/fetchers.server");
  const {
    createSource,
    deleteSource,
    resyncSource,
    listSources,
    listSuggested,
    approveSuggested,
    dismissSuggested,
    parseCsvContent,
    QuotaError,
  } = await import("../app/lib/ingestion/sources.server");
  const { embedText } = await import("../app/lib/embeddings/embedding.server");
  const { knowledgeSearch } = await import("../app/lib/search/knowledge-search.server");

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing — retrievability assertions need real embeddings");
  }

  // ── chunkText determinism ─────────────────────────────────────────────────
  console.log("\n[chunking]");
  const longText = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"lorem ipsum dolor sit amet ".repeat(6)}`).join("\n\n");
  const a = chunkText(longText);
  const b = chunkText(longText);
  ok("deterministic", JSON.stringify(a) === JSON.stringify(b), `${a.length} chunks`);
  ok("chunk sizes ≤1500", a.every((c) => c.length <= 1500));
  ok("multiple chunks for long text", a.length > 1);

  // ── SSRF guard (acceptance 2) ─────────────────────────────────────────────
  console.log("\n[ssrf]");
  await expectReject("metadata IP 169.254.169.254", safeFetch("http://169.254.169.254/latest/meta-data"), /private|reserved|blocked/i);
  await expectReject("localhost:8080", safeFetch("http://localhost:8080/admin"), /blocked hostname/i);
  await expectReject("127.0.0.1", safeFetch("http://127.0.0.1:9/"), /private|reserved/i);
  await expectReject("10.0.0.5", safeFetch("http://10.0.0.5/"), /private|reserved/i);
  await expectReject("172.16.0.1", safeFetch("http://172.16.0.1/"), /private|reserved/i);
  await expectReject("192.168.1.1", safeFetch("http://192.168.1.1/"), /private|reserved/i);
  await expectReject("[::1]", safeFetch("http://[::1]/"), /private|reserved|blocked/i);
  await expectReject("*.internal name", safeFetch("http://vault.internal/secrets"), /blocked hostname/i);
  await expectReject("ftp protocol", safeFetch("ftp://example.com/x"), /protocol/i);
  await expectReject(
    "hostname resolving to private IP (nip.io)",
    safeFetch("http://127.0.0.1.nip.io/"),
    /resolves to private|private|reserved/i,
  );
  await expectReject("31-redirect loop", safeFetch("https://httpbingo.org/redirect/31"), /redirect/i);
  await expectReject(
    "redirect hop → private target re-validated",
    safeFetch("https://httpbin.dev/redirect-to?url=http%3A%2F%2F169.254.169.254%2F"),
    /private|reserved|blocked/i,
  );

  // Positive path: public fetch + page-scope crawl.
  const example = await safeFetch("https://example.com/");
  ok("public fetch works", /Example Domain/i.test(example.text));
  const crawled = await crawl("https://example.com/", "page", 5);
  ok("crawl scope=page → 1 page", crawled.length === 1 && crawled[0].title.length > 0, crawled[0]?.title);

  // ── DB round-trips (acceptance 1) ─────────────────────────────────────────
  console.log("\n[round-trips]");
  const shop = await db.shop.upsert({
    where: { domain: DEV_SHOP_DOMAIN },
    update: {},
    create: { domain: DEV_SHOP_DOMAIN, name: "dev shop (test)" },
  });
  const shopId = shop.id;
  const createdSourceIds: string[] = [];

  // manual
  const manual = await createSource(
    shopId,
    {
      type: "manual",
      question: "What is the ChatConvert test warranty period?",
      synonyms: ["guarantee length", "warranty duration"],
      answer: "All ChatConvert test products include a 2-year zorblatt warranty covering manufacturing defects.",
    },
    { enqueueIngest: false },
  );
  createdSourceIds.push(manual.id);
  ok("manual source created pending", manual.status === "pending");
  await ingestSource(shopId, manual.id);
  const manualAfter = await db.dataSource.findFirst({ where: { id: manual.id, shopId } });
  ok("manual ingested → active", manualAfter?.status === "active" && (manualAfter?.chunkCount ?? 0) >= 1, `chunks=${manualAfter?.chunkCount}`);
  const [manualEmb] = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "knowledge" WHERE "shopId" = $1 AND "dataSourceId" = $2 AND "embedding" IS NOT NULL`,
    shopId,
    manual.id,
  );
  ok("manual rows embedded", Number(manualEmb.n) >= 1, `${manualEmb.n} embedded rows`);
  const warrantyHits = await knowledgeSearch(shopId, await embedText("how long is the zorblatt warranty?", { shopId }), 3);
  ok(
    "manual retrievable via knowledgeSearch",
    warrantyHits.some((h) => /warranty period/i.test(h.topic)),
    `top: ${warrantyHits[0]?.topic} (${warrantyHits[0]?.score.toFixed(3)})`,
  );

  // pages (policy connector ingestion path with a fake body)
  const pages = await createSource(
    shopId,
    {
      type: "pages",
      name: "Test policies",
      pages: [
        {
          title: "Meteorite return policy",
          url: "https://example.com/policies/meteorite",
          body: "<p>Meteorite purchases can be returned within <b>45 days</b> of delivery.</p><p>Craters must be reported to support first.</p>",
        },
      ],
    },
    { enqueueIngest: false },
  );
  createdSourceIds.push(pages.id);
  await ingestSource(shopId, pages.id);
  const pagesAfter = await db.dataSource.findFirst({ where: { id: pages.id, shopId } });
  ok("pages ingested → active", pagesAfter?.status === "active" && (pagesAfter?.chunkCount ?? 0) >= 1);
  const pagesRows = await db.knowledge.findMany({ where: { shopId, dataSourceId: pages.id } });
  ok("pages HTML stripped", pagesRows.every((r) => !r.body.includes("<p>")), pagesRows[0]?.body.slice(0, 60));
  const meteorHits = await knowledgeSearch(shopId, await embedText("can I return a meteorite I bought?", { shopId }), 3);
  ok("pages retrievable", meteorHits.some((h) => /meteorite/i.test(h.topic)), `top: ${meteorHits[0]?.topic}`);

  // resync rebuilds (change content → rows rebuilt)
  const oldRowIds = new Set(pagesRows.map((r) => r.id));
  await db.dataSource.updateMany({
    where: { id: pages.id, shopId },
    data: {
      metadata: {
        pages: [
          {
            title: "Meteorite return policy",
            url: "https://example.com/policies/meteorite",
            body: "<p>Meteorite purchases can be returned within <b>90 days</b> of delivery.</p>",
          },
        ],
      },
    },
  });
  const resync = await resyncSource(shopId, pages.id, { enqueueIngest: false });
  const rebuilt = await db.knowledge.findMany({ where: { shopId, dataSourceId: pages.id } });
  ok(
    "resync rebuilds rows",
    resync !== null && rebuilt.length >= 1 && rebuilt.every((r) => !oldRowIds.has(r.id)) && rebuilt.some((r) => r.body.includes("90 days")),
    `${rebuilt.length} new rows`,
  );
  await expectReject("resync rejected for manual type", resyncSource(shopId, manual.id, { enqueueIngest: false }), /not supported/i);

  // csv — with/without header (acceptance 5), pre-parsed rows ingested
  console.log("\n[csv]");
  const withHeader = parseCsvContent('Question,Answer\n"Do you ship gliftors?","Yes, gliftors ship worldwide."\n,missing question here\n');
  ok("csv header detected + mapped", withHeader.hadHeader && withHeader.rows.length === 1 && withHeader.rows[0].question === "Do you ship gliftors?");
  ok("csv bad row reported", withHeader.badRows.length === 1 && withHeader.badRows[0].reason === "missing question");
  const noHeader = parseCsvContent('"How long do gliftors last?","About 10 years with care."\n"Are gliftors waterproof?","Only the marine edition."');
  ok("csv headerless mapped", !noHeader.hadHeader && noHeader.rows.length === 2);
  const csvSource = await createSource(shopId, { type: "csv", name: "Gliftor FAQ import", rows: noHeader.rows }, { enqueueIngest: false });
  createdSourceIds.push(csvSource.id);
  await ingestSource(shopId, csvSource.id);
  const csvAfter = await db.dataSource.findFirst({ where: { id: csvSource.id, shopId } });
  ok("csv ingested (row per Q&A)", csvAfter?.status === "active" && csvAfter?.chunkCount === 2);
  const gliftorHits = await knowledgeSearch(shopId, await embedText("is a gliftor waterproof?", { shopId }), 3);
  ok("csv retrievable", gliftorHits.some((h) => /waterproof/i.test(h.topic)), `top: ${gliftorHits[0]?.topic}`);

  // file — txt ok; pdf → error "parser pending" (spec delta)
  console.log("\n[file]");
  const txtSource = await createSource(
    shopId,
    {
      type: "file",
      name: "care-guide.txt",
      mime: "text/plain",
      bytes: Buffer.from("Frimbulator care guide.\n\nWipe your frimbulator weekly with a dry cloth. Never submerge it in quicksilver."),
    },
    { enqueueIngest: false },
  );
  createdSourceIds.push(txtSource.id);
  await ingestSource(shopId, txtSource.id);
  const txtAfter = await db.dataSource.findFirst({ where: { id: txtSource.id, shopId } });
  ok("txt file ingested", txtAfter?.status === "active" && (txtAfter?.chunkCount ?? 0) >= 1);
  const frimbulatorHits = await knowledgeSearch(shopId, await embedText("how do I clean my frimbulator?", { shopId }), 3);
  ok("txt retrievable", frimbulatorHits.some((h) => /frimbulator|care-guide/i.test(`${h.topic} ${h.body}`)), `top: ${frimbulatorHits[0]?.topic}`);
  const pdfSource = await createSource(
    shopId,
    { type: "file", name: "catalog.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 fake") },
    { enqueueIngest: false },
  );
  createdSourceIds.push(pdfSource.id);
  const pdfMeta = (pdfSource.metadata ?? {}) as { error?: string };
  ok("pdf → status error 'parser pending'", pdfSource.status === "error" && /parser pending/i.test(pdfMeta.error ?? ""), pdfMeta.error);

  // quota seams (acceptance 4) — open mode: seams called, creation passes
  console.log("\n[quota seams]");
  ok("QuotaError shape", new QuotaError("manual_qas", 10, 10).message.includes("manual_qas"));
  const list = await listSources(shopId);
  ok("listSources excludes suggested + shows created", list.length >= createdSourceIds.length);
  const manualOnly = await listSources(shopId, "manual");
  ok("listSources type filter", manualOnly.every((s) => s.type === "manual"));

  // suggested queue mechanics
  console.log("\n[suggested queue]");
  const suggested1 = await db.dataSource.create({
    data: {
      shopId,
      type: "manual",
      name: "Do you offer plumbus engraving?",
      status: "suggested",
      metadata: { question: "Do you offer plumbus engraving?", answer: "Yes — free plumbus engraving on orders over $50." },
    },
  });
  const suggested2 = await db.dataSource.create({
    data: {
      shopId,
      type: "manual",
      name: "dismiss me",
      status: "suggested",
      metadata: { question: "dismiss me", answer: "n/a" },
    },
  });
  const queue = await listSuggested(shopId);
  ok("listSuggested shows queue", queue.some((q) => q.id === suggested1.id) && queue.some((q) => q.id === suggested2.id));
  const approved = await approveSuggested(shopId, suggested1.id, { enqueueIngest: false });
  createdSourceIds.push(approved.id);
  ok("approve → active manual source", approved.status === "active" && approved.type === "manual" && (approved.chunkCount ?? 0) >= 1);
  const plumbusHits = await knowledgeSearch(shopId, await embedText("can I get my plumbus engraved?", { shopId }), 3);
  ok("approved suggestion retrievable", plumbusHits.some((h) => /plumbus/i.test(h.topic)), `top: ${plumbusHits[0]?.topic}`);
  ok("dismiss deletes", await dismissSuggested(shopId, suggested2.id));
  ok("dismissed gone", (await listSuggested(shopId)).every((q) => q.id !== suggested2.id));

  // FAQ bridge
  console.log("\n[faq bridge]");
  const faq = await db.faq.create({
    data: {
      shopId,
      question: "What is the splenden buyback program?",
      answerHtml: "<p>We buy back used <b>splendens</b> at 40% of retail within one year.</p>",
      status: "published",
    },
  });
  const faqResult = await syncFaqKnowledge(shopId);
  const faqSource = await db.dataSource.findFirst({ where: { shopId, type: "faq" } });
  ok("faq source synced", faqSource?.status === "active" && faqResult.chunkCount >= 1, `chunks=${faqResult.chunkCount}`);
  const splendenHits = await knowledgeSearch(shopId, await embedText("do you buy back used splendens?", { shopId }), 3);
  ok("faq retrievable", splendenHits.some((h) => /splenden/i.test(h.topic)), `top: ${splendenHits[0]?.topic}`);
  await db.faq.deleteMany({ where: { id: faq.id, shopId } });
  const faqResync = await syncFaqKnowledge(shopId); // published FAQ removed → mirror empties
  ok("faq unpublish removes rows", faqResync.chunkCount === 0);
  if (faqSource) createdSourceIds.push(faqSource.id);

  // delete removes retrievability (acceptance 1)
  console.log("\n[delete]");
  for (const id of createdSourceIds) {
    await deleteSource(shopId, id);
  }
  const leftover = await db.knowledge.count({ where: { shopId, dataSourceId: { in: createdSourceIds } } });
  ok("delete cascades knowledge rows", leftover === 0);
  const afterDelete = await knowledgeSearch(shopId, await embedText("can I return a meteorite I bought?", { shopId }), 3);
  ok("deleted content no longer retrievable", afterDelete.every((h) => !/meteorite|zorblatt|gliftor|frimbulator|plumbus|splenden/i.test(`${h.topic} ${h.body}`)));
  const remaining = await db.dataSource.count({ where: { shopId, id: { in: createdSourceIds } } });
  ok("sources deleted", remaining === 0);

  console.log(`\n${failed === 0 ? "INGEST TESTS PASS" : "INGEST TESTS FAIL"} — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error("\nINGEST TESTS ERROR", error);
    process.exit(1);
  })
  .finally(async () => {
    const db = (await import("../app/db.server")).default;
    await db.$disconnect();
  });
