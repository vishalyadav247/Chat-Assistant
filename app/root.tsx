import { useEffect } from "react";
import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import { installIosInputZoomFix } from "./lib/ui/ios-input-zoom";

// `Layout` wraps BOTH the app and the ErrorBoundary below, so the document
// head (viewport, manifest, fonts) is defined once and a crash still renders a
// real ChatConvert page instead of React Router's bare fallback.
export function Layout({ children }: { children: ReactNode }) {
  // Touch devices only: lift Polaris' shadow-DOM inputs to 16px so iOS Safari
  // stops zooming the page on focus (spec 20). No-op with a mouse pointer.
  useEffect(() => installIosInputZoomFix(), []);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* interactive-widget: the on-screen keyboard shrinks the LAYOUT viewport
            instead of scrolling the visual one, which is what keeps the inbox
            workspace filling the screen while an agent types (spec 20). */}
        <meta
          name="viewport"
          content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"
        />
        {/* Installable web app (spec 18/20): agents work from their phones, and
            iOS only grants Web Push to a site added to the Home Screen. */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="ChatConvert" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="theme-color" content="#6d3bf5" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Last-resort boundary for every surface. /app/* routes have their own
// (app/lib/ui/route-error.tsx → boundary.error) so embedded auth retries keep
// working; /web/* and /platform/* previously fell through to React Router's
// raw stack-trace screen, which support agents and operators could see.
//
// SECURITY: nothing from the thrown error is rendered in production — no
// message, no stack. Only a route response's status/statusText (which we
// author) is shown. Details render in dev only.
export function ErrorBoundary() {
  const error = useRouteError();
  const routeError = isRouteErrorResponse(error) ? error : null;
  const notFound = routeError?.status === 404;
  const status = routeError?.status ?? 500;

  const heading = notFound
    ? "Page not found"
    : routeError
      ? routeError.statusText || "Something went wrong"
      : "Something went wrong";
  const body = notFound
    ? "The page you're looking for doesn't exist, or it moved."
    : "We hit an unexpected error. Nothing you were working on was lost — try again in a moment.";

  const dev = import.meta.env.DEV;
  const detail = dev
    ? error instanceof Error
      ? (error.stack ?? error.message)
      : routeError
        ? typeof routeError.data === "string"
          ? routeError.data
          : JSON.stringify(routeError.data, null, 2)
        : String(error)
    : null;

  return (
    <main
      style={{
        minHeight: "100dvh",
        margin: 0,
        display: "grid",
        placeItems: "center",
        padding: 24,
        boxSizing: "border-box",
        background: "#f6f6f7",
        color: "#1a1a1e",
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div style={{ width: "100%", maxWidth: 460, textAlign: "center" }}>
        <div
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            margin: "0 auto 18px",
            borderRadius: 13,
            background: "linear-gradient(135deg, #6d3bf5, #3b82f6)",
            display: "grid",
            placeItems: "center",
            color: "#fff",
            fontWeight: 800,
            fontSize: 19,
            letterSpacing: "-0.02em",
          }}
        >
          C
        </div>
        <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, color: "#6f6a7d" }}>
          ChatConvert · {status}
        </p>
        <h1 style={{ margin: "0 0 10px", fontSize: 22, fontWeight: 700 }}>{heading}</h1>
        <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: 1.5, color: "#4a4a53" }}>{body}</p>
        {/* Full document reload, not a client nav: the router state that crashed
            is what we want to throw away. */}
        <a
          href="/"
          style={{
            display: "inline-block",
            padding: "9px 18px",
            borderRadius: 9,
            background: "#6d3bf5",
            color: "#fff",
            fontSize: 13.5,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Go to ChatConvert
        </a>
        {detail ? (
          <pre
            style={{
              marginTop: 24,
              padding: 12,
              textAlign: "left",
              overflowX: "auto",
              borderRadius: 10,
              background: "#ffffff",
              border: "1px solid #e5e5ea",
              fontSize: 12,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
            }}
          >
            {detail}
          </pre>
        ) : null}
      </div>
    </main>
  );
}
