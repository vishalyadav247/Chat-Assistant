// Polaris `s-page` renders its content inside a shadow root, wrapped in a
// `.page` element that carries the page gutter. `s-page` itself is
// display:contents, so nothing in our stylesheets can reach that padding — it
// is what keeps the Inbox off the screen edges on a phone no matter how much
// padding the shell gives up.
//
// The shadow root is open, so we adopt one stylesheet into it, exactly the way
// installIosInputZoomFix() reaches Polaris field inputs. The media query lives
// INSIDE the adopted sheet rather than around the call, so the rule follows
// rotations and resizes without any listener of ours.
//
// Scoped to whichever route calls it, and removed on unmount.

const CSS_TEXT = "@media (max-width:768px){.page{padding:0 !important;margin:0 !important;}}";

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

function patch(host: Element): boolean {
  const root = (host as HTMLElement).shadowRoot;
  if (!root) return false; // not upgraded yet — a later scan picks it up
  const shared = sharedSheet();
  if (shared) {
    if (root.adoptedStyleSheets.includes(shared)) return true;
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, shared];
      return true;
    } catch {
      /* fall through to the <style> fallback */
    }
  }
  if (root.querySelector("style[data-cc-fullbleed]")) return true;
  const style = document.createElement("style");
  style.setAttribute("data-cc-fullbleed", "");
  style.textContent = CSS_TEXT;
  root.appendChild(style);
  return true;
}

function unpatch(host: Element): void {
  const root = (host as HTMLElement).shadowRoot;
  if (!root) return;
  if (sheet) {
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
  }
  root.querySelector("style[data-cc-fullbleed]")?.remove();
}

/** Drop `s-page`'s own gutter at phone widths. Returns a cleanup function. */
export function installFullBleedPage(): (() => void) | undefined {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const hosts = new Set<Element>();
  const run = () => {
    for (const host of document.querySelectorAll("s-page")) {
      if (patch(host)) hosts.add(host);
    }
  };

  run();
  // polaris.js loads from the CDN, so the element upgrades after we mount.
  const timers = [100, 400, 1200].map((ms) => window.setTimeout(run, ms));
  const observer = new MutationObserver(run);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    timers.forEach((id) => window.clearTimeout(id));
    hosts.forEach(unpatch);
  };
}
