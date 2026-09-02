// Guarded `shopify app deploy`.  npm run deploy:prod   /   npm run config:which
//
// `shopify app deploy` publishes to whichever app the CLI currently has
// SELECTED — and that selection is machine-local CLI state, not something in
// this repo. `.shopify/project.json` holds only dev-store URLs; nothing in git
// records which app you are pointed at. So the selection survives across
// sessions, is invisible in a diff, and is left pointing at the DEV app every
// time you finish a day of `npm run dev`.
//
// That is the whole hazard: an unguarded `npm run deploy` intended for
// production silently publishes a version of the DEV app instead. Nothing
// fails, nothing warns, and production merchants simply never receive the
// change. (Checked 2026-09-02: the CLI was on shopify.app.dev.toml.)
//
// This script removes the guesswork. It reads the intended client_id out of the
// production toml and passes it as --client-id, so the CLI itself refuses the
// deploy if the selection disagrees. Belt and braces: it also refuses locally,
// with a readable message, before spending a round trip.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PROD = path.join(ROOT, "shopify.app.toml");
const DEV = path.join(ROOT, "shopify.app.dev.toml");

const field = (text, key) => (new RegExp(`^${key} = "(.+)"$`, "m").exec(text) || [])[1];

function readToml(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
  return { clientId: field(text, "client_id"), name: field(text, "name"), text };
}

// `shopify app info` is read-only and reports the ACTIVE configuration —
// the only trustworthy source, since the selection is not in the repo.
function activeConfig() {
  const res = spawnSync("npx shopify app info --no-color", {
    cwd: ROOT,
    shell: true,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const pick = (label) => {
    const m = new RegExp(`${label}\\s+(\\S+)`).exec(out);
    return m ? m[1] : null;
  };
  return {
    ok: res.status === 0,
    file: pick("Configuration file"),
    clientId: pick("Client ID"),
    appName: (/App name\s+(.+?)\s*(?:│|$)/m.exec(out) || [])[1]?.trim() || null,
    raw: out,
  };
}

const prod = readToml(PROD);
const dev = readToml(DEV);
if (!prod) {
  console.error("  shopify.app.toml not found.");
  process.exit(1);
}

// `npm run deploy` maps here in --choose mode rather than deploying anything.
//
// The bare name is ambiguous: this repo has two Shopify apps, and roughly
// fifteen places in README.md / CLAUDE.md / APP-STORE-REVIEW.md say "npm run
// deploy" without saying which. Some of those passages mean the dev app, some
// mean production. Silently picking one would make every stale instruction
// wrong in a way that produces no error - so this stops and asks instead.
const mode =
  process.argv[2] === "--which" ? "which" :
  process.argv[2] === "--choose" ? "choose" : "deploy";

console.log("  asking the CLI which app is selected...\n");
const active = activeConfig();

if (!active.ok || !active.clientId) {
  console.error("  could not read `shopify app info`. Are you logged in? Try: npx shopify app info");
  console.error(active.raw.split("\n").slice(-12).join("\n"));
  process.exit(1);
}

const label = (id) =>
  id === prod.clientId ? "PRODUCTION" : dev && id === dev.clientId ? "dev" : "UNKNOWN";

console.log(`  active config file : ${active.file}`);
console.log(`  app name           : ${active.appName}`);
console.log(`  client id          : ${active.clientId}  <- ${label(active.clientId)}`);
console.log("");
console.log(`  production is      : ${prod.clientId}  (${prod.name})`);
if (dev) console.log(`  dev is             : ${dev.clientId}  (${dev.name})`);
console.log("");

if (mode === "which") {
  console.log("  To switch:");
  console.log("    npm run config:use -- shopify.app.toml       (production)");
  console.log("    npm run config:use -- dev                    (dev)");
  process.exit(0);
}

if (mode === "choose") {
  console.error("  `npm run deploy` is ambiguous in this repo - say which app:");
  console.error("");
  console.error("    npm run deploy:prod -- \"message\"   publish to PRODUCTION");
  console.error("                                        (guarded: verifies the selected");
  console.error("                                         config and pins --client-id)");
  console.error("");
  console.error("    npm run dev:push-proxy              publish to the DEV app");
  console.error("                                        (after the tunnel hostname changes)");
  console.error("");
  console.error("  Older notes in README.md and CLAUDE.md still say `npm run deploy`.");
  console.error("  Read which app the surrounding passage means, then use one of the above.");
  process.exit(1);
}

if (active.clientId !== prod.clientId) {
  console.error("  REFUSING: the CLI is not pointed at the production app.");
  console.error("");
  console.error("  Switch first, then re-run:");
  console.error("    npm run config:use -- shopify.app.toml");
  console.error("    npm run deploy:prod");
  process.exit(1);
}

// A tunnel URL in the production toml means a dev session wrote to the wrong
// file. Deploying that would repoint the live app at a dead hostname.
const stray = /trycloudflare|ngrok|localhost/.exec(prod.text);
if (stray) {
  console.error(`  REFUSING: shopify.app.toml contains "${stray[0]}" - a dev tunnel leaked into`);
  console.error("  the production config. Revert that change before deploying.");
  process.exit(1);
}

const message = process.argv.slice(2).filter((a) => a !== "--which").join(" ").trim();
const args = [
  "npx shopify app deploy",
  `--client-id ${prod.clientId}`,
  message ? `--message "${message.replace(/"/g, "'")}"` : "",
]
  .filter(Boolean)
  .join(" ");

console.log(`  deploying to PRODUCTION (${prod.name})`);
console.log(`  $ ${args}\n`);

// One command STRING with shell:true - on Windows an argv array with
// shell:true is not quoted, so a --message with spaces arrives as separate
// arguments and the CLI rejects it.
const res = spawnSync(args, { cwd: ROOT, stdio: "inherit", shell: true });
process.exit(res.status ?? 1);
