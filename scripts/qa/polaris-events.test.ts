/**
 * Guard: React 18 cannot deliver `onChange` (or any non-React event) from a
 * Polaris web component.
 *
 * Why this file exists. Every `<s-*>` element is a custom element, and React
 * 18's ChangeEventPlugin only synthesises `onChange` for four DOM shapes:
 *
 *   node_modules/react-dom/cjs/react-dom.development.js
 *     shouldUseChangeEvent()  -> <select>, <input type="file">
 *     isTextInputElement()    -> <input>, <textarea>
 *     shouldUseClickEvent()   -> <input type="checkbox"|"radio">
 *
 * A custom element matches none of them, `getTargetInstFunc` stays undefined,
 * and `extractEvents` returns without dispatching anything. `change` is also
 * absent from `simpleEventPluginEvents`, so no other plugin picks it up either.
 * The handler is silently never called: the merchant flips a switch and nothing
 * happens, with no error in the console.
 *
 * `input` IS in `simpleEventPluginEvents`, so `onInput` is delivered normally —
 * and the Polaris manifest shows every affected control emits BOTH `change` and
 * `input`, so `onInput` is a faithful, lossless replacement.
 *
 * `onDismiss` is worse: it is not a registered React event name at all, so React
 * treats it as a DOM attribute and then drops it because the value is a
 * function. Those go through `app/components/ui/DismissibleBanner.tsx`, which
 * attaches a real listener to the element.
 *
 * TypeScript CANNOT catch any of this: `@shopify/polaris-types` declares
 * `onChange?: (event: Event) => void` on these elements, because the types
 * describe the element's own API, not what React 18 can wire up.
 *
 * This guard fails the build if a dead handler is reintroduced. Delete it when
 * the app moves to React 19, which supports custom-element props and events.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "app");

/** React event props that never reach a custom element under React 18. */
const DEAD_ON_CUSTOM_ELEMENTS = ["onChange", "onDismiss", "onToggle", "onSelect"];

let passed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(p, out);
    else if (entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const WHITESPACE = [" ", "\n", "\t", "\r"];

/** True when `name` appears as an attribute NAME (not inside a handler body). */
function hasAttribute(attrs: string, name: string): boolean {
  let i = -1;
  while ((i = attrs.indexOf(name, i + 1)) >= 0) {
    const before = i === 0 ? " " : attrs[i - 1];
    if (!WHITESPACE.includes(before)) continue;
    let j = i + name.length;
    while (j < attrs.length && WHITESPACE.includes(attrs[j])) j++;
    if (attrs[j] === "=") return true;
  }
  return false;
}

interface Site {
  file: string;
  line: number;
  tag: string;
  handler: string;
}

/** Every `<s-*>` opening tag with its attribute text. Brace-depth aware so an
 *  arrow function's `=>` inside a handler is not mistaken for the tag's `>`. */
function scan(source: string, file: string): Site[] {
  const found: Site[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "<") continue;
    const m = /^<([a-zA-Z][\w-]*)/.exec(source.slice(i, i + 40));
    if (!m) continue;
    const tag = m[1];
    if (!tag.startsWith("s-")) continue;

    let depth = 0;
    let end = -1;
    for (let j = i + 1 + tag.length; j < source.length; j++) {
      const c = source[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;

    const attrs = source.slice(i + 1 + tag.length, end);
    for (const handler of DEAD_ON_CUSTOM_ELEMENTS) {
      if (!hasAttribute(attrs, handler)) continue;
      // An `onInput` on the same element already carries the behaviour, so the
      // dead `onChange` beside it is redundant rather than broken. Still worth
      // removing, but it is not a functional defect and must not fail the build.
      if (handler === "onChange" && hasAttribute(attrs, "onInput")) continue;
      found.push({ file, line: source.slice(0, i).split("\n").length, tag, handler });
    }
    i = end;
  }
  return found;
}

function main(): void {
  console.log("── Polaris web components: React 18 event delivery");

  const files = tsxFiles(ROOT);
  ok("scanned the whole app tree", files.length > 50, `${files.length} .tsx files`);

  const dead: Site[] = [];
  for (const file of files) {
    dead.push(...scan(readFileSync(file, "utf-8"), file.replace(ROOT, "app")));
  }

  ok(
    "no dead event handler on any Polaris custom element",
    dead.length === 0,
    dead.length
      ? `${dead.length} site(s): ` +
        dead
          .slice(0, 8)
          .map((d) => `${d.file}:${d.line} ${d.handler} <${d.tag}>`)
          .join("; ") +
        (dead.length > 8 ? ` …and ${dead.length - 8} more` : "")
      : "",
  );

  // The reasoning above is only valid while React is on 18. On 19 custom-element
  // props work and this guard should be deleted rather than silently kept.
  const reactVersion = String(
    (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")).dependencies ?? {})
      .react ?? "",
  );
  ok(
    "still on React 18 (this guard is only needed until 19)",
    /\^?18\./.test(reactVersion),
    `react ${reactVersion} — on React 19 delete scripts/qa/polaris-events.test.ts and DismissibleBanner`,
  );

  // The replacement must actually exist and be used for banner dismissal.
  const banner = readFileSync(join(ROOT, "components", "ui", "DismissibleBanner.tsx"), "utf-8");
  ok(
    "DismissibleBanner attaches a real listener for the native `dismiss` event",
    banner.includes(`addEventListener("dismiss"`),
  );
  ok("DismissibleBanner always renders the element as dismissible", banner.includes("dismissible"));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main();
