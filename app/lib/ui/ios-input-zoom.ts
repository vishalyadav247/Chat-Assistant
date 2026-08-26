// iOS Safari zooms the whole page whenever a focused input's computed
// font-size is below 16px, and it does NOT zoom back out on blur — so an agent
// typing on an iPhone ends up panning a magnified page after every field.
//
// Our own inputs are already 16px at phone widths (app-mobile.css / the inbox
// stylesheet). Polaris fields are not: they render their <input> inside a
// shadow root at a fixed 13px, which no page-level CSS can reach — the host's
// font-size doesn't inherit in, and the components expose no ::part. The shadow
// roots are open, though, so on coarse-pointer devices we adopt one shared
// stylesheet into each field's shadow root.
//
// Touch-only by design: on a mouse pointer nothing runs and nothing changes.

const FIELD_TAGS = new Set([
  "S-TEXT-FIELD",
  "S-PASSWORD-FIELD",
  "S-EMAIL-FIELD",
  "S-NUMBER-FIELD",
  "S-SEARCH-FIELD",
  "S-MONEY-FIELD",
  "S-URL-FIELD",
  "S-TEXT-AREA",
  "S-SELECT",
  "S-DATE-FIELD",
  "S-COMBO-BOX",
]);

const CSS_TEXT = "input,textarea,select{font-size:16px !important;}";

let sheet: CSSStyleSheet | null | undefined;

function sharedSheet(): CSSStyleSheet | null {
  if (sheet !== undefined) return sheet;
  try {
    const created = new CSSStyleSheet();
    created.replaceSync(CSS_TEXT);
    sheet = created;
  } catch {
    sheet = null; // no constructable stylesheets → <style> fallback below
  }
  return sheet;
}

function patch(host: Element): void {
  const root = (host as HTMLElement).shadowRoot;
  if (!root) return; // not upgraded yet — a later scan picks it up
  const shared = sharedSheet();
  if (shared) {
    if (root.adoptedStyleSheets.includes(shared)) return;
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, shared];
      return;
    } catch {
      /* fall through to the <style> fallback */
    }
  }
  if (root.querySelector("style[data-cc-ios-zoom]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-cc-ios-zoom", "");
  style.textContent = CSS_TEXT;
  root.appendChild(style);
}

function scan(root: Document | ShadowRoot): void {
  for (const el of root.querySelectorAll("*")) {
    if (FIELD_TAGS.has(el.tagName)) patch(el);
    const nested = (el as HTMLElement).shadowRoot;
    // Fields can also live inside another component's shadow root (modals).
    if (nested && !FIELD_TAGS.has(el.tagName)) scan(nested);
  }
}

/** Returns a cleanup function, or undefined when the fix doesn't apply. */
export function installIosInputZoomFix(): (() => void) | undefined {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!window.matchMedia?.("(pointer: coarse)").matches) return;

  let frame = 0;
  const run = () => {
    frame = 0;
    scan(document);
  };
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(run);
  };

  run();
  // Custom elements upgrade asynchronously (polaris.js is loaded from the CDN),
  // so re-scan a few times before falling back to mutation-driven scans only.
  const timers = [150, 600, 1800].map((ms) => window.setTimeout(run, ms));
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.addedNodes.length > 0) {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    timers.forEach((id) => window.clearTimeout(id));
    if (frame) window.cancelAnimationFrame(frame);
  };
}
