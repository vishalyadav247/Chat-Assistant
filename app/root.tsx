import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { installIosInputZoomFix } from "./lib/ui/ios-input-zoom";

export default function App() {
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
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
