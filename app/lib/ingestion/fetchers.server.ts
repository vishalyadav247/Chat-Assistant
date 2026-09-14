import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF-guarded HTTP fetching for knowledge ingestion (spec 04; single page since spec 22).
// Every fetch (including every redirect hop) is validated against private /
// reserved address space BEFORE the request is made. Note: this is a
// resolve-then-fetch check — the standard guard the spec asks for — not a
// pinned-socket defense against sub-second DNS rebinding.

export const CRAWL_USER_AGENT = "ChatConvertBot/1.0 (+https://chatconvert.app)";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB cap, body truncated beyond it
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

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

/**
 * Expand an IPv6 literal to its eight 16-bit groups (numbers). Handles `::`
 * compression and a trailing dotted IPv4 (`::ffff:1.2.3.4`). Returns null when
 * the literal cannot be parsed — callers treat that as unsafe.
 */
function expandIpv6(ip: string): number[] | null {
  let text = ip;
  // Trailing dotted IPv4 → two hex groups so the generic parser handles it.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[2].split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    text = `${dotted[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (segment: string): number[] | null => {
    if (segment === "") return [];
    const out: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function embeddedIpv4(groups: number[], offset: number): string {
  const hi = groups[offset];
  const lo = groups[offset + 1];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const groups = expandIpv6(ip);
  if (!groups) return true; // unparseable → unsafe
  const [g0, g1, g2, g3, g4, g5] = groups;
  const allZero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);

  // :: (unspecified) and ::1 (loopback).
  if (allZero(0, 7) && (groups[7] === 0 || groups[7] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d — WHATWG URL serializes it as hex
  // ([::ffff:7f00:1]); both forms land here → check the embedded IPv4.
  if (allZero(0, 5) && g5 === 0xffff) return isPrivateIpv4(embeddedIpv4(groups, 6));
  // IPv4-compatible ::a.b.c.d (deprecated) — embedded IPv4 decides.
  if (allZero(0, 6)) return isPrivateIpv4(embeddedIpv4(groups, 6));
  // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local-use NAT64 — reject outright.
  if (g0 === 0x64 && g1 === 0xff9b) return true;
  // 2002::/16 6to4 — embedded IPv4 (groups 1-2) decides.
  if (g0 === 0x2002) return isPrivateIpv4(embeddedIpv4(groups, 1));
  // Teredo 2001::/32 embeds the (obfuscated) server/client — reject.
  if (g0 === 0x2001 && g1 === 0) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) return true; // 100::/64 discard
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

// ── Single-page fetch ───────────────────────────────────────────────────────
//
// Website URL sources read exactly the page the merchant typed (spec 22, user
// decision). Link-following and sitemap crawling were removed with the linked
// and whole-site scopes: store pages and blog articles now come from the Pages
// and Blogs tabs, synced from the Admin API — none of a scraped page's header,
// nav and footer text, drafts visible, and no sitemap gaps (Shopify's sitemap
// has no policy type). robots.txt went with them: it was only ever consulted
// for DISCOVERED pages, and the URL a merchant enters was always fetched.

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

const CRAWLABLE_CONTENT = /^(text\/html|text\/plain|application\/xhtml)/i;

/** Fetch one page (SSRF-guarded) and strip it to text. Throws when unreadable. */
export async function fetchPageText(rawUrl: string): Promise<CrawledPage> {
  const result = await safeFetch(rawUrl);
  if (result.contentType && !CRAWLABLE_CONTENT.test(result.contentType)) {
    throw new SafeFetchError(`not a readable page (${result.contentType})`, result.url);
  }
  const { title, text } = htmlToText(result.text);
  if (!text) throw new SafeFetchError("page has no readable text", result.url);
  return { url: result.url, title: title || result.url, text };
}
