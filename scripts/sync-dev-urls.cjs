// Point shopify.app.dev.toml's three URLs at a tunnel.
//
//   node scripts/sync-dev-urls.cjs https://something.trycloudflare.com
//
// `shopify app dev` rewrites application_url and redirect_urls on every run, but
// it does NOT touch [app_proxy].url. The storefront widget talks to the app
// entirely through /apps/ccwidget, so a stale app_proxy.url means Shopify
// forwards every widget request to the old host and the widget 404s on
// /widget-config before it renders anything.
//
// Called automatically by scripts/dev-tunnel.ps1. Run it by hand when you use
// the CLI's own tunnel: copy the https URL it prints and pass it here.
//
// SAFETY: writes to shopify.app.dev.toml and nothing else. It refuses to run if
// that file carries the production client_id.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEV = path.join(ROOT, "shopify.app.dev.toml");
const PROD = path.join(ROOT, "shopify.app.toml");

const base = (process.argv[2] || "").trim().replace(/\/+$/, "");
if (!/^https:\/\/[^/\s]+$/.test(base)) {
  console.error("usage: node scripts/sync-dev-urls.cjs https://<tunnel-host>");
  process.exit(2);
}

if (!fs.existsSync(DEV)) {
  console.error("  shopify.app.dev.toml not found. Run `npm run config:link` first.");
  process.exit(1);
}

const dev = fs.readFileSync(DEV, "utf-8").replace(/\r\n/g, "\n");
const idOf = (t) => (/^client_id = "(.+)"$/m.exec(t) || [])[1];

if (idOf(dev) === idOf(fs.readFileSync(PROD, "utf-8"))) {
  console.error("  REFUSING: shopify.app.dev.toml carries the PRODUCTION client_id.");
  console.error("  Re-link a separate dev app before pointing anything at a tunnel.");
  process.exit(1);
}

const edits = [
  [/^application_url = ".*"$/m, `application_url = "${base}"`],
  [/^redirect_urls = \[[^\]]*\]/m, `redirect_urls = [ "${base}/auth/callback" ]`],
  // Only inside [app_proxy]: `url =` is too generic to replace globally.
  [/(\[app_proxy\][\s\S]*?)^url = ".*"$/m, (_m, head) => `${head}url = "${base}/proxy"`],
];

let out = dev;
for (const [re, to] of edits) {
  if (!re.test(out)) {
    console.error(`  could not find ${re} in shopify.app.dev.toml - not writing anything.`);
    process.exit(1);
  }
  out = out.replace(re, to);
}

if (out === dev) {
  console.log(`  shopify.app.dev.toml already points at ${base}`);
  process.exit(0);
}

fs.writeFileSync(DEV, out, "utf-8");
console.log(`  shopify.app.dev.toml -> ${base}`);
console.log(`    application_url  ${base}`);
console.log(`    redirect_urls    ${base}/auth/callback`);
console.log(`    app_proxy.url    ${base}/proxy`);
