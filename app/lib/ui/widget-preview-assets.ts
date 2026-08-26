// Shared asset injector for the admin live previews (Chatbox, spec 06, and
// Proactive chat, spec 12). Both render through the REAL storefront builders by
// injecting extensions/chat-widget/assets/{widget-renderer.js,chat-widget.css}
// into the admin document, so preview and storefront cannot drift.
//
// The tricky part is REFRESH. The loader re-reads those files from disk on
// every dev request, but the injected <script> executes once and defines
// window.ChatConvertRenderer for the lifetime of the browser session. A guard
// like `if (!window.ChatConvertRenderer) inject()` therefore pins the page to
// whichever build happened to load first: edit the renderer, and the preview
// silently keeps rendering with the old one. That is not theoretical — it is
// what made every proactive-chat preview read "[object Object]" after the
// campaign settings shape changed under a renderer that was still expecting
// the old one.
//
// So each injected asset carries a content hash, and anything stale is
// replaced (for the script: removed, the global cleared, and re-executed).

const STYLE_ID = "chatconvert-preview-widget-css";
const SCRIPT_ID = "chatconvert-preview-renderer-js";
const HASH_ATTR = "data-cc-hash";

/** djb2-xor — not cryptographic, just needs to change when the file changes. */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h) ^ input.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function syncStyle(id: string, css: string): void {
  const key = hash(css);
  const existing = document.getElementById(id);
  if (existing && existing.getAttribute(HASH_ATTR) === key) return;
  existing?.remove();
  const style = document.createElement("style");
  style.id = id;
  style.setAttribute(HASH_ATTR, key);
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Inject (or refresh) the storefront renderer + stylesheet.
 *
 * @param rendererJs  widget-renderer.js source, from the route loader
 * @param widgetCss   chat-widget.css source, from the route loader
 * @param overrideId  id for this preview's own layout-override <style>
 * @param overrideCss admin-only layout overrides (never visual styling)
 * @returns whether window.ChatConvertRenderer is ready to call
 */
export function ensureWidgetPreviewAssets(
  rendererJs: string,
  widgetCss: string,
  overrideId: string,
  overrideCss: string,
): boolean {
  if (typeof document === "undefined") return false;

  // Base storefront CSS is shared by every preview; the overrides are not.
  syncStyle(STYLE_ID, widgetCss);
  syncStyle(overrideId, overrideCss);

  const key = hash(rendererJs);
  const existing = document.getElementById(SCRIPT_ID);
  const holder = window as unknown as { ChatConvertRenderer?: unknown };
  if (!existing || existing.getAttribute(HASH_ATTR) !== key || !holder.ChatConvertRenderer) {
    existing?.remove();
    // The renderer registers itself on window at the end of its IIFE. Clear the
    // old object first so a failed re-execution can't leave the stale one
    // behind looking healthy.
    delete holder.ChatConvertRenderer;
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.setAttribute(HASH_ATTR, key);
    script.textContent = rendererJs; // executes synchronously on append
    document.head.appendChild(script);
  }

  return Boolean(holder.ChatConvertRenderer);
}
