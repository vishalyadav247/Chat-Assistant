import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Outlet } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavigateBridge, SurfaceProvider } from "../lib/ui/surface";
// One stylesheet, and it is the console's own. Until 2026-09-03 this layout
// also pulled the merchant web app's shell and auth sheets so the two surfaces
// looked identical (user, 2026-08-20); the glass redesign replaced every class
// they provided, so loading them now would ship dead CSS to every page.
import adminStylesHref from "../components/admin/admin.css?url";
import { themeFromCookie } from "../components/admin/theme";

// Layout for the ADMIN surface (spec 19) — the company operating the
// app, not merchants. Never embedded, no App Bridge. Cross-tenant BY DESIGN.
// Auth is enforced per-route via requireAdminUser (this layout is chrome,
// not a security boundary).

// Read once here, for every /admin page: the shell needs the colour theme in
// the FIRST paint, and only the server can do that without a blocking script.
export const loader = ({ request }: LoaderFunctionArgs) => ({
  theme: themeFromCookie(request.headers.get("cookie")),
});

export const links: LinksFunction = () => [{ rel: "stylesheet", href: adminStylesHref }];

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
});

export default function AdminLayout() {
  return (
    <AppProvider embedded={false}>
      <SurfaceProvider surface="web">
        <NavigateBridge />
        <Outlet />
      </SurfaceProvider>
    </AppProvider>
  );
}
