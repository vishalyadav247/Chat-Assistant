import { Prisma } from "@prisma/client";
import type { DataSource } from "@prisma/client";
import { z } from "zod";
import db from "../../db.server";
import { getQuota } from "../billing/plans.server";
import { requireShopId } from "../tenancy.server";
import { htmlToText } from "./fetchers.server";
import { extractPdfText } from "./pdf.server";
import { ingestSource, type IngestResult } from "./knowledge-ingest.server";
import { KNOWLEDGE_INGEST_JOB } from "./knowledge-jobs.server";
import { logError } from "../log.server";

// Data-source CRUD + quota API (spec 04) — the surface feature 07's admin UI
// calls. Every function takes a TRUSTED shopId (from authenticate.admin) as
// its first argument and scopes every query by it.
//
// NOTE: pg-boss (enqueue) and shopify.server (Admin API) are lazy-imported so
// this module stays usable from offline scripts/tests.

export const CSV_ROW_CAP = 50;
export const FILE_BYTE_CAP = 2 * 1024 * 1024; // 2MB
/**
 * Hard ceiling on the plan's csv_upload_mb, whatever /admin/plans says. The
 * file travels base64 inside the form post (~1.4x), and nginx caps request
 * bodies at 25M (DEPLOYMENT.md); every chunk is also embedded and inserted in
 * one ingest transaction.
 */
export const CSV_MB_CEILING = 10;

/** Bytes a CSV upload may be on this plan (0 = CSV not included). */
export function csvByteCap(plan: string): number {
  const mb = Math.min(Math.max(getQuota(plan, "csv_upload_mb"), 0), CSV_MB_CEILING);
  return mb * 1024 * 1024;
}

export class QuotaError extends Error {
  constructor(
    readonly dimension: string,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`quota_exceeded:${dimension} (${used} of ${limit} used)`);
    this.name = "QuotaError";
  }
}

// ── Input schemas ───────────────────────────────────────────────────────────

const statusSchema = z.enum(["active", "inactive"]).default("active");

export const urlSourceSchema = z.object({
  type: z.literal("url"),
  url: z.string().trim().min(1).max(2000).regex(/^https?:\/\//i, "must be an http(s) URL"),
  reCrawlWeekly: z.boolean().default(false),
  status: statusSchema,
  name: z.string().trim().min(1).max(200).optional(),
});

// Manual Q&A and knowledge-CSV source types were retired (FAQ
// consolidation): both did what an FAQ does, and FAQs already
// have manual creation, their own CSV import/export, the widget screen and the
// knowledge bridge. Creation/edit paths are gone; LEGACY rows of those types
// keep working (listed, deletable, still ingested) — no shop had any in
// production. `parseCsvContent`/`splitCsv` below stay: the FAQ importer uses them.

export const fileSourceSchema = z.object({
  type: z.literal("file"),
  /** The uploaded FILENAME — its extension decides how the file is parsed. */
  name: z.string().trim().min(1).max(200),
  /** Merchant-written title shown in Manage sources. Optional so
   *  older callers still work; falls back to the filename. */
  title: z.string().trim().min(1).max(200).optional(),
  mime: z.string().trim().max(200),
  bytes: z.instanceof(Buffer),
});

export const pagesSourceSchema = z.object({
  type: z.literal("pages"),
  name: z.string().trim().min(1).max(200).optional(),
  pages: z
    .array(
      z.object({
        // Selection id (ShopPolicyType or Page GID) — lets a re-sync match this
        // snapshot back to its Shopify item. Optional for older callers.
        type: z.string().trim().max(200).optional(),
        title: z.string().trim().min(1).max(300),
        url: z.string().trim().max(2000).default(""),
        body: z.string().min(1),
      }),
    )
    .min(1)
    .max(50),
  // What the merchant selected, so re-sync can re-fetch it. Stored in the SAME
  // write as the pages: it used to be patched in afterwards, after the ingest
  // job was already queued, and a worker that read the row first would then
  // persist its own copy of the metadata over it — leaving a source that could
  // never refresh.
  policyTypes: z.array(z.string().trim().max(200)).max(50).optional(),
});

/**
 * ONE connected Shopify legal policy per source, so
 * each shows — and can be deleted — separately in Manage sources. Replaces the
 * combined `pages` source, which held every selected policy AND page in one
 * row; store pages now come from the Pages tab. The body is a snapshot for
 * fail-soft ingest; ingest re-reads the live policy from Shopify.
 */
export const policySourceSchema = z.object({
  type: z.literal("policy"),
  /** ShopPolicyType, e.g. REFUND_POLICY. */
  policyType: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  url: z.string().trim().max(2000).default(""),
  body: z.string().min(1),
});

export const createSourceSchema = z.discriminatedUnion("type", [
  urlSourceSchema,
  fileSourceSchema,
  pagesSourceSchema,
  policySourceSchema,
]);

export type CreateSourceInput = z.input<typeof createSourceSchema>;

export interface SourceMutationOptions {
  /**
   * Enqueue the knowledge-ingest job (default). Pass false to skip — callers
   * (tests, jobs) then run ingestSource themselves.
   */
  enqueueIngest?: boolean;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listSources(shopId: string, typeFilter?: string): Promise<DataSource[]> {
  requireShopId(shopId);
  return db.dataSource.findMany({
    where: {
      shopId,
      status: { not: "suggested" },
      // Pages/Blogs bridges (spec 22) are managed on their own Training tabs, and
      // the store_info bridge in Instructions → General;
      // listing them here would offer Edit/Delete on something the merchant
      // controls elsewhere. An explicit typeFilter still reaches them.
      ...(typeFilter ? { type: typeFilter } : { type: { notIn: ["store_pages", "blog_articles", "store_info"] } }),
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Validate → quota-check (plan seams, spec 15) → create the data_source
 * (status pending) → enqueue knowledge-ingest. File parse failures create the
 * row with status "error" and never enqueue.
 */
export async function createSource(
  shopId: string,
  input: CreateSourceInput,
  options: SourceMutationOptions = {},
): Promise<DataSource> {
  requireShopId(shopId);
  const parsed = createSourceSchema.parse(input);
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { plan: true, domain: true },
  });
  if (!shop) throw new Error("sources: shop not found");
  const plan = shop.plan;

  let data: Prisma.DataSourceUncheckedCreateInput;
  switch (parsed.type) {
    case "url": {
      // crawl_pages = how many URL sources a shop may have (spec 22). It was a
      // per-crawl page cap, which means nothing once a crawl is one page; the
      // Knowledge tab meter already summed pages across sources, so this makes
      // creation enforce the number the merchant sees. Existing sources over a
      // lowered limit are kept — only new adds are refused.
      const limit = getQuota(plan, "crawl_pages");
      const used = await db.dataSource.count({ where: { shopId, type: "url" } });
      if (used >= limit) throw new QuotaError("crawl_pages", used, limit);
      data = {
        shopId,
        type: "url",
        name: parsed.name ?? parsed.url,
        url: parsed.url,
        reCrawlWeekly: parsed.reCrawlWeekly,
        status: "pending",
        metadata: { desiredStatus: parsed.status },
      };
      break;
    }
    case "file": {
      // No "file_upload" feature gate —
      // the file_uploads QUOTA below is the only cap, on every plan.
      const limit = getQuota(plan, "file_uploads");
      // A lookup table (spec 28) is an uploaded file too.
      const used = await db.dataSource.count({ where: { shopId, type: { in: ["file", "table"] } } });
      if (used >= limit) throw new QuotaError("file_uploads", used, limit);
      if (fileKind(parsed.name, parsed.mime) === "csv") {
        // CSV size is the plan's csv_upload_mb (2026-09-16), not the flat cap.
        const cap = csvByteCap(plan);
        if (cap === 0) throw new UnsupportedFileError("CSV upload isn't included in your plan");
        if (parsed.bytes.byteLength > cap) {
          throw new FileTooLargeError(`CSV too large — your plan allows up to ${cap / (1024 * 1024)}MB`);
        }
      } else if (parsed.bytes.byteLength > FILE_BYTE_CAP) {
        throw new FileTooLargeError("file too large (max 2MB)");
      }
      const { text, parseError } = await extractFileText(parsed.name, parsed.mime, parsed.bytes);
      // A file type we can never parse must not become a stored "error" row:
      // it consumed the file_uploads quota, and re-adding it just piled up
      // duplicates (QA D12e). Reject it outright instead.
      if (parseError && !PARSEABLE_KINDS.has(fileKind(parsed.name, parsed.mime))) {
        throw new UnsupportedFileError(parseError);
      }
      data = {
        shopId,
        type: "file",
        name: parsed.title ?? parsed.name,
        status: parseError ? "error" : "pending",
        metadata: parseError
          ? { filename: parsed.name, mime: parsed.mime, error: parseError }
          : { filename: parsed.name, mime: parsed.mime, text },
      };
      break;
    }
    case "policy": {
      // No limit: Shopify has at most 8 policy
      // types, so every plan may connect all of a store's policies. The
      // duplicate check below is what bounds it.
      const duplicate = await db.dataSource.findFirst({
        where: { shopId, type: "policy", metadata: { path: ["policyType"], equals: parsed.policyType } },
        select: { id: true },
      });
      if (duplicate) throw new Error(`${parsed.title} is already connected`);
      data = {
        shopId,
        type: "policy",
        name: parsed.title,
        url: parsed.url || null,
        // Policies have no webhook, so they ride the weekly knowledge re-crawl.
        reCrawlWeekly: true,
        status: "pending",
        metadata: { policyType: parsed.policyType, title: parsed.title, body: parsed.body },
      };
      break;
    }
    case "pages": {
      // LEGACY type — the UI no longer creates these (one `policy` source per
      // policy); kept for scripts/tests. No limit, as above.
      data = {
        shopId,
        type: "pages",
        name: parsed.name ?? "Store policies & pages",
        status: "pending",
        metadata: parsed.policyTypes
          ? { pages: parsed.pages, policyTypes: parsed.policyTypes }
          : { pages: parsed.pages },
      };
      break;
    }
  }

  const source = await db.dataSource.create({ data });
  if (source.status !== "error" && (options.enqueueIngest ?? true)) {
    await enqueueIngestJob(shop.domain, source.id);
  }
  return source;
}

/** Delete a source AND cascade-delete its knowledge rows. */
export async function deleteSource(shopId: string, sourceId: string): Promise<boolean> {
  requireShopId(shopId);
  const source = await db.dataSource.findFirst({
    where: { id: sourceId, shopId },
    select: { id: true },
  });
  if (!source) return false;
  await db.$transaction([
    db.knowledge.deleteMany({ where: { shopId, dataSourceId: sourceId } }),
    // Spec 28 lookup tables keep rows + the uploaded file instead of chunks.
    db.lookupRow.deleteMany({ where: { shopId, dataSourceId: sourceId } }),
    db.lookupFile.deleteMany({ where: { shopId, dataSourceId: sourceId } }),
    db.dataSource.deleteMany({ where: { id: sourceId, shopId } }),
  ]);
  return true;
}

/**
 * Re-sync (url/pages only, per design): rows are deleted and rebuilt by the
 * ingest run. Returns the ingest result when run inline (enqueueIngest: false).
 */
export async function resyncSource(
  shopId: string,
  sourceId: string,
  options: SourceMutationOptions = {},
): Promise<IngestResult | null> {
  requireShopId(shopId);
  const source = await db.dataSource.findFirst({ where: { id: sourceId, shopId } });
  if (!source) throw new Error("sources: source not found");
  if (source.type !== "url" && source.type !== "pages" && source.type !== "policy") {
    throw new Error(`re-sync is not supported for type "${source.type}"`);
  }
  if (options.enqueueIngest ?? true) {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
    if (!shop) throw new Error("sources: shop not found");
    await db.dataSource.updateMany({
      where: { id: sourceId, shopId },
      data: { status: "pending" },
    });
    await enqueueIngestJob(shop.domain, sourceId);
    return null;
  }
  return ingestSource(shopId, sourceId);
}

async function enqueueIngestJob(shopDomain: string, sourceId: string): Promise<void> {
  const { enqueue } = await import("../jobs/queue.server");
  await enqueue(KNOWLEDGE_INGEST_JOB, { shopDomain, sourceId });
}

// ── Shopify policy connector ────────────────────────────────────────────────

const SHOP_POLICIES_QUERY = `#graphql
  query KnowledgeShopPolicies {
    shop {
      shopPolicies {
        type
        body
        url
      }
    }
  }
`;

export interface PolicyCandidate {
  /** Stable selection id: ShopPolicyType (e.g. REFUND_POLICY) or a Page GID. */
  type: string;
  /** Human-readable title, e.g. "Refund policy". */
  title: string;
  url: string;
  /** Plain-text body, ready for a `pages` source. */
  body: string;
  /** Where the candidate came from — legal policy vs Online Store page. */
  kind: "policy" | "page";
}

/**
 * List the shop's legal policies via the Admin API — candidates for the
 * policy/pages connector UI (07). Ingestion happens via createSource(pages).
 */
export async function fetchShopPolicies(
  shopDomain: string,
  options: FetchCandidatesOptions = {},
): Promise<PolicyCandidate[]> {
  const { unauthenticated } = await import("../../shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  let response: Awaited<ReturnType<typeof admin.graphql>>;
  try {
    response = await admin.graphql(SHOP_POLICIES_QUERY);
  } catch (error) {
    // Stores that installed before read_legal_policies was added haven't
    // re-consented yet — degrade to an empty candidate list, never a crash.
    logError("shop_policies_access", error, { shopDomain });
    if (options.strict) throw error;
    return [];
  }
  const body = (await response.json()) as {
    data?: {
      shop?: {
        shopPolicies?: Array<{ type: string; body: string | null; url: string | null }>;
      };
    };
  };
  // Strict: a MISSING list is a failed read, not "the shop has no policies" —
  // only an explicit [] may be taken to mean the policies are gone.
  if (options.strict && !Array.isArray(body.data?.shop?.shopPolicies)) {
    throw new Error("shopPolicies missing from the Admin API response");
  }
  const policies = body.data?.shop?.shopPolicies ?? [];
  return policies
    .filter((policy) => (policy.body ?? "").trim().length > 0)
    .map((policy) => ({
      type: policy.type,
      title: humanizePolicyType(policy.type),
      url: policy.url ?? "",
      body: htmlToText(policy.body ?? "").text,
      kind: "policy" as const,
    }));
}

const SHOP_PAGES_QUERY = `#graphql
  query KnowledgeShopPages($cursor: String) {
    pages(first: 100, after: $cursor, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        body
        isPublished
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Cap on how many Online Store pages are listed as connector candidates. */
export const PAGE_CANDIDATE_CAP = 200;

/**
 * List ALL Online Store pages (published and draft) as connector candidates —
 * the merchant picks which to sync. Selection quota is enforced at save time,
 * not here. Needs read_content (Page accepts read_content OR read_online_store_pages —
 * verified on shopify.dev 2026-09-14; the app requests only read_content, QA-P2).
 */
export async function fetchShopPages(
  shopDomain: string,
  options: FetchCandidatesOptions = {},
): Promise<PolicyCandidate[]> {
  const { unauthenticated } = await import("../../shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  const candidates: PolicyCandidate[] = [];
  let cursor: string | null = null;
  try {
    do {
      const response = await admin.graphql(SHOP_PAGES_QUERY, { variables: { cursor } });
      const body = (await response.json()) as {
        data?: {
          pages?: {
            nodes?: Array<{
              id: string;
              title: string | null;
              handle: string | null;
              body: string | null;
              isPublished: boolean;
            }>;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      if (options.strict && !body.data?.pages) {
        throw new Error("pages missing from the Admin API response");
      }
      const connection = body.data?.pages;
      for (const page of connection?.nodes ?? []) {
        if (!(page.body ?? "").trim()) continue; // nothing to ingest
        candidates.push({
          type: page.id,
          title: (page.title ?? page.handle ?? "Untitled page") + (page.isPublished ? "" : " (draft)"),
          url: page.handle ? `https://${shopDomain}/pages/${page.handle}` : "",
          body: htmlToText(page.body ?? "").text,
          kind: "page",
        });
      }
      cursor = connection?.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
    } while (cursor && candidates.length < PAGE_CANDIDATE_CAP);
  } catch (error) {
    // Missing scope on stores that haven't re-consented — degrade to what we
    // have so far (policies still list), never crash the connector.
    logError("shop_pages_access", error, { shopDomain });
    if (options.strict) throw error;
  }
  return candidates.slice(0, PAGE_CANDIDATE_CAP);
}

/**
 * `strict` is for RE-SYNC, where the result replaces knowledge the merchant
 * already has. The connector UI keeps the lenient default (a store missing a
 * scope still lists what it can), but a re-sync that swallowed a failure would
 * read "Shopify returned nothing" as "every connected page was deleted" and
 * wipe the source on a transient error.
 */
export interface FetchCandidatesOptions {
  strict?: boolean;
}

/** One connected page as stored in a `pages` source's metadata. */
export interface ConnectedPage {
  /** Selection id (ShopPolicyType or Page GID). Absent on rows saved before 2026-09-11. */
  type?: string;
  title: string;
  url: string;
  body: string;
}

/**
 * Rebuild a Connect source's page list from freshly fetched candidates.
 *
 * Pure, so the re-sync rules are unit-testable without the Admin API:
 *  - a selected item Shopify still returns → its CURRENT title and body;
 *  - a selected item Shopify no longer returns → dropped (deleted, or its body
 *    was emptied — the fetchers skip empty bodies), so the agent stops quoting
 *    a policy that no longer exists;
 *  - EXCEPT a page when the page listing hit PAGE_CANDIDATE_CAP: absence then
 *    proves nothing (it may simply sit past the cap), so its stored snapshot is
 *    kept rather than silently deleting content the merchant chose.
 * Output keeps the merchant's selection order.
 */
export function mergeRefreshedPages(
  selected: string[],
  fresh: PolicyCandidate[],
  snapshot: ConnectedPage[],
): ConnectedPage[] {
  const byId = new Map(fresh.map((c) => [c.type, c]));
  const pageListCapped = fresh.filter((c) => c.kind === "page").length >= PAGE_CANDIDATE_CAP;
  const out: ConnectedPage[] = [];
  for (const id of selected) {
    const current = byId.get(id);
    if (current) {
      out.push({ type: id, title: current.title, url: current.url, body: current.body });
      continue;
    }
    const isPage = id.startsWith("gid://shopify/Page/");
    const kept = isPage && pageListCapped ? snapshot.find((p) => p.type === id) : undefined;
    if (kept) out.push(kept);
  }
  return out;
}

/** Policies + all Online Store pages — the full connector candidate list. */
export async function fetchPageCandidates(
  shopDomain: string,
  options: FetchCandidatesOptions = {},
): Promise<PolicyCandidate[]> {
  const [policies, pages] = await Promise.all([
    fetchShopPolicies(shopDomain, options),
    fetchShopPages(shopDomain, options),
  ]);
  return [...policies, ...pages];
}

/** ShopPolicyType enum — Admin GraphQL 2026-07, verified on shopify.dev. */
const SHOP_POLICY_TYPES = new Set([
  "CONTACT_INFORMATION",
  "LEGAL_NOTICE",
  "PRIVACY_POLICY",
  "REFUND_POLICY",
  "SHIPPING_POLICY",
  "SUBSCRIPTION_POLICY",
  "TERMS_OF_SALE",
  "TERMS_OF_SERVICE",
]);

/**
 * Convert LEGACY combined "policies & pages" sources into one `policy` source
 * per legal policy. Runs automatically from the Training loader —
 * the user saw the old combined row in Manage sources and should never have
 * had to open the connector to get rid of it.
 *
 * - Store PAGES in it are dropped: they come from the Pages tab now (spec 22).
 * - A policy is recovered from `policyTypes` when present, else from a snapshot
 *   URL like /policies/refund-policy — Shopify's policy URL slug maps directly
 *   onto the ShopPolicyType enum (refund-policy → REFUND_POLICY).
 * - The new rows are created directly, not through createSource: they were
 *   already allowed under the old combined limit, and a quota refusal halfway
 *   through a conversion would silently disconnect a policy.
 * - Idempotent: a policy already connected is skipped, and the legacy row is
 *   deleted only after its policies exist.
 */
export async function convertLegacyPagesSources(
  shopId: string,
  options: SourceMutationOptions = {},
): Promise<{ created: number; removed: number }> {
  requireShopId(shopId);
  const legacy = await db.dataSource.findMany({ where: { shopId, type: "pages" } });
  if (legacy.length === 0) return { created: 0, removed: 0 };
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
  const connected = new Set(
    (await db.dataSource.findMany({ where: { shopId, type: "policy" }, select: { metadata: true } }))
      .map((s) => (s.metadata as { policyType?: unknown } | null)?.policyType)
      .filter((t): t is string => typeof t === "string"),
  );
  const created: string[] = [];
  for (const source of legacy) {
    const meta = (source.metadata ?? {}) as { pages?: unknown; policyTypes?: unknown };
    const pages = (Array.isArray(meta.pages) ? meta.pages : []) as ConnectedPage[];
    const types = new Set(
      (Array.isArray(meta.policyTypes) ? meta.policyTypes : []).filter(
        (t): t is string => typeof t === "string" && !t.startsWith("gid://shopify/Page/"),
      ),
    );
    for (const page of pages) {
      const slug = /\/policies\/([a-z-]+)\/?$/i.exec(page.url ?? "")?.[1];
      const derived = slug?.toUpperCase().replace(/-/g, "_");
      // Only a REAL policy type: /policies/returns is some other page, and a
      // made-up type would create a row that ingest could never match.
      if (derived && SHOP_POLICY_TYPES.has(derived)) types.add(derived);
    }
    for (const policyType of types) {
      if (connected.has(policyType)) continue;
      const title = humanizePolicyType(policyType);
      const snapshot =
        pages.find((p) => p.type === policyType) ??
        pages.find((p) => p.title?.toLowerCase() === title.toLowerCase()) ??
        pages.find((p) => (p.url ?? "").toLowerCase().includes(`/policies/${policyType.toLowerCase().replace(/_/g, "-")}`));
      const row = await db.dataSource.create({
        data: {
          shopId,
          type: "policy",
          name: title,
          url: snapshot?.url || null,
          reCrawlWeekly: true,
          status: "pending",
          // An empty body is fine: ingest re-reads the live policy from Shopify.
          metadata: { policyType, title, body: snapshot?.body ?? "" },
        },
        select: { id: true },
      });
      connected.add(policyType);
      created.push(row.id);
    }
    await deleteSource(shopId, source.id);
  }
  if ((options.enqueueIngest ?? true) && shop) {
    for (const id of created) await enqueueIngestJob(shop.domain, id);
  }
  return { created: created.length, removed: legacy.length };
}

function humanizePolicyType(type: string): string {
  const words = type.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── CSV parsing helper (07's mapping step calls this) ───────────────────────

export interface ParsedCsv {
  rows: { question: string; answer: string }[];
  badRows: { line: number; reason: string }[];
  hadHeader: boolean;
}

/**
 * Parse CSV text into question/answer rows. Header row optional — detected
 * when the first record names question/answer columns (any order); otherwise
 * columns 1 and 2 are used. Bad rows are reported, good rows kept (≤50).
 */
export function parseCsvContent(text: string): ParsedCsv {
  const records = splitCsv(text);
  const rows: ParsedCsv["rows"] = [];
  const badRows: ParsedCsv["badRows"] = [];
  if (records.length === 0) return { rows, badRows, hadHeader: false };

  const header = records[0].map((cell) => cell.trim().toLowerCase());
  let questionCol = header.findIndex((cell) => /question|query|q\b/.test(cell));
  let answerCol = header.findIndex((cell) => /answer|response|reply|a\b/.test(cell));
  const hadHeader = questionCol >= 0 && answerCol >= 0 && questionCol !== answerCol;
  if (!hadHeader) {
    questionCol = 0;
    answerCol = 1;
  }

  const dataRecords = hadHeader ? records.slice(1) : records;
  const lineOffset = hadHeader ? 2 : 1;
  for (let i = 0; i < dataRecords.length; i++) {
    const line = i + lineOffset;
    const question = (dataRecords[i][questionCol] ?? "").trim();
    const answer = (dataRecords[i][answerCol] ?? "").trim();
    if (!question || !answer) {
      badRows.push({ line, reason: !question ? "missing question" : "missing answer" });
      continue;
    }
    if (rows.length >= CSV_ROW_CAP) {
      badRows.push({ line, reason: `row limit (${CSV_ROW_CAP}) exceeded` });
      continue;
    }
    rows.push({ question, answer });
  }
  return { rows, badRows, hadHeader };
}

/** Minimal quote-aware CSV splitter (handles quoted commas/newlines, "" escapes). */
export function splitCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;
  const pushRecord = () => {
    record.push(cell);
    cell = "";
    if (record.some((c) => c.trim() !== "")) records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRecord();
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || record.length > 0) pushRecord();
  return records;
}

// ── File text extraction ────────────────────────────────────────────────────

async function extractFileText(
  name: string,
  mime: string,
  bytes: Buffer,
): Promise<{ text?: string; parseError?: string }> {
  const kind = fileKind(name, mime);
  switch (kind) {
    case "txt":
      return { text: bytes.toString("utf-8").trim() };
    case "json": {
      try {
        const value = JSON.parse(bytes.toString("utf-8")) as unknown;
        const text = flattenJson(value).join("\n").trim();
        if (!text) return { parseError: "JSON file contains no text content" };
        return { text };
      } catch {
        return { parseError: "invalid JSON file" };
      }
    }
    case "pdf": {
      // Text layer only — see pdf.server.ts. A scanned PDF comes back as a
      // parseError rather than an empty source that silently teaches nothing.
      const { text, parseError } = await extractPdfText(bytes);
      return parseError ? { parseError } : { text };
    }
    case "csv": {
      const text = csvToText(bytes.toString("utf-8"));
      if (!text) return { parseError: "CSV needs a header row and at least one data row" };
      return { text };
    }
    case "docx":
      // Still deferred (spec 04 delta): DOCX needs its own unzip+XML parser.
      // Rejected at upload so it can't consume the file_uploads quota.
      return { parseError: "DOCX isn't supported — upload a .pdf, .txt, .json or .csv" };
    default:
      return { parseError: "unsupported file type (.pdf .txt .json .csv only)" };
  }
}

/**
 * CSV → one text record per row, "Header: value" per non-empty cell, records
 * separated by a blank line so chunkText() prefers to split between rows. The
 * first row is the header (a knowledge CSV is a table — size charts, specs,
 * store locations); a blank header cell becomes "Column N". Repeating the
 * header on every row costs bytes but keeps each chunk self-describing, which
 * is what retrieval needs once a table is split across chunks.
 */
export function csvToText(csv: string): string {
  const records = splitCsv(csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv); // Excel writes a BOM
  if (records.length < 2) return "";
  const header = records[0].map((cell, i) => cell.trim() || `Column ${i + 1}`);
  const rows: string[] = [];
  for (const record of records.slice(1)) {
    const lines = record
      .map((cell, i) => [header[i] ?? `Column ${i + 1}`, cell.replace(/\s+/g, " ").trim()] as const)
      .filter(([, value]) => value !== "")
      .map(([name, value]) => `${name}: ${value}`);
    if (lines.length > 0) rows.push(lines.join("\n"));
  }
  return rows.join("\n\n");
}

/** File kinds this build can actually turn into text. Anything else is
 *  rejected at upload time rather than stored as a broken source.
 *  A PDF is parseable in principle, so a failure here (scanned, encrypted,
 *  corrupt) is a real error worth storing and showing, not a rejection. */
const PARSEABLE_KINDS = new Set(["txt", "json", "pdf"]);

/** Upload rejected because it is over its size cap (not a bug/failure). */
export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTooLargeError";
  }
}

/** Upload rejected because the format is not supported (not a bug/failure). */
export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileError";
  }
}

function fileKind(name: string, mime: string): "txt" | "json" | "pdf" | "csv" | "docx" | "unknown" {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m = mime.toLowerCase();
  // Before txt: some browsers report a .csv as text/plain. Windows with Excel
  // installed reports application/vnd.ms-excel, so the extension decides.
  if (ext === "csv" || m.startsWith("text/csv")) return "csv";
  if (ext === "txt" || m.startsWith("text/plain")) return "txt";
  if (ext === "json" || m.includes("application/json")) return "json";
  if (ext === "pdf" || m.includes("application/pdf")) return "pdf";
  if (ext === "docx" || m.includes("officedocument.wordprocessingml")) return "docx";
  return "unknown";
}

/** Flatten a JSON value into "path: value" lines for chunking/embedding. */
function flattenJson(value: unknown, path = ""): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    if (!text) return [];
    return [path ? `${path}: ${text}` : text];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenJson(item, path ? `${path}[${index}]` : `[${index}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flattenJson(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

// The suggested-Q&A review queue (v1 mechanics, generator always stubbed off)
// was removed with the manual source type — a future suggestion
// feature should propose FAQs instead (git history holds the old machinery).
