// Store time zone picker data (Settings → General → Date & time settings).
//
// The raw `Intl.supportedValuesOf("timeZone")` list is ~450 bare IANA ids in
// alphabetical order — unreadable when a merchant is hunting for their own
// zone. This module turns it into offset-sorted, offset-labelled options
// ("(UTC+05:30) Asia/Kolkata · India Standard Time").
//
// The list is built ON THE SERVER and passed through the loader on purpose:
// an offset depends on today's DST state, so computing it independently in
// the SSR pass and again on hydration risks a mismatch — the failure mode
// this app has already been bitten by (decisions log 2026-08-19).

export interface TimezoneOption {
  value: string;
  label: string;
}

/** Used where `Intl.supportedValuesOf` is missing (very old runtimes). */
const FALLBACK_ZONES = [
  "UTC",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Atlantic/Reykjavik",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Zurich",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Helsinki",
  "Europe/Bucharest",
  "Europe/Istanbul",
  "Europe/Kyiv",
  "Europe/Moscow",
  "Africa/Casablanca",
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Nairobi",
  "Asia/Jerusalem",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Hong_Kong",
  "Asia/Manila",
  "Asia/Shanghai",
  "Asia/Taipei",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Brisbane",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// ECMA-402 canonicalises to the IANA *backward-compatibility* links, so
// `Intl.supportedValuesOf` still hands back names IANA renamed years ago
// (verified on this runtime: Asia/Calcutta, Europe/Kiev, Asia/Saigon and 10
// more are present while none of their modern spellings are). Merchants
// recognise the current city names, so the list is renamed before display.
// Both spellings resolve to the same zone in Intl, so storing the modern id
// is safe for shops that already saved a legacy one.
const RENAMED: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "Africa/Timbuktu": "Africa/Bamako",
  "America/Argentina/ComodRivadavia": "America/Argentina/Catamarca",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "Asia/Ashkhabad": "Asia/Ashgabat",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Macao": "Asia/Macau",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes east of UTC for `timeZone` right now (negative = west). */
export function offsetMinutes(timeZone: string, at: Date): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    // "GMT+05:30" | "GMT-08:00" | plain "GMT" for UTC itself.
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? "");
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return 0;
  }
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/** "India Standard Time" — omitted when the runtime just echoes the offset. */
function longName(timeZone: string, at: Date): string | null {
  try {
    const value = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!value || /^GMT/.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

// Offsets move with DST, so the list is memoised per UTC day rather than for
// the process lifetime.
let cache: { day: string; options: TimezoneOption[] } | null = null;

/** Every IANA zone the runtime knows, offset-sorted and labelled for a select. */
export function timezoneOptions(now: Date = new Date()): TimezoneOption[] {
  const day = now.toISOString().slice(0, 10);
  if (cache && cache.day === day) return cache.options;

  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : FALLBACK_ZONES;
  // Some runtimes omit plain "UTC" from supportedValuesOf; merchants look for it.
  const all = zones.includes("UTC") ? zones : ["UTC", ...zones];

  const seen = new Set<string>();
  const options = all
    .map((raw) => {
      // Offset/name are read with the id the runtime gave us; only the id
      // the merchant sees and saves is modernised.
      const offset = offsetMinutes(raw, now);
      const name = longName(raw, now);
      const value = RENAMED[raw] ?? raw;
      const city = value.replace(/_/g, " ");
      return {
        value,
        offset,
        label: `(${formatOffset(offset)}) ${city}${name ? ` \u00b7 ${name}` : ""}`,
      };
    })
    .filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)))
    .sort((a, b) => a.offset - b.offset || a.value.localeCompare(b.value))
    .map(({ value, label }) => ({ value, label }));

  cache = { day, options };
  return options;
}

/** Modern spelling of a zone id, so a shop that saved "Asia/Calcutta" years
 *  ago matches the "Asia/Kolkata" option instead of getting a second row. */
export function canonicalTimezone(timeZone: string): string {
  return RENAMED[timeZone] ?? timeZone;
}

/** Keeps an unrecognised saved zone selectable rather than silently switching
 *  the shop to whatever sorts first. */
export function withSelected(options: TimezoneOption[], selected: string): TimezoneOption[] {
  const value = canonicalTimezone(selected);
  if (!value || options.some((o) => o.value === value)) return options;
  return [{ value, label: value.replace(/_/g, " ") }, ...options];
}
