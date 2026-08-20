/** Only allow in-app relative paths as post-login destinations (no open redirects). */
export function safeNext(value: string | null | undefined, fallback = "/app/inbox"): string {
  if (!value) return fallback;
  if (!value.startsWith("/app") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}
