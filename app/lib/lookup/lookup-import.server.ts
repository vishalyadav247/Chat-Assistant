import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { getQuota } from "../billing/plans.server";
import { logError } from "../log.server";
import { requireShopId } from "../tenancy.server";
import {
  detectDelimiter,
  detectRanges,
  DISTINCT_CAP,
  iterateCsv,
  mappingProblem,
  MAX_TABLE_COLUMNS,
  normalizeCell,
  parseNumberRange,
  TABLE_DESCRIPTION_MAX,
  TABLE_FILE_MAX_BYTES,
  TABLE_UPLOAD_MAX_BYTES,
  uniqueHeaders,
  type ColumnRole,
  type TableColumn,
  type TableRange,
} from "./lookup-shared";

// Lookup tables (spec 28): a merchant CSV stored row by row so the AI filters
// it exactly. Upload validates and stores the file; the knowledge-ingest job
// (ingestSource → importLookupTable) parses it into lookup_rows. Every query
// is scoped by the trusted shopId.

export const TABLE_SOURCE_TYPE = "table";
/** Rows per INSERT — keeps a statement a few MB even for wide tables. */
const INSERT_BATCH = 1000;
const SAMPLE_VALUES = 12;

export interface TableMetadata {
  filename: string;
  description: string;
  delimiter: string;
  columns: TableColumn[];
  ranges: TableRange[];
  importedAt?: string;
  desiredStatus?: "active" | "inactive";
  error?: string;
  consecutiveFailures?: number;
}

/** A refusal the merchant can act on (limits, format) — not a bug. */
export class TableUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableUploadError";
  }
}

export function tableMetadata(metadata: unknown): TableMetadata {
  const meta = (metadata ?? {}) as Partial<TableMetadata>;
  return {
    filename: String(meta.filename ?? ""),
    description: String(meta.description ?? ""),
    delimiter: String(meta.delimiter ?? ","),
    columns: Array.isArray(meta.columns) ? meta.columns : [],
    ranges: Array.isArray(meta.ranges) ? meta.ranges : [],
    importedAt: meta.importedAt,
    desiredStatus: meta.desiredStatus,
    error: meta.error,
    consecutiveFailures: meta.consecutiveFailures,
  };
}

/** Rows a shop's tables hold, optionally leaving one source out. */
export async function lookupRowsUsed(shopId: string, excludeSourceId?: string): Promise<number> {
  requireShopId(shopId);
  const agg = await db.dataSource.aggregate({
    where: { shopId, type: TABLE_SOURCE_TYPE, ...(excludeSourceId ? { id: { not: excludeSourceId } } : {}) },
    _sum: { chunkCount: true },
  });
  return agg._sum.chunkCount ?? 0;
}

function decodeUpload(bytes: Buffer, gzipped: boolean): { text: string; gzip: Buffer } {
  if (bytes.byteLength > TABLE_UPLOAD_MAX_BYTES) {
    throw new TableUploadError(`File is too large to upload — the limit is ${TABLE_UPLOAD_MAX_BYTES / (1024 * 1024)}MB compressed.`);
  }
  let raw: Buffer;
  try {
    raw = gzipped ? gunzipSync(bytes, { maxOutputLength: TABLE_FILE_MAX_BYTES }) : bytes;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new TableUploadError(`CSV is too large — the limit is ${TABLE_FILE_MAX_BYTES / (1024 * 1024)}MB.`);
    }
    throw new TableUploadError("The file could not be read — upload it again.");
  }
  if (raw.byteLength > TABLE_FILE_MAX_BYTES) {
    throw new TableUploadError(`CSV is too large — the limit is ${TABLE_FILE_MAX_BYTES / (1024 * 1024)}MB.`);
  }
  return { text: raw.toString("utf-8"), gzip: gzipped ? bytes : gzipSync(raw) };
}

/** Header + data-row count, without keeping the rows. */
function scan(text: string): { delimiter: string; headers: string[]; rows: number } {
  const delimiter = detectDelimiter(text);
  let headers: string[] | null = null;
  let rows = 0;
  for (const record of iterateCsv(text, delimiter)) {
    if (!headers) headers = uniqueHeaders(record);
    else rows++;
  }
  if (!headers) throw new TableUploadError("The CSV is empty.");
  if (headers.length > MAX_TABLE_COLUMNS) {
    throw new TableUploadError(`The CSV has ${headers.length} columns — the limit is ${MAX_TABLE_COLUMNS}. Remove the columns the AI doesn't need.`);
  }
  if (rows === 0) throw new TableUploadError("The CSV needs a header row and at least one data row.");
  return { delimiter, headers, rows };
}

function limitMessage(rows: number, used: number, limit: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `This file has ${fmt(rows)} rows, and your plan allows ${fmt(limit)} lookup-table rows (${fmt(used)} already used). Upgrade, or split the file.`;
}

export interface CreateTableInput {
  title: string;
  description: string;
  filename: string;
  /** One role per CSV column, in header order. */
  roles: ColumnRole[];
  bytes: Buffer;
  gzipped: boolean;
}

/**
 * Validate (format, columns, plan limits) → store the file + a pending
 * data_sources row → enqueue the import. Nothing is stored when refused.
 */
export async function createTableSource(
  shopId: string,
  input: CreateTableInput,
  options: { enqueue?: boolean } = {},
) {
  requireShopId(shopId);
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true, domain: true } });
  if (!shop) throw new Error("lookup: shop not found");
  const title = input.title.trim().slice(0, 200);
  const description = input.description.trim().slice(0, TABLE_DESCRIPTION_MAX);
  if (!title) throw new TableUploadError("Give the table a title.");
  if (!description) throw new TableUploadError("Say what the table is for — the AI uses it to know when to look rows up.");

  const fileLimit = getQuota(shop.plan, "file_uploads");
  const filesUsed = await db.dataSource.count({ where: { shopId, type: { in: ["file", TABLE_SOURCE_TYPE] } } });
  if (filesUsed >= fileLimit) {
    throw new TableUploadError(`Plan limit reached: ${filesUsed} of ${fileLimit} file uploads used. Upgrade to add more.`);
  }

  const { text, gzip } = decodeUpload(input.bytes, input.gzipped);
  const { delimiter, headers, rows } = scan(text);
  if (input.roles.length !== headers.length) {
    throw new TableUploadError("The column mapping doesn't match the file — choose the file again.");
  }
  const problem = mappingProblem(input.roles);
  if (problem) throw new TableUploadError(problem);

  const rowLimit = getQuota(shop.plan, "lookup_rows");
  const rowsUsed = await lookupRowsUsed(shopId);
  if (rowsUsed + rows > rowLimit) throw new TableUploadError(limitMessage(rows, rowsUsed, rowLimit));

  const columns: TableColumn[] = headers.map((name, i) => ({
    key: `c${i}`,
    name,
    role: input.roles[i],
    numeric: false,
    distinct: 0,
    samples: [],
  }));
  const metadata: TableMetadata = {
    filename: input.filename.slice(0, 200),
    description,
    delimiter,
    columns,
    ranges: detectRanges(columns),
  };

  const source = await db.$transaction(async (tx) => {
    const created = await tx.dataSource.create({
      data: {
        shopId,
        type: TABLE_SOURCE_TYPE,
        name: title,
        status: "pending",
        // Counted against lookup_rows while the import runs, so two uploads
        // started together cannot both fit under the limit.
        chunkCount: rows,
        metadata: metadata as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.lookupFile.create({
      data: { dataSourceId: created.id, shopId, gzip: new Uint8Array(gzip), bytes: Buffer.byteLength(text) },
    });
    return created;
  });

  if (options.enqueue ?? true) {
    const { enqueue } = await import("../jobs/queue.server");
    const { KNOWLEDGE_INGEST_JOB } = await import("../ingestion/knowledge-jobs.server");
    await enqueue(KNOWLEDGE_INGEST_JOB, { shopDomain: shop.domain, sourceId: source.id });
  }
  return source;
}

/**
 * Parse the stored file into lookup_rows (replacing any previous import) and
 * profile every column. Called by ingestSource for type "table".
 */
export async function importLookupTable(shopId: string, sourceId: string): Promise<{ sourceId: string; chunkCount: number }> {
  requireShopId(shopId);
  const source = await db.dataSource.findFirst({ where: { id: sourceId, shopId, type: TABLE_SOURCE_TYPE } });
  if (!source) throw new Error(`lookup: table ${sourceId} not found for shop`);
  const meta = tableMetadata(source.metadata);
  const switchedOff = meta.desiredStatus === "inactive" || source.status === "inactive";

  try {
    const file = await db.lookupFile.findFirst({ where: { dataSourceId: sourceId, shopId } });
    if (!file) throw new TableUploadError("The uploaded file is missing — delete this table and upload it again.");
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    const text = gunzipSync(Buffer.from(file.gzip), { maxOutputLength: TABLE_FILE_MAX_BYTES }).toString("utf-8");
    const { delimiter, headers, rows: rowTotal } = scan(text);
    if (headers.length !== meta.columns.length) {
      throw new TableUploadError("The file's columns no longer match this table — delete it and upload again.");
    }
    const rowLimit = getQuota(shop?.plan ?? "free", "lookup_rows");
    const rowsUsed = await lookupRowsUsed(shopId, sourceId);
    if (rowsUsed + rowTotal > rowLimit) throw new TableUploadError(limitMessage(rowTotal, rowsUsed, rowLimit));

    let rowTotalImported = 0;
    const profile = meta.columns.map(() => ({
      counts: new Map<string, { raw: string; n: number }>(),
      overflow: false,
      nonEmpty: 0,
      numeric: 0,
    }));

    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtext(${shopId}), hashtext(${`lookup:${sourceId}`}))
        `);
        await tx.lookupRow.deleteMany({ where: { shopId, dataSourceId: sourceId } });
        let batch: { values: string; norm: string; nums: string }[] = [];
        let rowIndex = 0;
        const flush = async () => {
          if (batch.length === 0) return;
          const start = rowIndex - batch.length;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "lookup_rows" ("id", "shopId", "dataSourceId", "rowIndex", "values", "norm", "nums")
            SELECT u.id, ${shopId}, ${sourceId}, u.idx, u.v::jsonb, u.n::jsonb, u.x::jsonb
            FROM unnest(
              ${batch.map(() => randomUUID())}::text[],
              ${batch.map((_, j) => start + j)}::int[],
              ${batch.map((b) => b.values)}::text[],
              ${batch.map((b) => b.norm)}::text[],
              ${batch.map((b) => b.nums)}::text[]
            ) AS u(id, idx, v, n, x)
          `);
          batch = [];
        };
        let header = true;
        for (const record of iterateCsv(text, delimiter)) {
          if (header) {
            header = false;
            continue;
          }
          const values: Record<string, string> = {};
          const norm: Record<string, string> = {};
          const nums: Record<string, [number, number]> = {};
          for (let i = 0; i < meta.columns.length; i++) {
            const cell = (record[i] ?? "").replace(/\s+/g, " ").trim();
            if (!cell) continue;
            const key = meta.columns[i].key;
            const normalized = normalizeCell(cell);
            values[key] = cell;
            norm[key] = normalized;
            const range = parseNumberRange(cell);
            if (range) nums[key] = range;
            const p = profile[i];
            p.nonEmpty++;
            if (range) p.numeric++;
            const seen = p.counts.get(normalized);
            if (seen) seen.n++;
            else if (p.counts.size <= DISTINCT_CAP) p.counts.set(normalized, { raw: cell, n: 1 });
            else p.overflow = true;
          }
          if (Object.keys(values).length === 0) continue;
          batch.push({ values: JSON.stringify(values), norm: JSON.stringify(norm), nums: JSON.stringify(nums) });
          rowIndex++;
          if (batch.length >= INSERT_BATCH) await flush();
        }
        await flush();

        const columns: TableColumn[] = meta.columns.map((column, i) => {
          const p = profile[i];
          return {
            ...column,
            numeric: p.nonEmpty > 0 && p.numeric / p.nonEmpty >= 0.9,
            distinct: p.overflow ? DISTINCT_CAP + 1 : p.counts.size,
            samples: [...p.counts.values()]
              .sort((a, b) => b.n - a.n)
              .slice(0, SAMPLE_VALUES)
              .map((v) => v.raw.slice(0, 60)),
          };
        });
        const next: TableMetadata = { ...meta, delimiter, columns, importedAt: new Date().toISOString() };
        delete next.error;
        delete next.consecutiveFailures;
        await tx.dataSource.updateMany({
          where: { id: sourceId, shopId },
          data: {
            status: switchedOff ? "inactive" : "active",
            chunkCount: rowIndex,
            lastSyncedAt: new Date(),
            metadata: next as unknown as Prisma.InputJsonValue,
          },
        });
        rowTotalImported = rowIndex;
      },
      { timeout: 600_000, maxWait: 15_000 },
    );
    return { sourceId, chunkCount: rowTotalImported };
  } catch (error) {
    const message =
      error instanceof TableUploadError ? error.message : error instanceof Error ? error.message : String(error);
    if (!(error instanceof TableUploadError)) logError("lookup_import_error", error, { shopId, sourceId });
    // The rows that survived (a failed re-import keeps the previous set) are
    // what counts against lookup_rows — not the pending count from the upload.
    const keptRows = await db.lookupRow.count({ where: { shopId, dataSourceId: sourceId } }).catch(() => 0);
    await db.dataSource
      .updateMany({
        where: { id: sourceId, shopId },
        data: {
          status: switchedOff ? "inactive" : "error",
          chunkCount: keptRows,
          metadata: {
            ...meta,
            error: message.slice(0, 500),
            // A limit or format refusal won't fix itself — stop the weekly retry sweep.
            consecutiveFailures: error instanceof TableUploadError ? 99 : (meta.consecutiveFailures ?? 0) + 1,
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => {});
    throw error;
  }
}

/** Merchant edits: title, description, roles, status — metadata only, no re-import. */
export async function updateTableSource(
  shopId: string,
  sourceId: string,
  input: { name: string; description: string; roles: Record<string, ColumnRole>; status: "active" | "inactive" },
): Promise<void> {
  requireShopId(shopId);
  const source = await db.dataSource.findFirst({ where: { id: sourceId, shopId, type: TABLE_SOURCE_TYPE } });
  if (!source) throw new TableUploadError("Table not found.");
  const meta = tableMetadata(source.metadata);
  const description = input.description.trim().slice(0, TABLE_DESCRIPTION_MAX);
  if (!description) throw new TableUploadError("Say what the table is for.");
  const columns = meta.columns.map((c) => ({ ...c, role: input.roles[c.key] ?? c.role }));
  const problem = mappingProblem(columns.map((c) => c.role));
  if (problem) throw new TableUploadError(problem);
  const next: TableMetadata = { ...meta, description, columns, desiredStatus: input.status };
  await db.dataSource.updateMany({
    where: { id: sourceId, shopId },
    data: {
      name: input.name.trim().slice(0, 200) || source.name,
      metadata: next as unknown as Prisma.InputJsonValue,
      // A table still importing (or failed) keeps that status; the switch applies once it's active.
      ...(source.status === "active" || source.status === "inactive" ? { status: input.status } : {}),
    },
  });
}
