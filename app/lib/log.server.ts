import db from "../db.server";

// Operator error/warning log (spec 21). Every server-side failure funnels
// through here and surfaces cross-tenant at /platform/logs.
//
// Two hard rules, copied from llm/usage.server.ts for the same reason — this
// sits in the shopper chat hot path:
//   1. NEVER throws — a logging failure must not break a reply.
//   2. NEVER awaited by the caller — writes are fire-and-forget.
//
// Every call ALSO mirrors to console. That mirror is not redundant: it is what
// keeps diagnostics working when Postgres itself is the broken thing, and it
// keeps the host's own log viewer useful.
//
// LEVELS: error and warn only. There is deliberately no info/debug — a row per
// request would turn this table into a cost centre. See spec 21 "Volume
// ceiling" before adding one.

export type LogLevel = "error" | "warn";

export interface LogContext {
  /** Owning shop; omit for system-wide failures (scheduler, boot, cron). */
  shopId?: string | null;
  /**
   * Owning shop by `*.myshopify.com` domain. Most webhook and sync code only
   * has the domain at hand, so the seam resolves it to a shopId at write time
   * (cached) rather than making every call site do a lookup just to log.
   */
  shopDomain?: string | null;
  [key: string]: unknown;
}

const MESSAGE_MAX = 1000;
const STRING_MAX = 500;
const CONTEXT_BYTES_MAX = 2048;
const STACK_LINES = 4;

/**
 * Rate cap: rows per event code per hour, PER PROCESS (spec 21 rule 2).
 *
 * KNOWN LIMITATION (verified 2026-08-21): the window lives in this module's
 * memory, so an N-instance deployment writes up to 50·N rows/hour/event — a
 * fleet-wide retry storm against a down OpenAI on 4 instances costs ~200
 * rows/hour, not 50. That is still ~3 orders of magnitude below "a row per
 * request" and keeps the seam dependency-free (a shared counter would need
 * Redis or a DB round-trip in the chat hot path, which rule 1 forbids).
 * Revisit only if the instance count grows past single digits.
 */
const RATE_LIMIT = 50;
const RATE_WINDOW_MS = 60 * 60 * 1000;
/**
 * Ceiling on distinct event codes tracked at once. Every call site today
 * passes a string literal from a fixed vocabulary, so this never trips — it
 * exists so a future dynamic event name (`user_${id}_failed`) degrades into a
 * weaker rate cap instead of an unbounded map in a long-lived process.
 */
const RATE_STATE_MAX = 500;

// Context keys that may carry shopper PII or credentials. Logging any of these
// would pull app_logs into GDPR redact scope (spec 17) — the point of the
// denylist is that it cannot happen by accident at a call site.
const DENIED_KEY =
  /^(messages?|text|body|content|reply|answer|question|prompt|input|email|phone|firstname|lastname|name|customer|address|token|accesstoken|password|secret|apikey|api_key|authorization|cookie|sessionid)$/i;

interface RateEntry {
  windowStart: number;
  count: number;
  capped: boolean;
}
const rateState = new Map<string, RateEntry>();

/**
 * Decide whether this event may write a row. Returns "write" normally,
 * "cap-notice" exactly once per window when the limit is first crossed, and
 * "drop" for the rest of the window.
 */
function rateCheck(event: string, now: number): "write" | "cap-notice" | "drop" {
  const entry = rateState.get(event);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    if (!entry && rateState.size >= RATE_STATE_MAX) rateState.clear();
    rateState.set(event, { windowStart: now, count: 1, capped: false });
    return "write";
  }
  entry.count += 1;
  if (entry.count <= RATE_LIMIT) return "write";
  if (!entry.capped) {
    entry.capped = true;
    return "cap-notice";
  }
  return "drop";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Human-readable one-liner for the `message` column. */
function describe(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (detail instanceof Error) return truncate(`${detail.name}: ${detail.message}`, MESSAGE_MAX);
  if (typeof detail === "string") return truncate(detail, MESSAGE_MAX);
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  try {
    return truncate(JSON.stringify(detail) ?? "", MESSAGE_MAX);
  } catch {
    return truncate(String(detail), MESSAGE_MAX);
  }
}

/** First few stack frames — enough to locate the throw, short enough to store. */
function shortStack(error: Error): string | undefined {
  if (!error.stack) return undefined;
  const lines = error.stack.split("\n").slice(1, 1 + STACK_LINES);
  const joined = lines.map((line) => line.trim()).join(" | ");
  return joined ? truncate(joined, STRING_MAX) : undefined;
}

/**
 * Strip PII/credentials and bound the size. Applied to caller context AND to
 * any object detail, so a call site cannot leak by passing the wrong bag.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(value, STRING_MAX);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 3) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = DENIED_KEY.test(key) ? "[redacted]" : sanitize(raw, depth + 1);
    }
    return out;
  }
  return String(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Sanitised context, or undefined when there is nothing worth storing. */
function buildContext(
  detail: unknown,
  context: LogContext | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};

  if (context) {
    for (const [key, raw] of Object.entries(context)) {
      if (key === "shopId") continue; // promoted to its own column
      out[key] = DENIED_KEY.test(key) ? "[redacted]" : sanitize(raw, 1);
    }
  }

  if (detail instanceof Error) {
    const stack = shortStack(detail);
    if (stack) out.stack = stack;
    // Node/undici attach `cause` and `code`; both are diagnostic gold.
    const code = (detail as { code?: unknown }).code;
    if (code !== undefined) out.code = sanitize(code, 1);
    const cause = (detail as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = describe(cause);
  } else if (detail !== null && detail !== undefined && typeof detail === "object") {
    Object.assign(out, sanitize(detail, 1) as Record<string, unknown>);
  }

  if (Object.keys(out).length === 0) return undefined;

  // Hard size ceiling — drop keys (largest first) until it fits.
  if (safeStringify(out).length <= CONTEXT_BYTES_MAX) return out;
  const byCost = Object.keys(out).sort(
    (a, b) => safeStringify(out[b]).length - safeStringify(out[a]).length,
  );
  for (const key of byCost) {
    delete out[key];
    out.truncated = true;
    if (safeStringify(out).length <= CONTEXT_BYTES_MAX) break;
  }
  return out;
}

// Domain → shopId, so call sites that only hold a domain still get attributed.
// Bounded and short-lived: an uninstall/reinstall must not keep resolving to a
// stale id, and an unbounded map in a long-lived process is a leak.
const domainCache = new Map<string, { shopId: string | null; at: number }>();
const DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000;
const DOMAIN_CACHE_MAX = 500;

/** A plain object detail bag (not an Error) — the only kind worth mining. */
function detailBag(detail: unknown): Record<string, unknown> | null {
  return detail !== null && typeof detail === "object" && !(detail instanceof Error)
    ? (detail as Record<string, unknown>)
    : null;
}

async function resolveShopId(
  context: LogContext | undefined,
  detail: unknown,
): Promise<string | null> {
  // Call sites vary in which bag they put the shop in. Attribution is a spec
  // 21 acceptance criterion, so accept either rather than silently writing a
  // system-wide row (which is how `data_request_reminder` lost its shop).
  const bag = detailBag(detail);
  const shopId = context?.shopId || (typeof bag?.shopId === "string" ? bag.shopId : null);
  if (shopId) return shopId;
  const bagDomain = typeof bag?.shopDomain === "string" ? bag.shopDomain : null;
  const domain = context?.shopDomain || bagDomain;
  if (!domain) return null;

  const hit = domainCache.get(domain);
  if (hit && Date.now() - hit.at < DOMAIN_CACHE_TTL_MS) return hit.shopId;

  const shop = await db.shop
    .findUnique({ where: { domain }, select: { id: true } })
    .catch(() => null);
  if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.clear();
  domainCache.set(domain, { shopId: shop?.id ?? null, at: Date.now() });
  return shop?.id ?? null;
}

async function write(
  level: LogLevel,
  event: string,
  detail: unknown,
  context: LogContext | undefined,
): Promise<void> {
  const decision = rateCheck(event, Date.now());
  if (decision === "drop") return;

  const shopId = await resolveShopId(context, detail);

  if (decision === "cap-notice") {
    await db.appLog.create({
      data: {
        level: "warn",
        event: "log_rate_capped",
        shopId,
        message: `Suppressing further "${event}" rows for the rest of the hour (cap ${RATE_LIMIT}/h).`,
        context: { suppressedEvent: event, cap: RATE_LIMIT },
      },
    });
    return;
  }

  // The MESSAGE column gets the same denylist as the context column. Without
  // this, `logError("x", { email })` redacted the email in `context` and then
  // stored it verbatim in `message` — spec 21 rule 4 is about the row, not
  // about one column of it. Errors and strings pass through untouched (their
  // text is the diagnostic).
  const bag = detailBag(detail);
  const safeDetail = bag ? sanitize(bag, 1) : detail;

  await db.appLog.create({
    data: {
      level,
      event: truncate(event, 120),
      shopId,
      message: describe(safeDetail) || event,
      context: (buildContext(detail, context) ?? undefined) as never,
    },
  });
}

function emit(level: LogLevel, event: string, detail: unknown, context: LogContext | undefined): void {
  // Mirror first — the console line must survive a DB outage.
  const mirror = level === "error" ? console.error : console.warn;
  if (detail === undefined) mirror(event, context ?? "");
  else mirror(event, detail, context ?? "");

  void write(level, event, detail, context).catch((error) => {
    // Never recurse into the seam; the mirror above already carries the event.
    console.error("app_log_write_failed", error);
  });
}

/** Record a failure. Fire-and-forget — returns immediately. */
export function logError(event: string, detail?: unknown, context?: LogContext): void {
  emit("error", event, detail, context);
}

/** Record a recoverable/degraded condition. Fire-and-forget. */
export function logWarn(event: string, detail?: unknown, context?: LogContext): void {
  emit("warn", event, detail, context);
}

/** Awaitable variant for scripts and tests that need the row to exist. */
export async function logSync(
  level: LogLevel,
  event: string,
  detail?: unknown,
  context?: LogContext,
): Promise<void> {
  await write(level, event, detail, context);
}

/** Test hook — clears the per-process rate-cap window. */
export function resetLogRateLimit(): void {
  rateState.clear();
}
