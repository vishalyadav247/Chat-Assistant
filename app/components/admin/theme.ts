import type { ThemePref } from "./AdminUi";

// Colour-theme preference for /admin. Client-safe (the layout loader and the
// shell both import it), so no server-only code here.
//
// Path=/ rather than /admin for the same reason as the session cookie: React
// Router fetches "/admin.data" on client navigation, and a /admin-scoped cookie
// does not match that under RFC 6265 path rules (next char is "." not "/") — the
// layout loader would then read no cookie and the theme would snap back on
// every navigation. Merchant routes simply ignore it.
export const THEME_COOKIE = "cc_admin_theme";

export function isThemePref(value: unknown): value is ThemePref {
  return value === "light" || value === "dark" || value === "system";
}

/** Parse the preference out of a Cookie header. Defaults to following the OS. */
export function themeFromCookie(header: string | null): ThemePref {
  const raw = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${THEME_COOKIE}=`))
    ?.slice(THEME_COOKIE.length + 1);
  return isThemePref(raw) ? raw : "system";
}
