import type { HeadersFunction, LinksFunction } from "react-router";
import { Outlet } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavigateBridge, SurfaceProvider } from "../lib/ui/surface";
import webAuthStylesHref from "../components/web/web-auth.css?url";
// Same chrome stylesheet as the standalone web app — the operator console is a
// sibling surface, not a third design (user, 2026-08-20).
import webShellStylesHref from "../components/web/web-shell.css?url";
import platformStylesHref from "../components/platform/platform.css?url";

// Layout for the PLATFORM ADMIN surface (spec 19) — the company operating the
// app, not merchants. Never embedded, no App Bridge. Cross-tenant BY DESIGN.
// Auth is enforced per-route via requirePlatformAdmin (this layout is chrome,
// not a security boundary).

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: webAuthStylesHref },
  { rel: "stylesheet", href: webShellStylesHref },
  { rel: "stylesheet", href: platformStylesHref },
];

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
});

export default function PlatformLayout() {
  return (
    <AppProvider embedded={false}>
      <SurfaceProvider surface="web">
        <NavigateBridge />
        <Outlet />
      </SurfaceProvider>
    </AppProvider>
  );
}
