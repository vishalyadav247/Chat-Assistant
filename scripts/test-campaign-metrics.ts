/* Proactive-chat metrics test (spec 12 acceptance 4).
 * Verifies recordCampaignMetric increments the shop-scoped Campaign counters
 * (views/clicks/atcs/revenue) and that the dashboard CTR math matches.
 * Also proves tenancy: a metric recorded with the WRONG shopId is a no-op.
 * Needs the dev DB + seeded shop: npm run db:up && npx prisma db seed.
 * Run: npx tsx scripts/test-campaign-metrics.ts (exit 1 on failure).
 */
import db from "../app/db.server";
import {
  activeCampaignsForWidget,
  recordCampaignMetric,
  saveCampaign,
} from "../app/lib/campaigns/campaigns.server";

const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const shop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN } });
  if (!shop) throw new Error(`seed first: shop ${DEV_SHOP_DOMAIN} not found (npx prisma db seed)`);
  const shopId = shop.id;

  // Revenue is recomputed SERVER-SIDE from the campaign's own product mirror
  // (cheapest in-stock price) — client beacon numbers are ignored (review m4).
  const cheapProduct = await db.product.findFirst({
    where: { shopId, stock: { gt: 0 } },
    orderBy: { price: "asc" },
    select: { shopifyProductId: true, price: true },
  });
  if (!cheapProduct) throw new Error("seed products first");
  const expectedRevenue = Number(cheapProduct.price);

  const saved = await saveCampaign(shopId, shop.plan, {
    name: "metrics-test campaign",
    templateType: "welcome",
    status: "active",
    settings: {
      trigger: { pageTypes: ["home"], delaySeconds: 0 },
      message: "hi",
      ctaLabel: "Say hello",
      productIds: [cheapProduct.shopifyProductId],
    },
  });
  if (!saved.ok) throw new Error(`saveCampaign failed: ${saved.error}`);
  const id = saved.id;

  try {
    await recordCampaignMetric(shopId, id, "view");
    await recordCampaignMetric(shopId, id, "view");
    await recordCampaignMetric(shopId, id, "view");
    await recordCampaignMetric(shopId, id, "click");
    await recordCampaignMetric(shopId, id, "atc", 999999); // client value must be IGNORED

    let row = await db.campaign.findFirst({ where: { id, shopId } });
    if (!row) throw new Error("campaign row vanished");
    check("views incremented", row.views === 3, `views=${row.views}`);
    check("clicks incremented", row.clicks === 1, `clicks=${row.clicks}`);
    check("atcs incremented", row.atcs === 1, `atcs=${row.atcs}`);
    check(
      "revenue = server-side product price (client number ignored)",
      Number(row.revenue) === expectedRevenue,
      `revenue=${row.revenue} expected=${expectedRevenue}`,
    );

    // CTR math shown on the dashboard: clicks/views as a 2-decimal %.
    const ctr = row.views > 0 ? (row.clicks / row.views) * 100 : 0;
    check("CTR math (1 click / 3 views)", ctr.toFixed(2) === "33.33", `ctr=${ctr.toFixed(2)}%`);

    // Tenancy: wrong shopId must be a silent no-op.
    await recordCampaignMetric("not-the-shop", id, "view");
    row = await db.campaign.findFirst({ where: { id, shopId } });
    check("wrong shopId is a no-op", row?.views === 3, `views=${row?.views}`);

    // Widget projection includes the active campaign in lean shape.
    const widgetCampaigns = await activeCampaignsForWidget(shopId, shop.plan);
    const mine = widgetCampaigns.find((c) => c.id === id);
    check("active campaign served to widget", Boolean(mine));
    check(
      "lean shape (no counters/name leaked)",
      Boolean(mine) && !("views" in (mine as object)) && !("name" in (mine as object)),
    );
  } finally {
    await db.campaign.deleteMany({ where: { id, shopId } });
  }

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} metric check(s) failed.`);
    process.exit(1);
  }
  console.log("OK: campaign metric checks passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
