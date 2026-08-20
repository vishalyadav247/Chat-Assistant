// Global date/time formatting (Settings → General → Store information).
// Isomorphic + deterministic: every admin/web surface formats through these
// helpers with the SHOP's preference and time zone, so server render and
// client render always agree (no locale/TZ hydration mismatches) and every
// merchant sees dates the way their region writes them.

export const DATE_FORMATS = [
  "MMM D, YYYY", // Aug 19, 2026   (US)
  "D MMM YYYY", // 19 Aug 2026    (UK / IN / AU)
  "MM/DD/YYYY", // 08/19/2026     (US numeric)
  "DD/MM/YYYY", // 19/08/2026     (UK / IN / EU)
  "DD.MM.YYYY", // 19.08.2026     (DE / RU / CH)
  "YYYY-MM-DD", // 2026-08-19     (ISO / JP / CN / SE)
  "YYYY年M月D日", // 2026年8月19日  (JP / CN / TW)
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const TIME_FORMATS = ["12h", "24h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export interface DateTimePrefs {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  /** IANA zone (Shop.timezone). Invalid zones fall back to UTC. */
  timeZone: string;
}

export const DEFAULT_DATE_FORMAT: DateFormat = "MMM D, YYYY";
export const DEFAULT_TIME_FORMAT: TimeFormat = "12h";
export const DEFAULT_DATETIME_PREFS: DateTimePrefs = {
  dateFormat: DEFAULT_DATE_FORMAT,
  timeFormat: DEFAULT_TIME_FORMAT,
  timeZone: "UTC",
};

export function isDateFormat(value: unknown): value is DateFormat {
  return typeof value === "string" && (DATE_FORMATS as readonly string[]).includes(value);
}
export function isTimeFormat(value: unknown): value is TimeFormat {
  return value === "12h" || value === "24h";
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
    } catch {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
    }
    partsCache.set(timeZone, fmt);
  }
  return fmt;
}

function toDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Calendar parts of an instant in the given zone. */
export function zonedParts(value: string | number | Date, timeZone: string): Parts | null {
  const d = toDate(value);
  if (!d) return null;
  const out: Partial<Parts> = {};
  for (const p of formatter(timeZone).formatToParts(d)) {
    if (p.type === "year") out.year = Number(p.value);
    else if (p.type === "month") out.month = Number(p.value);
    else if (p.type === "day") out.day = Number(p.value);
    else if (p.type === "hour") out.hour = Number(p.value) % 24;
    else if (p.type === "minute") out.minute = Number(p.value);
  }
  return out as Parts;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Date only, in the shop's format. `year: false` drops the year (chart axes, ranges). */
export function formatDate(value: string | number | Date, prefs: DateTimePrefs, opts: { year?: boolean } = {}): string {
  const p = zonedParts(value, prefs.timeZone);
  if (!p) return "—";
  const withYear = opts.year !== false;
  const mon = MONTHS_SHORT[p.month - 1];
  switch (prefs.dateFormat) {
    case "MMM D, YYYY":
      return withYear ? `${mon} ${p.day}, ${p.year}` : `${mon} ${p.day}`;
    case "D MMM YYYY":
      return withYear ? `${p.day} ${mon} ${p.year}` : `${p.day} ${mon}`;
    case "MM/DD/YYYY":
      return withYear ? `${pad2(p.month)}/${pad2(p.day)}/${p.year}` : `${pad2(p.month)}/${pad2(p.day)}`;
    case "DD/MM/YYYY":
      return withYear ? `${pad2(p.day)}/${pad2(p.month)}/${p.year}` : `${pad2(p.day)}/${pad2(p.month)}`;
    case "DD.MM.YYYY":
      return withYear ? `${pad2(p.day)}.${pad2(p.month)}.${p.year}` : `${pad2(p.day)}.${pad2(p.month)}`;
    case "YYYY-MM-DD":
      return withYear ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : `${pad2(p.month)}-${pad2(p.day)}`;
    case "YYYY年M月D日":
      return withYear ? `${p.year}年${p.month}月${p.day}日` : `${p.month}月${p.day}日`;
    default:
      return `${mon} ${p.day}, ${p.year}`;
  }
}

/** Time only ("2:44 PM" / "14:44"). */
export function formatTime(value: string | number | Date, prefs: DateTimePrefs): string {
  const p = zonedParts(value, prefs.timeZone);
  if (!p) return "—";
  if (prefs.timeFormat === "24h") return `${pad2(p.hour)}:${pad2(p.minute)}`;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad2(p.minute)} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** "Aug 19, 2026, 2:44 PM" — date + time in the shop's formats. */
export function formatDateTime(value: string | number | Date, prefs: DateTimePrefs): string {
  const date = formatDate(value, prefs);
  if (date === "—") return date;
  return `${date}, ${formatTime(value, prefs)}`;
}

/** Whole days between two instants by calendar date in the zone (0 = same day). */
function calendarDayDiff(later: string | number | Date, earlier: string | number | Date, timeZone: string): number | null {
  const a = zonedParts(later, timeZone);
  const b = zonedParts(earlier, timeZone);
  if (!a || !b) return null;
  const da = Date.UTC(a.year, a.month - 1, a.day);
  const db = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((da - db) / 86_400_000);
}

/** "Today" / "Yesterday" / formatted date (thread day dividers). */
export function formatDayLabel(value: string | number | Date, prefs: DateTimePrefs, now: Date = new Date()): string {
  const days = calendarDayDiff(now, value, prefs.timeZone);
  if (days === null) return "—";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return formatDate(value, prefs);
}

/** Compact relative time for lists: "Just now", "5m", "2h", "Yesterday", "3d", then a date. */
export function formatRelative(value: string | number | Date, prefs: DateTimePrefs, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return "—";
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 172_800_000) return "Yesterday";
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return formatDate(value, prefs);
}

/** Fixed sample instant for the settings examples (deterministic across SSR +
 *  client — a live "now" would differ by the minute and break hydration). */
export const SAMPLE_INSTANT = new Date("2026-03-05T14:08:00Z");

/** Options for the settings selectors, with an example. */
export function dateFormatOptions(now: Date = SAMPLE_INSTANT, timeZone = "UTC"): Array<{ value: DateFormat; label: string }> {
  return DATE_FORMATS.map((dateFormat) => ({
    value: dateFormat,
    label: `${formatDate(now, { dateFormat, timeFormat: "12h", timeZone })}  ·  ${dateFormat}`,
  }));
}
export function timeFormatOptions(now: Date = SAMPLE_INSTANT, timeZone = "UTC"): Array<{ value: TimeFormat; label: string }> {
  return TIME_FORMATS.map((timeFormat) => ({
    value: timeFormat,
    label: `${formatTime(now, { dateFormat: DEFAULT_DATE_FORMAT, timeFormat, timeZone })}  ·  ${timeFormat === "12h" ? "12-hour" : "24-hour"}`,
  }));
}
