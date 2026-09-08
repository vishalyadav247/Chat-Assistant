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

// ── 1. the panel's box is written from the VISUAL viewport ──────────────────
const apply = fnBody(js, "applyViewport");
ok("applyViewport exists", apply.length > 0);
ok(
  "it reads visualViewport width, height and both offsets",
  /vv\.width/.test(apply) &&
    /vv\.height/.test(apply) &&
    /vv\.offsetLeft/.test(apply) &&
    /vv\.offsetTop/.test(apply),
  "height alone resizes the box and moves it not at all — the original bug",
);
ok("it writes width and height", /\bwidth\s*=\s*w/.test(apply) && /\bheight\s*=\s*h/.test(apply));
ok(
  "it releases bottom/right",
  /bottom\s*=\s*"auto"/.test(apply) && /right\s*=\s*"auto"/.test(apply),
  "inset:0 plus an explicit height is over-constrained; the browser drops an edge",
);
ok(
  "the offset is applied as a transform, not as top",
  /transform\s*=\s*[^;]*translate3d/.test(apply) && /s\.top\s*=\s*"0px"/.test(apply),
  "moving the layout box restarts Safari's own scroll-into-view — a feedback loop",
);
ok(
  "it clears every property, transform included, when not applicable",
  /s\.top\s*=\s*s\.left\s*=\s*s\.right\s*=\s*s\.bottom\s*=\s*s\.width\s*=\s*s\.height\s*=\s*s\.transform\s*=\s*""/.test(
    apply,
  ),
  "a stale inline top/width survives into the desktop layout after a rotate",
);
ok(
  "it writes only when the geometry actually changed",
  /geometry === appliedGeometry\) return/.test(apply),
  "a write every frame would thrash layout for no reason",
);
ok(
  "it re-pins the thread only when the panel SHRANK",
  /!grew && state\.screen === "chat"/.test(apply),
  "scrolling on the way back out fights a shopper who scrolled up to read",
);

// ── 2. the geometry is READ every frame, never waited for ───────────────────
// Two event-driven attempts failed on real hardware: Safari's resize can carry
// mid-animation numbers and then stop, so the panel stayed wrong until the
// shopper typed (the caret scroll finally produced a settled event). Reading
// the viewport directly removes every timing assumption at once.
const loop = fnBody(js, "startViewportLoop");
ok("startViewportLoop exists", loop.length > 0);
ok(
  "the loop re-reads on every animation frame",
  /requestAnimationFrame/.test(loop) && /applyViewport\(\)/.test(loop),
);
ok(
  "the loop is single-flighted",
  /if \(vvLoop !== null\) return;/.test(loop),
  "a second loop would double every write",
);
ok("the loop is cancellable", /cancelAnimationFrame/.test(fnBody(js, "stopViewportLoop")));
ok(
  "the loop starts when the panel opens",
  /startViewportLoop\(\);/.test(fnBody(js, "openPanel")),
);
ok(
  "the loop stops when the panel closes",
  /stopViewportLoop\(\);/.test(fnBody(js, "closePanel")),
  "an rAF loop must not outlive the modal that needs it",
);
ok(
  "the panel's geometry does not depend on focus events",
  !/watchKeyboard/.test(js),
  "focus timing was the assumption that failed twice",
);
ok(
  "the diagnostic overlay is opt-in only",
  /ccdebug=1/.test(js) && /if \(dbgEl \|\| !debugEnabled\(\)\) return;/.test(js),
  "it must never render for a shopper",
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
  "closePanel clears all seven geometry properties",
  /ps\.top\s*=\s*ps\.left\s*=\s*ps\.right\s*=\s*ps\.bottom\s*=\s*ps\.width\s*=\s*ps\.height\s*=\s*ps\.transform\s*=\s*""/.test(
    close,
  ),
);
ok(
  "closePanel resets the applied-geometry memo",
  /appliedGeometry = "";/.test(close),
  "otherwise the next open sees its own stale value and skips the first write",
);
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
