import "dotenv/config";
// shopify.server refuses to import without an appUrl; the CLI injects it only
// into the dev-server process. These stubs exist purely to satisfy that import
// — the job is executed by the dev server's worker with the CLI's real values.
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SHOPIFY_API_KEY ||= "d8b180fa8bf4edbda15692d2652516d7";
process.env.SHOPIFY_API_SECRET ||= "placeholder-not-used-for-enqueue";
process.env.SCOPES ||= "read_products";

const run = async () => {
  const db = (await import("../../app/db.server")).default;
  try {
    const { enqueue } = await import("../../app/lib/jobs/queue.server");
    await enqueue("catalog-sync", { shopDomain: "jgw-check.myshopify.com" });
    console.log("enqueued catalog-sync");
  } catch (e) {
    console.error("enqueue failed:", e instanceof Error ? e.message : e);
  } finally {
    await db.$disconnect();
  }
};
void run();
