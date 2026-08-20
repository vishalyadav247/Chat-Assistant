/** CSRF guard for the public web auth forms (spec 18): when the browser sends
 *  an Origin/Referer, it must match the request host. Cookie-less forms can't
 *  rely on SameSite, and a login CSRF would sign the victim into the
 *  attacker's store. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return true; // older clients / privacy extensions — allow
  try {
    const expected = new URL(request.url);
    const actual = new URL(origin);
    const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const expectedHost = forwardedHost ?? expected.host;
    return actual.host === expectedHost;
  } catch {
    return false;
  }
}
