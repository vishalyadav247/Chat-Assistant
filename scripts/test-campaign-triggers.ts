/* Proactive-chat trigger evaluator unit test (spec 12 acceptance 3).
 * Loads the widget shell (extensions/chat-widget/assets/chat-widget.js) in a
 * node vm sandbox — the shell exposes the PURE evaluator on
 * window.ChatConvertCampaigns before touching the DOM, and bails out when
 * #chatconvert-root is missing, so no browser is needed.
 * Run: npx tsx scripts/test-campaign-triggers.ts (exit 1 on failure).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const src = readFileSync(
  join(process.cwd(), "extensions", "chat-widget", "assets", "chat-widget.js"),
  "utf8",
);

interface Ctx {
  pageType?: string;
  path?: string;
  seen?: Record<string, number>;
  cart?: { itemCount: number; totalValue: number } | null;
  elapsedMs?: number;
}
type EvalTrigger = (campaign: unknown, ctx: Ctx) => boolean;
type PageType = (raw: string) => string;

const sandbox: Record<string, unknown> = {};
sandbox.window = sandbox;
sandbox.document = { getElementById: () => null }; // shell bails after exposing the evaluator
vm.runInNewContext(src, sandbox, { filename: "chat-widget.js" });

const api = (sandbox as { ChatConvertCampaigns?: { evalTrigger: EvalTrigger; pageType: PageType } })
  .ChatConvertCampaigns;
if (!api) {
  console.error("FAIL: window.ChatConvertCampaigns not exposed by the shell");
  process.exit(1);
}
const { evalTrigger, pageType } = api;

const campaign = (trigger: Record<string, unknown>, id = "c1") => ({ id, trigger });

let failures = 0;
function check(name: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} (got ${actual}, want ${expected})`);
}

console.log("ccEvalTrigger — page type:");
check("home campaign matches home page", evalTrigger(campaign({ pageTypes: ["home"] }), { pageType: "home", path: "/" }), true);
check("home campaign skips product page", evalTrigger(campaign({ pageTypes: ["home"] }), { pageType: "product", path: "/products/x" }), false);
check("'any' matches every page", evalTrigger(campaign({ pageTypes: ["any"] }), { pageType: "search", path: "/search" }), true);
check("empty pageTypes behaves as 'any'", evalTrigger(campaign({ pageTypes: [] }), { pageType: "cart", path: "/cart" }), true);
check("multi page types match either", evalTrigger(campaign({ pageTypes: ["product", "collection"] }), { pageType: "collection", path: "/collections/all" }), true);

console.log("ccEvalTrigger — urlContains:");
check("urlContains hit", evalTrigger(campaign({ pageTypes: ["any"], urlContains: "/sale" }), { pageType: "home", path: "/collections/sale" }), true);
check("urlContains miss", evalTrigger(campaign({ pageTypes: ["any"], urlContains: "/sale" }), { pageType: "home", path: "/collections/new" }), false);

console.log("ccEvalTrigger — cart conditions:");
const cartCampaign = campaign({ pageTypes: ["cart"], cartMinItems: 2, cartMinValue: 50 });
check("cart unknown → no fire", evalTrigger(cartCampaign, { pageType: "cart", path: "/cart", cart: null }), false);
check("below item threshold → no fire", evalTrigger(cartCampaign, { pageType: "cart", path: "/cart", cart: { itemCount: 1, totalValue: 100 } }), false);
check("below value threshold → no fire", evalTrigger(cartCampaign, { pageType: "cart", path: "/cart", cart: { itemCount: 3, totalValue: 20 } }), false);
check("both thresholds met → fire", evalTrigger(cartCampaign, { pageType: "cart", path: "/cart", cart: { itemCount: 3, totalValue: 80 } }), true);
check("no cart conditions ignore cart", evalTrigger(campaign({ pageTypes: ["cart"] }), { pageType: "cart", path: "/cart", cart: null }), true);

console.log("ccEvalTrigger — delay + session frequency:");
const delayed = campaign({ pageTypes: ["home"], delaySeconds: 3 });
check("before delay elapses → no fire", evalTrigger(delayed, { pageType: "home", path: "/", elapsedMs: 1000 }), false);
check("after delay elapses → fire", evalTrigger(delayed, { pageType: "home", path: "/", elapsedMs: 3000 }), true);
check("elapsed omitted (scheduler owns delay) → fire", evalTrigger(delayed, { pageType: "home", path: "/" }), true);
check("already shown this session → no fire", evalTrigger(campaign({ pageTypes: ["any"] }, "seen1"), { pageType: "home", path: "/", seen: { seen1: 1 } }), false);
check("other campaign seen → still fires", evalTrigger(campaign({ pageTypes: ["any"] }, "c2"), { pageType: "home", path: "/", seen: { seen1: 1 } }), true);

console.log("ccPageType — Shopify template mapping:");
check("index → home", pageType("index") === "home", true);
check("list-collections → collection", pageType("list-collections") === "collection", true);
check("product passthrough", pageType("product") === "product", true);

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} trigger check(s) failed.`);
  process.exit(1);
}
console.log("OK: all trigger evaluator checks passed.");
