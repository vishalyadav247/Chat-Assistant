import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF-guarded HTTP fetching + crawling for knowledge ingestion (spec 04).
// Every fetch (including every redirect hop) is validated against private /
// reserved address space BEFORE the request is made. Note: this is a
// resolve-then-fetch check — the standard guard the spec asks for — not a
// pinned-socket defense against sub-second DNS rebinding.

export const CRAWL_USER_AGENT = "ChatConvertBot/1.0 (+https://chatconvert.app)";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB cap, body truncated beyond it
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
/** Absolute safety ceiling on any crawl regardless of plan quota. */
export const HARD_CRAWL_PAGE_CAP = 50;

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly targetUrl?: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

// ── Address / hostname validation ───────────────────────────────────────────

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts;
  return (
    a === 0 || // "this network"
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    a >= 224 // multicast + reserved
  );
}

function isPrivateIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (ip === "::" || ip === "::1") return true; // unspecified / loopback
  // IPv4-mapped (::ffff:a.b.c.d) → check the embedded IPv4.
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return isPrivateIpv4(v4[1]);
  const firstGroup = ip.split(":")[0];
  if (firstGroup.startsWith("fc") || firstGroup.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(firstGroup)) return true; // fe80::/10 link-local
  return false;
}

/** True when the IP literal (v4 or v6) is private/reserved/loopback. */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip.replace(/^\[|\]$/g, ""));
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // not an IP literal
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  );
}

/** Throws SafeFetchError unless the URL points at a public http(s) host. */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(`blocked protocol "${url.protocol}"`, url.toString());
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    throw new SafeFetchError(`blocked hostname "${host}"`, url.toString());
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new SafeFetchError(`blocked private/reserved address "${host}"`, url.toString());
    }
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SafeFetchError(`DNS lookup failed for "${host}"`, url.toString());
  }
  if (addresses.length === 0) {
    throw new SafeFetchError(`DNS lookup returned no addresses for "${host}"`, url.toString());
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new SafeFetchError(
        `"${host}" resolves to private/reserved address ${address}`,
        url.toString(),
      );
    }
  }
}

// ── safeFetch ───────────────────────────────────────────────────────────────

export interface SafeFetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  /** Body text, truncated at the 2MB cap. */
  text: string;
}

/**
 * SSRF-guarded GET: http(s) only, private/reserved targets rejected (per hop),
 * manual redirect handling (max 3), 5s timeout, 2MB body cap.
 */
export async function safeFetch(rawUrl: string): Promise<SafeFetchResult> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new SafeFetchError(`invalid URL "${rawUrl}"`);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": CRAWL_USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          },
        });
      } catch (error) {
        const reason = controller.signal.aborted ? `timeout after ${FETCH_TIMEOUT_MS}ms` : String(error);
        throw new SafeFetchError(`fetch failed: ${reason}`, current.toString());
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) {
          throw new SafeFetchError(`redirect (${response.status}) without Location`, current.toString());
        }
        try {
          current = new URL(location, current);
        } catch {
          throw new SafeFetchError(`invalid redirect target "${location}"`, current.toString());
        }
        continue; // re-validated at the top of the loop
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new SafeFetchError(`HTTP ${response.status}`, current.toString());
      }
      const text = await readBodyCapped(response);
      return {
        url: current.toString(),
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        text,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SafeFetchError(`too many redirects (max ${MAX_REDIRECTS})`, current.toString());
}

async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_RESPONSE_BYTES - total;
    if (value.byteLength >= remaining) {
      chunks.push(value.slice(0, remaining));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ── HTML → text ─────────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export interface HtmlText {
  title: string;
  /** Plain text with paragraph structure preserved as newlines (chunker-friendly). */
  text: string;
}

/** Strip HTML to plain text; extracts <title> when present. */
export function htmlToText(html: string): HtmlText {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre|figure|nav|main|aside|form)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/** Same-origin page links from an HTML document (fragments stripped, deduped). */
export function extractLinks(html: string, baseUrl: URL): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const NON_PAGE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|pdf|zip|gz|tar|mp4|mp3|webm|woff2?|ttf|eot)$/i;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = (match[1] ?? match[2] ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (resolved.origin !== baseUrl.origin) continue;
    if (NON_PAGE.test(resolved.pathname)) continue;
    resolved.hash = "";
    const key = resolved.toString();
    if (key === baseUrl.toString() || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ── robots.txt ──────────────────────────────────────────────────────────────

/**
 * Disallow prefixes that apply to our UA. Groups naming "chatconvertbot" win
 * over the "*" wildcard group; simple prefix matching per spec.
 */
export function parseRobots(robotsTxt: string, botToken = "chatconvertbot"): string[] {
  interface Group {
    agents: string[];
    disallow: string[];
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (field === "disallow" && current && value) {
        current.disallow.push(value);
      }
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && botToken.includes(a)));
  const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return applicable.flatMap((g) => g.disallow);
}

export function isAllowedByRobots(pathname: string, disallowPrefixes: string[]): boolean {
  return !disallowPrefixes.some((prefix) => pathname.startsWith(prefix));
}

// ── Crawl ───────────────────────────────────────────────────────────────────

export type CrawlScope = "page" | "linked" | "sitemap";

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

const CRAWLABLE_CONTENT = /^(text\/html|text\/plain|application\/xhtml)/i;
const MAX_NESTED_SITEMAPS = 5;

/**
 * Crawl per scope, capped at maxPages (never above HARD_CRAWL_PAGE_CAP).
 * robots.txt Disallow (for our UA) is honored on discovered pages; the URL the
 * merchant explicitly entered is always fetched. Unfetchable discovered pages
 * are skipped; zero fetchable pages → throws.
 */
export async function crawl(
  startUrl: string,
  scope: CrawlScope,
  maxPages: number,
): Promise<CrawledPage[]> {
  let start: URL;
  try {
    start = new URL(startUrl);
  } catch {
    throw new SafeFetchError(`invalid URL "${startUrl}"`);
  }
  const cap = Math.max(1, Math.min(maxPages, HARD_CRAWL_PAGE_CAP));
  const disallow = await fetchRobots(start.origin);

  const pages: CrawledPage[] = [];
  const fetchPage = async (url: string): Promise<string | null> => {
    const result = await safeFetch(url);
    if (result.contentType && !CRAWLABLE_CONTENT.test(result.contentType)) return null;
    const { title, text } = htmlToText(result.text);
    if (!text) return null;
    pages.push({ url: result.url, title: title || result.url, text });
    return result.text;
  };

  if (scope === "page") {
    await fetchPage(start.toString());
  } else if (scope === "linked") {
    const rawHtml = await fetchPage(start.toString());
    const links = rawHtml ? extractLinks(rawHtml, start) : [];
    for (const link of links) {
      if (pages.length >= cap) break;
      if (!isAllowedByRobots(new URL(link).pathname, disallow)) continue;
      try {
        await fetchPage(link);
      } catch {
        continue; // skip unfetchable linked pages
      }
    }
  } else {
    const locs = await collectSitemapUrls(start, cap);
    for (const loc of locs) {
      if (pages.length >= cap) break;
      if (!isAllowedByRobots(new URL(loc).pathname, disallow)) continue;
      try {
        await fetchPage(loc);
      } catch {
        continue;
      }
    }
  }

  if (pages.length === 0) {
    throw new SafeFetchError("crawl produced no readable pages", start.toString());
  }
  return pages;
}

async function fetchRobots(origin: string): Promise<string[]> {
  try {
    const robots = await safeFetch(`${origin}/robots.txt`);
    return parseRobots(robots.text);
  } catch {
    return []; // absent/unreadable robots.txt → no restrictions
  }
}

/** <loc> entries from /sitemap.xml (or the given .xml URL); follows one level of sitemap index. */
async function collectSitemapUrls(start: URL, cap: number): Promise<string[]> {
  const sitemapUrl = start.pathname.toLowerCase().endsWith(".xml")
    ? start.toString()
    : `${start.origin}/sitemap.xml`;
  const root = await safeFetch(sitemapUrl);
  let locs = extractLocs(root.text);

  // Sitemap index: entries that are themselves .xml sitemaps — expand a few.
  const nested = locs.filter((loc) => loc.toLowerCase().endsWith(".xml"));
  if (nested.length > 0 && nested.length === locs.length) {
    locs = [];
    for (const sub of nested.slice(0, MAX_NESTED_SITEMAPS)) {
      if (locs.length >= cap) break;
      try {
        const subMap = await safeFetch(sub);
        locs.push(...extractLocs(subMap.text).filter((l) => !l.toLowerCase().endsWith(".xml")));
      } catch {
        continue;
      }
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const loc of locs) {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    if (url.origin !== start.origin) continue; // stay on the merchant's site
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= cap) break;
  }
  return out;
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const value = decodeEntities(match[1]).trim();
    if (value) out.push(value);
  }
  return out;
}
