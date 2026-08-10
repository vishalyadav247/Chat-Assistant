import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { recordEvent } from "../analytics/events.server";

// Stock revalidation (spec 09): check each published answer's productIds
// against the product mirror; missing or zero-stock products flag the answer
// (stockIssue → "Needs attention" KPI + row pill). Pure importable function —
// called by the page action's "Revalidate stock" button today; the jobs
// orchestrator wires the same function to a daily job.

export interface RevalidateResult {
  checked: number;
  flagged: number; // newly flagged this run
  cleared: number; // previously flagged, now healthy
  issueCount: number; // total answers with stockIssue after this run
}

export async function revalidateCuratedStock(shopId: string): Promise<RevalidateResult> {
  requireShopId(shopId);
  const answers = await db.curatedAnswer.findMany({
    where: { shopId, status: "published" },
    select: { id: true, productIds: true, stockIssue: true },
  });

  const allIds = [...new Set(answers.flatMap((a) => a.productIds))];
  const products = allIds.length
    ? await db.product.findMany({
        where: { shopId, shopifyProductId: { in: allIds } },
        select: { shopifyProductId: true, stock: true },
      })
    : [];
  const stockByGid = new Map(products.map((p) => [p.shopifyProductId, p.stock]));

  let flagged = 0;
  let cleared = 0;
  let issueCount = 0;
  for (const answer of answers) {
    // Missing from the mirror (deleted product) reads as stock 0.
    const issue =
      answer.productIds.length > 0 &&
      answer.productIds.some((gid) => (stockByGid.get(gid) ?? 0) <= 0);
    if (issue) issueCount += 1;
    if (issue === answer.stockIssue) continue;
    await db.curatedAnswer.updateMany({
      where: { id: answer.id, shopId },
      data: { stockIssue: issue },
    });
    if (issue) {
      flagged += 1;
      await recordEvent(shopId, "curated_stock_flagged", { curatedId: answer.id });
    } else {
      cleared += 1;
    }
  }

  return { checked: answers.length, flagged, cleared, issueCount };
}
