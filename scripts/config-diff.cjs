// Compare the dev app config against production, ignoring the parts that are
// SUPPOSED to differ.  npm run config:diff
//
// Why this exists: shopify.app.dev.toml is gitignored, so a scope or webhook you
// add while developing leaves no trace in git. `npm run release` will happily
// ship the code that depends on it, `deploy.sh` will happily deploy that code,
// and the feature will fail in production against an app record that was never
// told about the change. Nothing in the normal loop catches it.
//
// Run this before every `npm run deploy`. Empty output means the two app records
// will agree.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PROD = path.join(ROOT, "shopify.app.toml");
const DEV = path.join(ROOT, "shopify.app.dev.toml");

// Keys whose whole point is to differ between the two apps, plus the ones the
// CLI writes with different defaults depending on which dialog created the file.
const EXPECTED_TO_DIFFER = [
  /^client_id\s*=/,
  /^name\s*=/,
  /^handle\s*=/,
  /^application_url\s*=/,
  /^redirect_urls\s*=/,
  /^url\s*=/, // app_proxy.url
  /^automatically_update_urls_on_dev\s*=/,
  /^include_config_on_deploy\s*=/,
  /^dev_store_url\s*=/,
  /^optional_scopes\s*=/,
  /^use_legacy_install_flow\s*=/,
];

function normalize(file) {
  if (!fs.existsSync(file)) {
    console.error(`  ${path.basename(file)} does not exist.`);
    process.exit(1);
  }
  const raw = fs
    .readFileSync(file, "utf-8")
    .replace(/\r\n/g, "\n")
    // Collapse every multi-line array onto one line FIRST. The same value can be
    // written inline or spread over five lines depending on who last edited the
    // file, and a line-based diff would report that formatting as a real change.
    .replace(/\[[^\][]*\]/gs, (m) => m.replace(/\s+/g, " "));

  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .filter((l) => !EXPECTED_TO_DIFFER.some((re) => re.test(l)))
    // Scopes are an unordered set written as one comma-joined string; sort them
    // so a reordering is not mistaken for a granted or revoked permission.
    .map((l) => {
      const m = /^scopes\s*=\s*"(.*)"$/.exec(l);
      return m ? `scopes = "${m[1].split(",").map((s) => s.trim()).sort().join(",")}"` : l;
    });
}

const prod = normalize(PROD);
const dev = normalize(DEV);

// Multiset difference: a repeated line (several identical `topics = [...]`) must
// appear the same number of times on both sides.
function missingFrom(a, b) {
  const counts = new Map();
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out = [];
  for (const line of a) {
    const n = counts.get(line) ?? 0;
    if (n === 0) out.push(line);
    else counts.set(line, n - 1);
  }
  return out;
}

const onlyInDev = missingFrom(dev, prod);
const onlyInProd = missingFrom(prod, dev);

if (onlyInDev.length === 0 && onlyInProd.length === 0) {
  console.log("\n  shopify.app.toml and shopify.app.dev.toml agree.");
  console.log("  (URLs, client_id, name and [build] are excluded by design.)\n");
  process.exit(0);
}

if (onlyInDev.length) {
  console.log("\n  In dev but NOT in production - port these into shopify.app.toml");
  console.log("  and commit, or the deployed app will not have them:\n");
  for (const l of onlyInDev) console.log(`    + ${l}`);
}

if (onlyInProd.length) {
  console.log("\n  In production but NOT in dev - your dev app is behind, so you are");
  console.log("  testing against something production does not look like:\n");
  for (const l of onlyInProd) console.log(`    - ${l}`);
}

console.log("");
// Non-zero so this can gate a deploy in a script later.
process.exit(1);
