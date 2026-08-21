import { Prisma } from "@prisma/client";
import type { DataSource } from "@prisma/client";
import { z } from "zod";
import db from "../../db.server";
import { getQuota, requirePlan } from "../billing/plans.server";
import { requireShopId } from "../tenancy.server";
import { htmlToText } from "./fetchers.server";
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
  crawlScope: z.enum(["page", "linked", "sitemap"]).default("page"),
  reCrawlWeekly: z.boolean().default(false),
  status: statusSchema,
  name: z.string().trim().min(1).max(200).optional(),
});

export const manualSourceSchema = z.object({
  type: z.literal("manual"),
  question: z.string().trim().min(1).max(500),
  synonyms: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  answer: z.string().trim().min(1).max(10_000),
  status: statusSchema,
});

export const csvSourceSchema = z.object({
  type: z.literal("csv"),
  name: z.string().trim().min(1).max(200),
  rows: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(500),
        answer: z.string().trim().min(1).max(10_000),
      }),
    )
    .min(1)
    .max(CSV_ROW_CAP),
});

export const fileSourceSchema = z.object({
  type: z.literal("file"),
  name: z.string().trim().min(1).max(200),
  mime: z.string().trim().max(200),
  bytes: z.instanceof(Buffer),
});

export const pagesSourceSchema = z.object({
  type: z.literal("pages"),
  name: z.string().trim().min(1).max(200).optional(),
  pages: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        url: z.string().trim().max(2000).default(""),
        body: z.string().min(1),
      }),
    )
    .min(1)
    .max(50),
});

export const createSourceSchema = z.discriminatedUnion("type", [
  urlSourceSchema,
  manualSourceSchema,
  csvSourceSchema,
  fileSourceSchema,
  pagesSourceSchema,
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
    where: { shopId, status: { not: "suggested" }, ...(typeFilter ? { type: typeFilter } : {}) },
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
      // crawl_pages quota is a per-crawl page cap, enforced inside ingest;
      // the seam is read here too so meters and creation share one number.
      getQuota(plan, "crawl_pages");
      data = {
        shopId,
        type: "url",
        name: parsed.name ?? parsed.url,
        url: parsed.url,
        crawlScope: parsed.crawlScope,
        reCrawlWeekly: parsed.reCrawlWeekly,
        status: "pending",
        metadata: { desiredStatus: parsed.status },
      };
      break;
    }
    case "manual": {
      const limit = getQuota(plan, "manual_qas");
      const used = await db.dataSource.count({
        where: { shopId, type: "manual", status: { not: "suggested" } },
      });
      if (used >= limit) throw new QuotaError("manual_qas", used, limit);
      data = {
        shopId,
        type: "manual",
        name: parsed.question,
        status: "pending",
        metadata: {
          question: parsed.question,
          synonyms: parsed.synonyms,
          answer: parsed.answer,
          desiredStatus: parsed.status,
        },
      };
      break;
    }
    case "csv": {
      requirePlan(plan, "csv_import"); // plan-gated feature seam (row cap via schema)
      data = {
        shopId,
        type: "csv",
        name: parsed.name,
        status: "pending",
        metadata: { rows: parsed.rows },
      };
      break;
    }
    case "file": {
      requirePlan(plan, "file_upload");
      const limit = getQuota(plan, "file_uploads");
      const used = await db.dataSource.count({ where: { shopId, type: "file" } });
      if (used >= limit) throw new QuotaError("file_uploads", used, limit);
      if (parsed.bytes.byteLength > FILE_BYTE_CAP) {
        throw new Error("file too large (max 2MB)");
      }
      const { text, parseError } = extractFileText(parsed.name, parsed.mime, parsed.bytes);
      // A file type we can never parse must not become a stored "error" row:
      // it consumed the file_uploads quota, and re-adding it just piled up
      // duplicates (QA D12e). Reject it outright instead.
      if (parseError && !PARSEABLE_KINDS.has(fileKind(parsed.name, parsed.mime))) {
        throw new UnsupportedFileError(parseError);
      }
      data = {
        shopId,
        type: "file",
        name: parsed.name,
        status: parseError ? "error" : "pending",
        metadata: parseError
          ? { filename: parsed.name, mime: parsed.mime, error: parseError }
          : { filename: parsed.name, mime: parsed.mime, text },
      };
      break;
    }
    case "pages": {
      const limit = getQuota(plan, "policy_pages");
      const used = await countPolicyPages(shopId);
      if (used + parsed.pages.length > limit) {
        throw new QuotaError("policy_pages", used + parsed.pages.length, limit);
      }
      data = {
        shopId,
        type: "pages",
        name: parsed.name ?? "Store policies & pages",
        status: "pending",
        metadata: { pages: parsed.pages },
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
  if (source.type !== "url" && source.type !== "pages") {
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

async function countPolicyPages(shopId: string): Promise<number> {
  const sources = await db.dataSource.findMany({
    where: { shopId, type: "pages" },
    select: { metadata: true },
  });
  return sources.reduce((sum, source) => {
    const pages = (source.metadata as { pages?: unknown[] } | null)?.pages;
    return sum + (Array.isArray(pages) ? pages.length : 0);
  }, 0);
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
export async function fetchShopPolicies(shopDomain: string): Promise<PolicyCandidate[]> {
  const { unauthenticated } = await import("../../shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  let response: Awaited<ReturnType<typeof admin.graphql>>;
  try {
    response = await admin.graphql(SHOP_POLICIES_QUERY);
  } catch (error) {
    // Stores that installed before read_legal_policies was added haven't
    // re-consented yet — degrade to an empty candidate list, never a crash.
    logError("shop_policies_access", error, { shopDomain });
    return [];
  }
  const body = (await response.json()) as {
    data?: {
      shop?: {
        shopPolicies?: Array<{ type: string; body: string | null; url: string | null }>;
      };
    };
  };
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
 * not here. Needs the read_online_store_pages scope.
 */
export async function fetchShopPages(shopDomain: string): Promise<PolicyCandidate[]> {
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
  }
  return candidates.slice(0, PAGE_CANDIDATE_CAP);
}

/** Policies + all Online Store pages — the full connector candidate list. */
export async function fetchPageCandidates(shopDomain: string): Promise<PolicyCandidate[]> {
  const [policies, pages] = await Promise.all([
    fetchShopPolicies(shopDomain),
    fetchShopPages(shopDomain),
  ]);
  return [...policies, ...pages];
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

function extractFileText(
  name: string,
  mime: string,
  bytes: Buffer,
): { text?: string; parseError?: string } {
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
    case "pdf":
    case "docx":
      // Spec 04 delta: quality text extraction for PDF/DOCX needs a parser
      // dependency, which this task may not add. Source is created with
      // status "error" so the UI can surface it; ingest never runs.
      return { parseError: `${kind.toUpperCase()} parser pending — .txt and .json are supported today` };
    default:
      return { parseError: "unsupported file type (.pdf .docx .txt .json only)" };
  }
}

/** File kinds this build can actually turn into text. Anything else is
 *  rejected at upload time rather than stored as a broken source. */
const PARSEABLE_KINDS = new Set(["txt", "json"]);

/** Upload rejected because the format is not supported (not a bug/failure). */
export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileError";
  }
}

function fileKind(name: string, mime: string): "txt" | "json" | "pdf" | "docx" | "unknown" {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m = mime.toLowerCase();
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

// ── Suggested Q&A review queue (v1: mechanics only) ─────────────────────────

export interface SuggestedQa {
  id: string;
  question: string;
  answer: string;
  createdAt: Date;
}

/** Pending suggestions: DataSource rows with status=suggested, type=manual. */
export async function listSuggested(shopId: string): Promise<SuggestedQa[]> {
  requireShopId(shopId);
  const rows = await db.dataSource.findMany({
    where: { shopId, status: "suggested", type: "manual" },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as { question?: unknown; answer?: unknown };
    return {
      id: row.id,
      question: typeof meta.question === "string" ? meta.question : row.name,
      answer: typeof meta.answer === "string" ? meta.answer : "",
      createdAt: row.createdAt,
    };
  });
}

/** Approve a suggestion: it becomes a regular manual source and is ingested. */
export async function approveSuggested(
  shopId: string,
  sourceId: string,
  options: SourceMutationOptions = {},
): Promise<DataSource> {
  requireShopId(shopId);
  const source = await db.dataSource.findFirst({
    where: { id: sourceId, shopId, status: "suggested", type: "manual" },
  });
  if (!source) throw new Error("sources: suggested Q&A not found");
  const meta = (source.metadata ?? {}) as {
    question?: unknown;
    answer?: unknown;
    synonyms?: unknown;
  };
  const question = typeof meta.question === "string" ? meta.question.trim() : "";
  const answer = typeof meta.answer === "string" ? meta.answer.trim() : "";
  if (!question || !answer) throw new Error("sources: suggested Q&A is missing question/answer");

  // Approval consumes manual-Q&A quota exactly like a hand-created one.
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true, domain: true } });
  if (!shop) throw new Error("sources: shop not found");
  const limit = getQuota(shop.plan, "manual_qas");
  const used = await db.dataSource.count({
    where: { shopId, type: "manual", status: { not: "suggested" } },
  });
  if (used >= limit) throw new QuotaError("manual_qas", used, limit);

  await db.dataSource.updateMany({
    where: { id: sourceId, shopId },
    data: {
      status: "pending",
      name: question,
      metadata: {
        question,
        answer,
        synonyms: Array.isArray(meta.synonyms) ? meta.synonyms : [],
        desiredStatus: "active",
      },
    },
  });
  if (options.enqueueIngest ?? true) {
    await enqueueIngestJob(shop.domain, sourceId);
  } else {
    await ingestSource(shopId, sourceId);
  }
  const updated = await db.dataSource.findFirst({ where: { id: sourceId, shopId } });
  if (!updated) throw new Error("sources: source disappeared during approval");
  return updated;
}

/** Dismiss a suggestion (no knowledge rows exist yet — plain delete). */
export async function dismissSuggested(shopId: string, sourceId: string): Promise<boolean> {
  requireShopId(shopId);
  const result = await db.dataSource.deleteMany({
    where: { id: sourceId, shopId, status: "suggested" },
  });
  return result.count > 0;
}

/** v1 feature flag: the suggestion generator is stubbed off (queue mechanics only). */
export const SUGGESTED_QA_GENERATION_ENABLED = false;

/**
 * Suggested-Q&A generator — STUB (spec 04 v1 ships mechanics only).
 * TODO(spec 04 v2): LLM-generate candidates from product descriptions and
 * policies, then create DataSource rows {type: "manual", status: "suggested",
 * metadata: {question, answer}} for the review queue.
 */
export async function generateSuggestedQas(shopId: string): Promise<number> {
  requireShopId(shopId);
  if (!SUGGESTED_QA_GENERATION_ENABLED) return 0;
  return 0;
}
