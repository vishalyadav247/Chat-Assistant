// Push the dev app's CONFIG (not just the extension) to Shopify.
//
//   npm run dev:push-proxy
//
// Run this after the tunnel hostname changes — i.e. after every cloudflared
// restart. It replaces the manual trip to the Dev Dashboard's App proxy page.
//
// Why it exists: `shopify app dev` rewrites application_url and redirect_urls on
// every run but never touches [app_proxy].url, and the storefront widget reaches
// the app ONLY through /apps/ccwidget. A stale proxy URL is the single most
// expensive failure in this project's dev loop — it presents as a 404 or 500 on
// the storefront with nothing wrong in the code.
//
// The `include_config_on_deploy` dance is the load-bearing part. Without that
// key, `shopify app deploy` ships the theme extension and SILENTLY DROPS the app
// configuration, so the released version keeps whatever proxy URL it had. Two
// releases were burned discovering that. The CLI also strips the key from the
// file after every deploy, so it must be re-added each time — hence this script
// rather than a note in the README.
//
// SAFETY: --config dev, always. It refuses to run if shopify.app.dev.toml
// carries the production client_id.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DEV = path.join(ROOT, "shopify.app.dev.toml");
const PROD = path.join(ROOT, "shopify.app.toml");

if (!fs.existsSync(DEV)) {
  console.error("  shopify.app.dev.toml not found. Run `npm run config:link` first.");
  process.exit(1);
}

const idOf = (t) => (/^client_id = "(.+)"$/m.exec(t) || [])[1];
let dev = fs.readFileSync(DEV, "utf-8").replace(/\r\n/g, "\n");

if (idOf(dev) === idOf(fs.readFileSync(PROD, "utf-8"))) {
  console.error("  REFUSING: shopify.app.dev.toml carries the PRODUCTION client_id.");
  process.exit(1);
}

const proxy = (/^\[app_proxy\][\s\S]*?^url = "(.+)"$/m.exec(dev) || [])[1];
if (!proxy) {
  console.error("  no [app_proxy].url in shopify.app.dev.toml - run dev:tunnel first.");
  process.exit(1);
}
if (proxy.includes("example.com")) {
  console.error(`  [app_proxy].url is still the placeholder (${proxy}).`);
  console.error("  Start the tunnel and run `npm run dev:tunnel` before pushing.");
  process.exit(1);
}

if (!/include_config_on_deploy/.test(dev)) {
  dev = dev.replace(/(\[build\]\n)/, (m) => m + "include_config_on_deploy = true\n");
  fs.writeFileSync(DEV, dev, "utf-8");
  console.log("  set include_config_on_deploy = true (the CLI strips it after each deploy)");
}

console.log(`  pushing app proxy -> ${proxy}\n`);

// One command STRING with shell:true. On Windows, passing an argv array with
// shell:true does not quote the elements, so --message "dev: sync app proxy URL"
// arrived as four separate arguments and the CLI rejected it. Without shell:true
// at all, spawnSync cannot execute the npx.cmd shim. A single quoted string is
// the only form that works on both counts.
const res = spawnSync(
  `npx shopify app deploy --config dev --allow-updates --message "dev: sync app proxy URL"`,
  { cwd: ROOT, stdio: "inherit", shell: true },
);

if (res.status !== 0) {
  console.error("\n  deploy failed - the storefront widget will keep 404ing until this succeeds.");
  process.exit(res.status ?? 1);
}

console.log("\n  Done. Verify with:");
console.log('    curl -s -o /dev/null -w "%{http_code}\\n" "https://<dev-store>.myshopify.com/apps/ccwidget/widget-config?t=1"');
console.log("    200 = working   404 = not routing   500 = routing to a dead tunnel");
