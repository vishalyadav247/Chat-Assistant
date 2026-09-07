/**
 * Guard: the storefront widget's mobile soft-keyboard contract (spec 05).
 *
 * Why this file exists. The iPhone keyboard bug has been "fixed" more than
 * once and come back, because the failure is invisible on every desktop
 * browser and on Chrome for Android — the two places the widget actually gets
 * looked at.
 *
 * The mechanism, once, so the next person does not re-derive it:
 *
 *   iOS does not shrink the LAYOUT viewport when the keyboard opens. It
 *   shrinks the VISUAL viewport and slides it up to reveal the focused field.
 *   `position: fixed` is laid out against the LAYOUT viewport, so a panel
 *   pinned with `inset: 0` stays where the screen used to be while the visible
 *   area moves out from under it. Writing only `height` — which is what every
 *   earlier attempt did — resizes the box and moves it not at all, so the
 *   composer surfaces behind the keys and the panel appears to drift as
 *   Safari's scroll settles.
 *
 *   Chrome and Firefox honour `interactive-widget=resizes-content`, which
 *   shrinks the layout viewport instead, so none of this shows up there.
 *
 * Three things therefore have to stay true, and each is asserted below:
 *   1. the panel's ORIGIN tracks visualViewport.offsetTop/offsetLeft;
 *   2. the body scroll lock actually holds on iOS (`position: fixed`, not
 *      `overflow: hidden`), and gives the scroll position back on close;
 *   3. every inline property the sync writes is cleared on close.
 *
 * Run:  npx tsx scripts/qa/widget-viewport.test.ts   (static — no server, no DB)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ASSETS = join(process.cwd(), "extensions", "chat-widget", "assets");
const js = readFileSync(join(ASSETS, "chat-widget.js"), "utf-8");
const css = readFileSync(join(ASSETS, "chat-widget.css"), "utf-8");

let passed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Body of `function <name>(...)`, brace-matched so a nested function or an
 *  object literal inside it does not end the match early. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

console.log("\nWidget mobile-viewport contract\n");

// ── 1. the panel tracks the VISUAL viewport's origin, not just its size ─────
const sync = fnBody(js, "syncViewport");
ok("syncViewport exists", sync.length > 0);
ok(
  "syncViewport reads visualViewport.offsetTop",
  /offsetTop/.test(sync),
  "height alone does not move the panel — this is the bug that keeps coming back",
);
ok("syncViewport reads visualViewport.offsetLeft", /offsetLeft/.test(sync));
ok("syncViewport writes top", /\btop\s*=/.test(sync));
ok("syncViewport writes left", /\bleft\s*=/.test(sync));
ok("syncViewport writes height", /\bheight\s*=/.test(sync));
ok("syncViewport writes width", /\bwidth\s*=/.test(sync));
ok(
  "syncViewport releases bottom/right",
  /bottom\s*=\s*"auto"/.test(sync) && /right\s*=\s*"auto"/.test(sync),
  "inset:0 plus an explicit height is over-constrained; the browser drops an edge",
);
ok(
  "syncViewport clears every property when not applicable",
  /s\.top\s*=\s*s\.left\s*=\s*s\.right\s*=\s*s\.bottom\s*=\s*s\.width\s*=\s*s\.height\s*=\s*""/.test(
    sync,
  ),
  "a stale inline top/width survives into the desktop layout after a rotate",
);

// ── 2. the visualViewport listeners have something to write ─────────────────
const bind = fnBody(js, "bindViewport");
ok("bindViewport binds resize", /addEventListener\("resize"/.test(bind));
ok(
  "bindViewport binds scroll",
  /addEventListener\("scroll"/.test(bind),
  "scroll is what changes offsetTop while Safari settles",
);
ok(
  "the scroll handler repositions (not a no-op)",
  /addEventListener\("scroll",\s*syncViewportFrame\)/.test(bind),
  "it was previously bound to a height-only handler, so the listener did nothing",
);
ok(
  "listeners are removed on unbind",
  /removeEventListener\("resize"/.test(bind) && /removeEventListener\("scroll"/.test(bind),
);
ok(
  "a pending animation frame is cancelled on unbind",
  /cancelAnimationFrame/.test(bind),
  "an in-flight frame would write a stale geometry after close",
);
ok(
  "writes are coalesced to one per frame",
  /requestAnimationFrame/.test(fnBody(js, "syncViewportFrame")),
  "unthrottled writes trail the viewport by a paint — the visible jitter",
);

// ── 3. the scroll lock has to hold on iOS ───────────────────────────────────
const lock = fnBody(js, "lockBodyScroll");
ok(
  "the body scroll lock pins the body",
  /position\s*=\s*"fixed"/.test(lock),
  "overflow:hidden alone is not a scroll lock on iOS Safari",
);
ok("the body scroll lock stashes the scroll offset", /pageYOffset/.test(lock));
ok(
  "the body scroll lock restores the scroll offset",
  /window\.scrollTo\(/.test(lock),
  "without this, closing the chat teleports the shopper to the top of the page",
);
ok(
  "the body scroll lock is phone-only",
  /isPhone\(\)/.test(lock),
  "pinning the body on desktop would reflow the merchant's theme for nothing",
);

// ── 4. teardown leaves no inline geometry behind ────────────────────────────
const close = fnBody(js, "closePanel");
ok(
  "closePanel clears all six geometry properties",
  /ps\.top\s*=\s*ps\.left\s*=\s*ps\.right\s*=\s*ps\.bottom\s*=\s*ps\.width\s*=\s*ps\.height\s*=\s*""/.test(
    close,
  ),
);
ok("closePanel unbinds the viewport listeners", /vvUnbind\(\)/.test(close));
ok("closePanel releases the scroll lock", /scrollUnlock\(\)/.test(close));
ok("closePanel restores the viewport meta", /viewportMetaRestore\(\)/.test(close));

// ── 5. the safe-area inset must not float the composer off the keys ─────────
ok(
  "keyboard state is toggled on focusin",
  /addEventListener\("focusin"/.test(js) && /classList\.add\("cw-kbd"\)/.test(js),
);
ok(
  "keyboard state uses relatedTarget on focusout",
  /focusout[\s\S]{0,200}relatedTarget/.test(js),
  "without it the padding flashes back when focus moves between two fields",
);
ok(
  "cw-kbd drops the safe-area padding",
  /\.cw-panel\.cw-kbd\s*\{[^}]*padding-bottom:\s*0/.test(css),
);
ok("cw-kbd is cleared on close", /classList\.remove\("cw-kbd"\)/.test(close));

// ── 6. CSS invariants ───────────────────────────────────────────────────────
ok(
  "the thread does not chain its scroll to the storefront",
  /\.cw-body\s*\{[^}]*overscroll-behavior:\s*contain/.test(css),
  "the rubber-band moves the visual viewport, which drags the panel with it",
);
ok(
  "the widget root keeps the maximum stacking order",
  /\.cw-root\s*\{[^}]*z-index:\s*2147483647/.test(css),
);
ok(
  "the widget root has no transform",
  !/\.cw-root\s*\{[^}]*[^-]transform:/.test(css),
  "a transform on the root makes it the containing block for its fixed children",
);
ok(
  "the mobile panel is still fixed and full-bleed before JS runs",
  /@media \(max-width: 480px\)[\s\S]*?\.cw-panel\s*\{[^}]*position:\s*fixed[\s\S]*?inset:\s*0/.test(
    css,
  ),
);

console.log(`\n${passed} passed / ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
