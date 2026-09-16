// Lookup tables (spec 28) — pure helpers shared by the upload modal (browser)
// and the importer (server): CSV reading, normalisation, number/range parsing
// and the column-role guess. No DB, no Node APIs.

export type ColumnRole = "filter" | "info" | "link_sku" | "link_handle" | "link_title" | "ignore";

export const COLUMN_ROLES: ColumnRole[] = ["filter", "info", "link_sku", "link_handle", "link_title", "ignore"];

export const LINK_ROLES: ColumnRole[] = ["link_sku", "link_handle", "link_title"];

export interface TableColumn {
  /** Stable cell key in lookup_rows ("c0", "c1", …). */
  key: string;
  /** Header as uploaded (deduplicated). */
  name: string;
  role: ColumnRole;
  /** ≥ 90% of non-empty cells are a number or a range "a-b". */
  numeric: boolean;
  /** Distinct non-empty values, capped at DISTINCT_CAP + 1. */
  distinct: number;
  /** Most frequent values, as uploaded. */
  samples: string[];
}

/** Two columns queried together as one numeric filter ("Year From" + "Year To"). */
export interface TableRange {
  name: string;
  from: string;
  to: string;
}

export const MAX_TABLE_COLUMNS = 60;
export const MAX_FILTER_COLUMNS = 8;
export const DISTINCT_CAP = 5000;
export const TABLE_DESCRIPTION_MAX = 300;
/** Compressed upload ceiling — under nginx's 25M request body limit. */
export const TABLE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** Decompressed file ceiling. */
export const TABLE_FILE_MAX_BYTES = 100 * 1024 * 1024;

export const ROLE_LABEL: Record<ColumnRole, string> = {
  filter: "Filter — shoppers ask by it",
  info: "Show in answers",
  link_sku: "Product link (SKU)",
  link_handle: "Product link (handle)",
  link_title: "Product link (title)",
  ignore: "Ignore",
};

/** Lowercase, no diacritics, single spaces. The form every match compares. */
export function normalizeCell(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Letters and digits only — "F-150" and "f150" compare equal. */
export function compactCell(value: string): string {
  return normalizeCell(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A number or a range "2012-2016" / "2012 – 2016" / "2012 to 2016" → [lo, hi]. */
export function parseNumberRange(value: string): [number, number] | null {
  const text = value.trim().replace(/,(?=\d{3}\b)/g, "");
  if (!text) return null;
  const single = /^[-+]?\d+(?:\.\d+)?$/.exec(text);
  if (single) {
    const n = Number(text);
    return [n, n];
  }
  const range = /^(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)$/i.exec(text);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return a <= b ? [a, b] : [b, a];
  }
  return null;
}

/** Comma, semicolon or tab — whichever splits the header line most (outside quotes). */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length && i < 20_000; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ",";
}

/**
 * Quote-aware CSV records, one at a time (a 100MB file never becomes one giant
 * array of arrays). Handles quoted delimiters/newlines and "" escapes; blank
 * lines are skipped; a leading BOM is dropped.
 */
export function* iterateCsv(text: string, delimiter = ","): Generator<string[]> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;
  const flush = function* () {
    record.push(cell);
    cell = "";
    if (record.some((c) => c.trim() !== "")) yield record;
    record = [];
  };
  for (; i < text.length; i++) {
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
    } else if (ch === delimiter) {
      record.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      yield* flush();
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || record.length > 0) yield* flush();
}

/** Header cells → unique non-empty names ("Column 3", "Model (2)"). */
export function uniqueHeaders(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, i) => {
    const base = raw.replace(/\s+/g, " ").trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

const RANGE_PATTERNS: Array<[RegExp, RegExp]> = [
  [/^(.+?)\s*(?:from|start|begin|min)$/i, /^(.+?)\s*(?:to|end|until|max)$/i],
  [/^(?:from|start|begin|min)\s*(.+)$/i, /^(?:to|end|until|max)\s*(.+)$/i],
];

/** "Year From"/"Year To", "Start Year"/"End Year", "Min Width"/"Max Width". */
export function detectRanges(columns: Array<{ key: string; name: string }>): TableRange[] {
  const ranges: TableRange[] = [];
  const used = new Set<string>();
  for (const [fromRe, toRe] of RANGE_PATTERNS) {
    for (const from of columns) {
      if (used.has(from.key)) continue;
      const base = fromRe.exec(from.name.replace(/[_-]+/g, " ").trim())?.[1]?.trim();
      if (!base) continue;
      const to = columns.find((c) => {
        if (c.key === from.key || used.has(c.key)) return false;
        const other = toRe.exec(c.name.replace(/[_-]+/g, " ").trim())?.[1]?.trim();
        return Boolean(other) && other!.toLowerCase() === base.toLowerCase();
      });
      if (!to) continue;
      used.add(from.key);
      used.add(to.key);
      ranges.push({ name: base.replace(/^\w/, (c) => c.toUpperCase()), from: from.key, to: to.key });
    }
  }
  return ranges;
}

/**
 * First-guess roles from the header and a sample of rows. The merchant sees
 * and can change every one, so this only has to be sensible: identifiers link
 * to products, short repeated values are filters, long text is shown.
 */
export function guessRoles(names: string[], sampleRows: string[][]): ColumnRole[] {
  let linked = false;
  let filters = 0;
  return names.map((name, i) => {
    const header = name.toLowerCase();
    const cells = sampleRows.map((r) => (r[i] ?? "").trim()).filter(Boolean);
    // Shopify's own identifiers only — no domain vocabulary, so the guess works
    // the same for any kind of table.
    if (!linked && /\bsku\b/.test(header)) {
      linked = true;
      return "link_sku";
    }
    if (!linked && /\bhandle\b/.test(header)) {
      linked = true;
      return "link_handle";
    }
    if (cells.length === 0) return "ignore";
    const avgLength = cells.reduce((sum, c) => sum + c.length, 0) / cells.length;
    const distinctRatio = new Set(cells.map(normalizeCell)).size / cells.length;
    const numericShare = cells.filter((c) => parseNumberRange(c)).length / cells.length;
    // Judged from the DATA, not from header vocabulary (the feature is generic):
    // filters are short values that repeat or are numbers; a sentence that
    // happens to repeat is shown, not filtered.
    const looksFilter =
      avgLength <= 24 && (distinctRatio <= 0.6 || numericShare >= 0.9) && !/note|description|comment|detail/.test(header);
    if (looksFilter && filters < MAX_FILTER_COLUMNS) {
      filters++;
      return "filter";
    }
    return "info";
  });
}

/** Browser + server check of a role mapping; returns an error message or null. */
export function mappingProblem(roles: ColumnRole[]): string | null {
  const filters = roles.filter((r) => r === "filter").length;
  if (filters === 0) return "Choose at least one Filter column — the AI finds rows by it.";
  if (filters > MAX_FILTER_COLUMNS) return `Choose at most ${MAX_FILTER_COLUMNS} Filter columns.`;
  if (roles.filter((r) => LINK_ROLES.includes(r)).length > 1) return "Choose only one Product link column.";
  return null;
}
