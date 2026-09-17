import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { SHOWABLE_PRODUCT } from "../search/showable";
import { requireShopId } from "../tenancy.server";
import { tableMetadata, TABLE_SOURCE_TYPE } from "./lookup-import.server";
import {
  compactCell,
  DISTINCT_CAP,
  normalizeCell,
  parseNumberRange,
  type TableColumn,
  type TableRange,
} from "./lookup-shared";

// Lookup tables (spec 28) — what the agent's lookup_table tool runs. Filters
// are matched against the column's real values first (exact → punctuation-
// insensitive → word prefix → typo), so the SQL only ever compares exact
// normalised values or numeric ranges. Column keys come from stored metadata,
// never from tool input.

/** Tables offered to the agent per turn (newest first). */
export const MAX_AGENT_TABLES = 10;
const ROW_LIMIT = 20;
const COUNT_CAP = 1000;
const NARROW_VALUES = 10;
const NARROW_SCAN = 5000;
const MAX_CANDIDATES = 30;

export interface LookupTable {
  id: string;
  name: string;
  description: string;
  importedAt: string;
  columns: TableColumn[];
  ranges: TableRange[];
}

/** Active, imported tables of a shop — the agent's view. */
export async function activeLookupTables(shopId: string): Promise<LookupTable[]> {
  requireShopId(shopId);
  const sources = await db.dataSource.findMany({
    where: { shopId, type: TABLE_SOURCE_TYPE, status: "active", chunkCount: { gt: 0 } },
    orderBy: { createdAt: "desc" },
    take: MAX_AGENT_TABLES,
    select: { id: true, name: true, metadata: true },
  });
  return sources.map((s) => {
    const meta = tableMetadata(s.metadata);
    return {
      id: s.id,
      name: s.name,
      description: meta.description,
      importedAt: meta.importedAt ?? "",
      columns: meta.columns,
      ranges: meta.ranges,
    };
  });
}

// ── Distinct values (cached per import) ────────────────────────────────────

interface DistinctValue {
  norm: string;
  compact: string;
  words: string[];
}

const distinctCache = new Map<string, DistinctValue[]>();
const DISTINCT_CACHE_MAX = 60;

async function distinctValues(shopId: string, table: LookupTable, key: string): Promise<DistinctValue[]> {
  const cacheKey = `${table.id}:${table.importedAt}:${key}`;
  const hit = distinctCache.get(cacheKey);
  if (hit) return hit;
  const rows = await db.$queryRaw<{ v: string }[]>(Prisma.sql`
    SELECT DISTINCT "norm"->>${key} AS v FROM "lookup_rows"
    WHERE "shopId" = ${shopId} AND "dataSourceId" = ${table.id} AND "norm"->>${key} IS NOT NULL
    LIMIT ${DISTINCT_CAP + 1}
  `);
  const values = rows.map((r) => ({ norm: r.v, compact: compactCell(r.v), words: r.v.split(" ") }));
  if (distinctCache.size >= DISTINCT_CACHE_MAX) distinctCache.delete(distinctCache.keys().next().value!);
  distinctCache.set(cacheKey, values);
  return values;
}

/** Edit distance, stopping early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The column values a shopper's value means, best tier only:
 * exact → punctuation-insensitive → every word prefixes a word → typo.
 */
export function matchValues(values: DistinctValue[], input: string): { matches: string[]; closest: string[] } {
  const norm = normalizeCell(input);
  const compact = compactCell(input);
  if (!norm) return { matches: [], closest: [] };
  const exact = values.filter((v) => v.norm === norm);
  if (exact.length > 0) return { matches: exact.map((v) => v.norm), closest: [] };
  if (compact) {
    const loose = values.filter((v) => v.compact === compact);
    if (loose.length > 0) return { matches: loose.map((v) => v.norm).slice(0, MAX_CANDIDATES), closest: [] };
  }
  const words = norm.split(" ");
  const prefixed = values.filter((v) => words.every((w) => v.words.some((vw) => vw.startsWith(w))));
  if (prefixed.length > 0) return { matches: prefixed.map((v) => v.norm).slice(0, MAX_CANDIDATES), closest: [] };
  const max = compact.length >= 8 ? 2 : compact.length >= 4 ? 1 : 0;
  const scored = values
    .map((v) => ({ v, d: editDistance(compact, v.compact, Math.max(max, 3)) }))
    .sort((a, b) => a.d - b.d);
  const typos = max > 0 ? scored.filter((s) => s.d <= max) : [];
  if (typos.length > 0) return { matches: typos.map((s) => s.v.norm).slice(0, MAX_CANDIDATES), closest: [] };
  return { matches: [], closest: scored.filter((s) => s.d <= 3).slice(0, 3).map((s) => s.v.norm) };
}

// ── The lookup ──────────────────────────────────────────────────────────────

export interface LookupFilter {
  column: string;
  value: string;
}

export interface LookupResult {
  table: string;
  matched_rows: number | string;
  rows: Record<string, string>[];
  narrow_by?: Record<string, { value: string; rows: number }[]>;
  unmatched?: { column: string; value: string; closest_values: string[] }[];
  ignored_filters?: string[];
  note?: string;
  /** Linked catalogue products (gid → title), for cards. Not sent to the model. */
  linkedProducts: Map<string, string>;
}

function findTable(tables: LookupTable[], name: string): LookupTable | undefined {
  const norm = normalizeCell(name);
  return (
    tables.find((t) => normalizeCell(t.name) === norm) ??
    tables.find((t) => normalizeCell(t.name).includes(norm) || norm.includes(normalizeCell(t.name))) ??
    (tables.length === 1 ? tables[0] : undefined)
  );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function lookupTableRows(
  shopId: string,
  tableName: string,
  filters: LookupFilter[],
  options: { tables?: LookupTable[]; linkProducts?: boolean } = {},
): Promise<LookupResult> {
  requireShopId(shopId);
  const tables = options.tables ?? (await activeLookupTables(shopId));
  const table = findTable(tables, tableName);
  const empty = { rows: [], linkedProducts: new Map<string, string>() };
  if (!table) {
    return { ...empty, table: tableName, matched_rows: 0, note: `No table named "${tableName}". Tables: ${tables.map((t) => t.name).join(", ")}.` };
  }

  const conditions: Prisma.Sql[] = [Prisma.sql`"shopId" = ${shopId}`, Prisma.sql`"dataSourceId" = ${table.id}`];
  const used = new Set<string>();
  const unmatched: NonNullable<LookupResult["unmatched"]> = [];
  const ignored: string[] = [];
  const containment: Record<string, string> = {};

  for (const filter of filters.slice(0, 12)) {
    const columnName = normalizeCell(String(filter.column ?? ""));
    const value = String(filter.value ?? "").trim().slice(0, 200);
    if (!columnName || !value) continue;
    const range = table.ranges.find((r) => normalizeCell(r.name) === columnName);
    const number = parseNumberRange(value);
    if (range) {
      if (!number) {
        unmatched.push({ column: range.name, value, closest_values: ["a number"] });
        continue;
      }
      used.add(range.from).add(range.to);
      conditions.push(Prisma.sql`("nums"->${range.from} IS NOT NULL OR "nums"->${range.to} IS NOT NULL)`);
      conditions.push(Prisma.sql`COALESCE(("nums"->${range.from}->>0)::float8, '-Infinity'::float8) <= ${number[1]}`);
      // An empty "to" is open-ended ("2017 –"), unless the "from" cell is itself a range ("2006-2011").
      conditions.push(Prisma.sql`COALESCE(
        ("nums"->${range.to}->>1)::float8,
        CASE WHEN "nums"->${range.from}->>0 IS DISTINCT FROM "nums"->${range.from}->>1
          THEN ("nums"->${range.from}->>1)::float8 ELSE 'Infinity'::float8 END
      ) >= ${number[0]}`);
      continue;
    }
    const column = table.columns.find((c) => c.role !== "ignore" && normalizeCell(c.name) === columnName);
    if (!column) {
      ignored.push(String(filter.column));
      continue;
    }
    used.add(column.key);
    if (column.numeric && number) {
      conditions.push(Prisma.sql`("nums"->${column.key}->>0)::float8 <= ${number[1]}`);
      conditions.push(Prisma.sql`("nums"->${column.key}->>1)::float8 >= ${number[0]}`);
      continue;
    }
    if (column.distinct > DISTINCT_CAP) {
      // Too many values to match in memory (e.g. SKUs): exact or prefix in SQL.
      const norm = normalizeCell(value);
      conditions.push(Prisma.sql`("norm"->>${column.key} = ${norm} OR "norm"->>${column.key} LIKE ${`${escapeLike(norm)}%`})`);
      continue;
    }
    const { matches, closest } = matchValues(await distinctValues(shopId, table, column.key), value);
    if (matches.length === 0) {
      unmatched.push({ column: column.name, value, closest_values: closest });
    } else if (matches.length === 1) {
      containment[column.key] = matches[0];
    } else {
      conditions.push(Prisma.sql`"norm"->>${column.key} = ANY(${matches}::text[])`);
    }
  }

  const base = { table: table.name, ...(ignored.length > 0 ? { ignored_filters: ignored } : {}) };
  if (unmatched.length > 0) {
    return {
      ...base,
      ...empty,
      matched_rows: 0,
      unmatched,
      note: "No row has these values. If a closest value is clearly what the shopper meant, look up again with it; otherwise ask the shopper.",
    };
  }
  if (Object.keys(containment).length > 0) {
    conditions.push(Prisma.sql`"norm" @> ${JSON.stringify(containment)}::jsonb`);
  }
  if (used.size === 0) {
    return { ...base, ...empty, matched_rows: 0, note: "Give at least one filter from the table's filter columns." };
  }
  const where = Prisma.join(conditions, " AND ");

  const [countRows, rows] = await Promise.all([
    db.$queryRaw<{ c: number }[]>(Prisma.sql`
      SELECT count(*)::int AS c FROM (SELECT 1 FROM "lookup_rows" WHERE ${where} LIMIT ${COUNT_CAP + 1}) s
    `),
    db.$queryRaw<{ values: Record<string, string> }[]>(Prisma.sql`
      SELECT "values" FROM "lookup_rows" WHERE ${where} ORDER BY "rowIndex" LIMIT ${ROW_LIMIT}
    `),
  ]);
  const count = countRows[0]?.c ?? 0;

  // Values of the filters the shopper hasn't given, among the matches.
  const narrow: NonNullable<LookupResult["narrow_by"]> = {};
  if (count > 1) {
    const open = table.columns.filter((c) => c.role === "filter" && !used.has(c.key));
    const facets = await Promise.all(
      open.map((c) =>
        db.$queryRaw<{ v: string; n: number }[]>(Prisma.sql`
          SELECT s.v, count(*)::int AS n FROM (
            SELECT "values"->>${c.key} AS v FROM "lookup_rows" WHERE ${where} LIMIT ${NARROW_SCAN}
          ) s WHERE s.v IS NOT NULL GROUP BY s.v ORDER BY n DESC, s.v LIMIT ${NARROW_VALUES + 1}
        `),
      ),
    );
    open.forEach((c, i) => {
      if (facets[i].length > 1) narrow[c.name] = facets[i].slice(0, NARROW_VALUES).map((f) => ({ value: f.v, rows: f.n }));
    });
    for (const r of table.ranges.filter((r) => !used.has(r.from))) {
      const [span] = await db.$queryRaw<{ lo: number | null; hi: number | null }[]>(Prisma.sql`
        SELECT min(("nums"->${r.from}->>0)::float8) AS lo, max(("nums"->${r.to}->>1)::float8) AS hi
        FROM (SELECT "nums" FROM "lookup_rows" WHERE ${where} LIMIT ${NARROW_SCAN}) s
      `);
      if (span?.lo != null && span?.hi != null && span.lo !== span.hi) {
        narrow[r.name] = [{ value: `${span.lo}–${span.hi}`, rows: count }];
      }
    }
  }

  // Product links, shop-scoped and showable only.
  const linkColumn = table.columns.find((c) => c.role.startsWith("link_"));
  const linkedProducts = new Map<string, string>();
  const productByValue = new Map<string, { gid: string; title: string }>();
  if (linkColumn && options.linkProducts !== false && rows.length > 0) {
    const refs = [...new Set(rows.map((r) => r.values[linkColumn.key]).filter(Boolean))];
    if (refs.length > 0) {
      let found: { ref: string; gid: string; title: string }[] = [];
      if (linkColumn.role === "link_sku") {
        const lowered = refs.map((r) => r.toLowerCase());
        const hits = await db.$queryRaw<{ ref: string; id: string }[]>(Prisma.sql`
          SELECT lower(v->>'sku') AS ref, p."id" FROM "products" p, jsonb_array_elements(COALESCE(p."variants", '[]'::jsonb)) v
          WHERE p."shopId" = ${shopId} AND jsonb_typeof(p."variants") = 'array' AND lower(v->>'sku') = ANY(${lowered}::text[])
        `);
        const products = await db.product.findMany({
          where: { shopId, id: { in: hits.map((h) => h.id) }, ...SHOWABLE_PRODUCT },
          select: { id: true, shopifyProductId: true, title: true },
        });
        const byId = new Map(products.map((p) => [p.id, p]));
        found = hits.flatMap((h) => {
          const p = byId.get(h.id);
          return p ? [{ ref: h.ref, gid: p.shopifyProductId, title: p.title }] : [];
        });
      } else if (linkColumn.role === "link_handle") {
        const products = await db.product.findMany({
          where: { shopId, handle: { in: refs.map((r) => r.toLowerCase()) }, ...SHOWABLE_PRODUCT },
          select: { handle: true, shopifyProductId: true, title: true },
        });
        found = products.map((p) => ({ ref: p.handle, gid: p.shopifyProductId, title: p.title }));
      } else {
        const products = await db.product.findMany({
          where: { shopId, ...SHOWABLE_PRODUCT, OR: refs.slice(0, ROW_LIMIT).map((r) => ({ title: { equals: r, mode: "insensitive" as const } })) },
          select: { shopifyProductId: true, title: true },
        });
        found = products.map((p) => ({ ref: p.title.toLowerCase(), gid: p.shopifyProductId, title: p.title }));
      }
      for (const f of found) productByValue.set(f.ref.toLowerCase(), { gid: f.gid, title: f.title });
    }
  }

  const shown = table.columns.filter((c) => c.role !== "ignore");
  const outRows = rows.map((r) => {
    const out: Record<string, string> = {};
    for (const c of shown) if (r.values[c.key]) out[c.name] = r.values[c.key];
    if (linkColumn) {
      const product = productByValue.get(String(r.values[linkColumn.key] ?? "").toLowerCase());
      if (product) {
        out.product = product.title;
        linkedProducts.set(product.gid, product.title);
      }
    }
    return out;
  });

  const more = count > rows.length;
  const hasNarrow = Object.keys(narrow).length > 0;
  return {
    ...base,
    matched_rows: count > COUNT_CAP ? `more than ${COUNT_CAP}` : count,
    rows: outRows,
    ...(hasNarrow ? { narrow_by: narrow } : {}),
    ...(count === 0
      ? { note: "No rows match all these filters together. Tell the shopper plainly; suggest checking the details or dropping one." }
      : hasNarrow
        ? {
            note: `${more ? `Showing the first ${rows.length}. ` : ""}The matches differ on narrow_by. If the shopper hasn't said, ask for that detail (one short question) before recommending — don't guess or list everything.`,
          }
        : more
          ? { note: `Showing the first ${rows.length} of the matches.` }
          : {}),
    linkedProducts,
  };
}
