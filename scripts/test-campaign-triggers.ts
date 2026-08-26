/* Proactive-chat campaign evaluator unit test (spec 12 acceptance 3).
 * Loads the widget shell (extensions/chat-widget/assets/chat-widget.js) in a
 * node vm sandbox — the shell exposes the PURE evaluator on
 * window.ChatConvertCampaigns before touching the DOM, and bails out when
 * #chatconvert-root is missing, so no browser is needed.
 *
 * The evaluator answers "may this campaign fire on this page, for this
 * shopper?" — page scope + every Conditions rule + the cart window. Timing
 * (dwell, scroll depth, exit intent) is armed by the runtime, not here.
 *
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
  productId?: string;
  collectionId?: string;
  seen?: Record<string, number>;
  cart?: { itemCount: number; totalValue: number } | null;
  cartRemoved?: boolean;
  isCustomer?: boolean;
  device?: string;
  online?: boolean;
  today?: string;
  country?: string;
}
type EvalCampaign = (campaign: unknown, ctx: Ctx) => boolean;
type PageType = (raw: string) => string;

const sandbox: Record<string, unknown> = {};
sandbox.window = sandbox;
sandbox.document = { getElementById: () => null }; // shell bails after exposing the evaluator
vm.runInNewContext(src, sandbox, { filename: "chat-widget.js" });

const api = (
  sandbox as { ChatConvertCampaigns?: { evalCampaign: EvalCampaign; pageType: PageType } }
).ChatConvertCampaigns;
if (!api) {
  console.error("FAIL: window.ChatConvertCampaigns not exposed by the shell");
  process.exit(1);
}
const { evalCampaign, pageType } = api;

const campaign = (
  trigger: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  id = "c1",
) => ({ id, trigger, conditions: {}, ...extra });

let failures = 0;
function check(name: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} (got ${actual}, want ${expected})`);
}

console.log("evalCampaign — page scope:");
check(
  "home scope matches home page",
  evalCampaign(campaign({ pageScope: "home" }), { pageType: "home", path: "/" }),
  true,
);
check(
  "home scope skips product page",
  evalCampaign(campaign({ pageScope: "home" }), { pageType: "product", path: "/products/x" }),
  false,
);
check(
  "all_pages matches every page",
  evalCampaign(campaign({ pageScope: "all_pages" }), { pageType: "search", path: "/search" }),
  true,
);
check(
  "missing pageScope behaves as all_pages",
  evalCampaign(campaign({}), { pageType: "cart", path: "/cart" }),
  true,
);
check(
  "all_product_pages matches any product",
  evalCampaign(campaign({ pageScope: "all_product_pages" }), {
    pageType: "product",
    path: "/products/tee",
  }),
  true,
);
check(
  "specific_product_pages matches the listed product",
  evalCampaign(
    campaign({ pageScope: "specific_product_pages", pageProductIds: ["gid://shopify/Product/1"] }),
    { pageType: "product", path: "/products/tee", productId: "gid://shopify/Product/1" },
  ),
  true,
);
check(
  "specific_product_pages skips an unlisted product",
  evalCampaign(
    campaign({ pageScope: "specific_product_pages", pageProductIds: ["gid://shopify/Product/1"] }),
    { pageType: "product", path: "/products/hat", productId: "gid://shopify/Product/2" },
  ),
  false,
);
check(
  "specific_collection_pages matches the listed collection",
  evalCampaign(
    campaign({
      pageScope: "specific_collection_pages",
      pageCollectionIds: ["gid://shopify/Collection/9"],
    }),
    { pageType: "collection", path: "/collections/sale", collectionId: "gid://shopify/Collection/9" },
  ),
  true,
);

console.log("evalCampaign — specific pages (urlContains):");
check(
  "urlContains hit",
  evalCampaign(campaign({ pageScope: "specific_pages", urlContains: "/sale" }), {
    pageType: "home",
    path: "/collections/sale",
  }),
  true,
);
check(
  "urlContains miss",
  evalCampaign(campaign({ pageScope: "specific_pages", urlContains: "/sale" }), {
    pageType: "home",
    path: "/collections/new",
  }),
  false,
);

console.log("evalCampaign — cart window:");
const cartCampaign = campaign({ pageScope: "cart", cartMinItems: 2, cartMinValue: 50 });
check("cart unknown → no fire", evalCampaign(cartCampaign, { pageType: "cart", path: "/cart", cart: null }), false);
check(
  "below item threshold → no fire",
  evalCampaign(cartCampaign, { pageType: "cart", path: "/cart", cart: { itemCount: 1, totalValue: 100 } }),
  false,
);
check(
  "below value threshold → no fire",
  evalCampaign(cartCampaign, { pageType: "cart", path: "/cart", cart: { itemCount: 3, totalValue: 20 } }),
  false,
);
check(
  "both thresholds met → fire",
  evalCampaign(cartCampaign, { pageType: "cart", path: "/cart", cart: { itemCount: 3, totalValue: 80 } }),
  true,
);
check(
  "above the maximum cart value → no fire",
  evalCampaign(campaign({ pageScope: "cart", cartMaxValue: 100 }), {
    pageType: "cart",
    path: "/cart",
    cart: { itemCount: 2, totalValue: 250 },
  }),
  false,
);
check(
  "inside the cart value window → fire",
  evalCampaign(campaign({ pageScope: "cart", cartMinValue: 20, cartMaxValue: 100 }), {
    pageType: "cart",
    path: "/cart",
    cart: { itemCount: 2, totalValue: 60 },
  }),
  true,
);
check(
  "no cart conditions ignore cart",
  evalCampaign(campaign({ pageScope: "cart" }), { pageType: "cart", path: "/cart", cart: null }),
  true,
);

console.log("evalCampaign — conditions:");
const audience = (value: string) => campaign({}, { conditions: { audience: value } });
check("customers-only skips a guest", evalCampaign(audience("customers"), { pageType: "home", isCustomer: false }), false);
check("customers-only fires for a customer", evalCampaign(audience("customers"), { pageType: "home", isCustomer: true }), true);
check("visitors-only skips a customer", evalCampaign(audience("visitors"), { pageType: "home", isCustomer: true }), false);

const device = (value: string) => campaign({}, { conditions: { device: value } });
check("mobile-only skips desktop", evalCampaign(device("mobile"), { pageType: "home", device: "desktop" }), false);
check("mobile-only fires on mobile", evalCampaign(device("mobile"), { pageType: "home", device: "mobile" }), true);

const hours = campaign({}, { conditions: { displayTime: "business_hours" } });
check("business hours skips when offline", evalCampaign(hours, { pageType: "home", online: false }), false);
check("business hours fires when online", evalCampaign(hours, { pageType: "home", online: true }), true);

const window_ = campaign(
  {},
  { conditions: { displayDuration: "custom", startDate: "2026-09-01", endDate: "2026-09-30" } },
);
check("before the window → no fire", evalCampaign(window_, { pageType: "home", today: "2026-08-31" }), false);
check("inside the window → fire", evalCampaign(window_, { pageType: "home", today: "2026-09-15" }), true);
check("after the window → no fire", evalCampaign(window_, { pageType: "home", today: "2026-10-01" }), false);

const geo = campaign({}, { conditions: { countryMode: "selected", countries: ["IN", "US"] } });
check("listed country → fire", evalCampaign(geo, { pageType: "home", country: "IN" }), true);
check("unlisted country → no fire", evalCampaign(geo, { pageType: "home", country: "FR" }), false);
check("unknown country → no fire", evalCampaign(geo, { pageType: "home", country: "" }), false);

console.log("evalCampaign — remove-items event + session frequency:");
const removal = campaign({}, { templateType: "remove_items" });
check("no removal this view → no fire", evalCampaign(removal, { pageType: "home", cartRemoved: false }), false);
check("removal detected → fire", evalCampaign(removal, { pageType: "home", cartRemoved: true }), true);
check(
  "already shown this session → no fire",
  evalCampaign(campaign({}, {}, "seen1"), { pageType: "home", path: "/", seen: { seen1: 1 } }),
  false,
);
check(
  "other campaign seen → still fires",
  evalCampaign(campaign({}, {}, "c2"), { pageType: "home", path: "/", seen: { seen1: 1 } }),
  true,
);

console.log("ccPageType — Shopify template mapping:");
check("index → home", pageType("index") === "home", true);
check("list-collections → collection", pageType("list-collections") === "collection", true);
check("product passthrough", pageType("product") === "product", true);

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} campaign check(s) failed.`);
  process.exit(1);
}
console.log("OK: all campaign evaluator checks passed.");
