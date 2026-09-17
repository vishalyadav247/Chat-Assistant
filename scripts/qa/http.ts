/* Shared HTTP plumbing for the QA suites that hit the dev server (QA-T4).
 *
 * The HTTP suites (routing, ui-embedded, ui-web, storefront) failed first pass
 * under dev-server load with `fetch failed` / `UND_ERR_HEADERS_TIMEOUT`, and
 * passed clean on an isolated re-run — the server was busy (Vite compiling a
 * route on first hit, the pg-boss worker running a sync), not broken. Two
 * things make a run believable again:
 *
 *   waitForServer — the reachability gate retries with backoff (1→16 s, 6 tries)
 *                   instead of declaring the server down on one slow cold start;
 *   qaFetch       — every request has a timeout (30 s default) and ONE retry on
 *                   a connection-level failure. Non-idempotent requests are only
 *                   retried when the connection was refused outright (the
 *                   request never reached the app), so a POST is never applied
 *                   twice.
 *
 * Still run HTTP suites ONE AT A TIME against a quiet server (TEST-CASES.md):
 * retries hide cold starts, not a server shared with another suite.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export type QaFetchInit = RequestInit & { timeoutMs?: number };

function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return `${cause?.code ?? ""} ${String((error as Error)?.message ?? error)}`;
}

/** The request never reached the server — safe to resend whatever the method. */
function neverSent(error: unknown): boolean {
  return /ECONNREFUSED/.test(errorCode(error));
}

/** Connection-level failure (not an HTTP status) that a busy server produces. */
function transient(error: unknown): boolean {
  return /fetch failed|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|other side closed/i.test(
    errorCode(error),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with a per-request timeout and one retry on a transient connection
 * failure. A caller-supplied `signal` (SSE readers with their own budget) wins
 * over `timeoutMs`. Bodies must be re-sendable (string / URLSearchParams /
 * FormData) — every QA suite already sends those.
 */
export async function qaFetch(url: string, init: QaFetchInit = {}): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const attempt = () =>
    fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  try {
    return await attempt();
  } catch (error) {
    const retryable = idempotent ? transient(error) : neverSent(error);
    if (!retryable || rest.signal?.aborted) throw error;
    await sleep(1_000);
    return attempt();
  }
}

/**
 * Wait for the dev server with backoff. `ready` decides what "up" means for the
 * suite (default: any 2xx). Resolves `{ ok: false, error }` after the last try
 * — callers record that as a FAILED check, never a silent skip.
 */
export async function waitForServer(
  url: string,
  opts: { ready?: (res: Response) => boolean; headers?: Record<string, string>; tries?: number } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tries = opts.tries ?? BACKOFF_MS.length + 1;
  let lastError = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: opts.headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
      await res.text().catch(() => "");
      if (opts.ready ? opts.ready(res) : res.ok) return { ok: true };
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = errorCode(error).trim();
    }
    if (i < tries - 1) {
      const wait = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
      console.log(`  …   ${url} not ready (${lastError}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  return { ok: false, error: lastError };
}
