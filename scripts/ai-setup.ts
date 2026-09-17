/* AI setup for existing stores (spec 26): writes Instructions → General from
 * each store's own Shopify data — only into fields still at their defaults or
 * last written by AI; merchant edits are kept.
 *
 *   npm run ai-setup -- --shop my-store.myshopify.com            run now
 *   npm run ai-setup -- --shop my-store.myshopify.com --force    run again after a previous run
 *   npm run ai-setup -- --all [--force]                          every installed store
 *
 * Runs inline (no queue worker needed). Costs one gpt-4.1 call per store.
 */
export {};

try {
  process.loadEnvFile(".env");
} catch {
  // ambient environment
}

async function main() {
  const args = process.argv.slice(2);
  const shopIndex = args.indexOf("--shop");
  const force = args.includes("--force");
  const all = args.includes("--all");
  const { default: db } = await import("../app/db.server");
  const { runAiSetup } = await import("../app/lib/instructions/ai-setup.server");

  const domains =
    shopIndex >= 0 && args[shopIndex + 1]
      ? [args[shopIndex + 1]]
      : all
        ? (await db.shop.findMany({ where: { uninstalledAt: null }, select: { domain: true } }))
            .map((s) => s.domain)
            .filter((d) => !d.startsWith("qa-"))
        : [];
  if (domains.length === 0) {
    console.log("usage: npm run ai-setup -- --shop <domain> | --all [--force]");
    process.exit(1);
  }
  for (const domain of domains) {
    const result = await runAiSetup(domain, { force });
    console.log(`${domain}: ${JSON.stringify(result)}`);
  }
  await db.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
