import { readFileSync } from "node:fs";
import { join } from "node:path";
// eslint-disable-next-line import/no-unresolved -- Vite `?raw` suffix (typed by vite/client)
import rendererJs from "../../../extensions/chat-widget/assets/widget-renderer.js?raw";
// eslint-disable-next-line import/no-unresolved -- Vite `?raw` suffix (typed by vite/client)
import widgetCss from "../../../extensions/chat-widget/assets/chat-widget.css?raw";

// Preview parity seam (spec 06): the admin live preview injects the SAME
// renderer + stylesheet the storefront widget ships (extensions/chat-widget/
// assets). Vite `?raw` inlines the file contents at BUILD time; in dev that
// inlined copy goes stale when the extension files change (Vite doesn't
// re-inline reliably from outside app/), so dev reads fresh from disk per
// request. This module is `.server` so the raw strings travel to the client
// only via loader data — same settings JSON in → same DOM out, preview cannot
// drift from storefront.

const DEV = process.env.NODE_ENV !== "production";
const assetPath = (name: string) =>
  join(process.cwd(), "extensions", "chat-widget", "assets", name);

function fresh(name: string, fallback: string): string {
  if (!DEV) return fallback;
  try {
    return readFileSync(assetPath(name), "utf8");
  } catch {
    return fallback;
  }
}

export const getWidgetRendererJs = (): string => fresh("widget-renderer.js", rendererJs);
export const getWidgetCssText = (): string => fresh("chat-widget.css", widgetCss);
