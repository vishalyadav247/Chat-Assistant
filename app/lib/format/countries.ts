// ISO-3166-1 alpha-2 country list for the proactive-chat "Selected countries"
// condition (spec 12). Codes only — display names come from ECMA-402
// `Intl.DisplayNames`, so the list stays a few hundred bytes and localizes
// itself instead of shipping a hand-maintained name table that drifts.

const CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO " +
  "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE " +
  "JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO " +
  "MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW " +
  "PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM " +
  "TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

export interface CountryOption {
  code: string;
  name: string;
}

let cached: CountryOption[] | null = null;

/** All countries, sorted by localized display name. Memoised — the list is
 *  identical for every render and `Intl.DisplayNames` isn't free. */
export function countryOptions(): CountryOption[] {
  if (cached) return cached;
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    display = null;
  }
  const list = CODES.split(" ").map((code) => ({
    code,
    name: (display?.of(code) ?? code) || code,
  }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  cached = list;
  return list;
}

export function countryName(code: string): string {
  const upper = code.toUpperCase();
  return countryOptions().find((c) => c.code === upper)?.name ?? upper;
}

/** Normalize merchant/stored input to uppercase alpha-2, dropping unknowns. */
export function normalizeCountries(codes: string[]): string[] {
  const known = new Set(countryOptions().map((c) => c.code));
  return [...new Set(codes.map((c) => c.trim().toUpperCase()))].filter((c) => known.has(c));
}
