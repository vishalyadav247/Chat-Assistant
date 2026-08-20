import type { HeadersFunction, LinksFunction } from "react-router";
import { Outlet } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavigateBridge, SurfaceProvider } from "../lib/ui/surface";
import webAuthStylesHref from "../components/web/web-auth.css?url";

// Layout for the standalone web surface's public pages (spec 18): login,
// invite acceptance, password reset, handoff. Never embedded, no App Bridge.

export const links: LinksFunction = () => [{ rel: "stylesheet", href: webAuthStylesHref }];

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
});

export default function WebLayout() {
  return (
    <AppProvider embedded={false}>
      <SurfaceProvider surface="web">
        <NavigateBridge />
        <Outlet />
      </SurfaceProvider>
    </AppProvider>
  );
}
