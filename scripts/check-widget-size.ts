/* Widget size budget check (spec 05 performance rule).
 * The INITIAL storefront payload — chat-widget.js — must gzip to ≤30KB.
 * Renderer/transport are lazy-loaded on first click and only reported.
 * Run: npm run widget:size (exit 1 when over budget).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ASSETS_DIR = join(process.cwd(), "extensions", "chat-widget", "assets");
const INITIAL_ASSET = "chat-widget.js";
const BUDGET_BYTES = 30 * 1024;

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(2) + " KB";
}

const files = readdirSync(ASSETS_DIR).filter((f) => /\.(js|css)$/.test(f)).sort();
if (files.length === 0) {
  console.error(`No widget assets found in ${ASSETS_DIR}`);
  process.exit(1);
}

let initialGzip = -1;
console.log("ChatConvert widget asset sizes (gzip level 9):\n");
for (const file of files) {
  const raw = readFileSync(join(ASSETS_DIR, file));
  const gz = gzipSync(raw, { level: 9 }).length;
  if (file === INITIAL_ASSET) initialGzip = gz;
  const marker = file === INITIAL_ASSET ? "  ← initial payload" : "";
  console.log(`  ${file.padEnd(22)} raw ${kb(raw.length).padStart(10)}   gzip ${kb(gz).padStart(10)}${marker}`);
}

console.log();
if (initialGzip < 0) {
  console.error(`Missing initial asset ${INITIAL_ASSET}`);
  process.exit(1);
}
if (initialGzip > BUDGET_BYTES) {
  console.error(`FAIL: ${INITIAL_ASSET} gzips to ${kb(initialGzip)} — over the ${kb(BUDGET_BYTES)} budget.`);
  process.exit(1);
}
console.log(`OK: ${INITIAL_ASSET} gzips to ${kb(initialGzip)} (budget ${kb(BUDGET_BYTES)}).`);
