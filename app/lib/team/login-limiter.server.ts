// In-memory attempt limiter for the web login / forgot-password forms
// (spec 18). Per-account lockout lives in TeamMember.failedLogins; this is the
// cheap first line against credential stuffing from one client. Single-node
// dev/prod is fine; behind several nodes it degrades to per-node limits.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function clientKey(request: Request, extra = ""): string {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "local";
  return `${ip}:${extra.toLowerCase()}`;
}

/** Returns true when the attempt is allowed. */
export function allowAttempt(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return true;
  }
  bucket.count += 1;
  return bucket.count <= MAX_ATTEMPTS;
}

export function clearAttempts(key: string): void {
  buckets.delete(key);
}
