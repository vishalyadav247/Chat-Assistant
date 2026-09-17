import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { requireShopAccess } from "../lib/access.server";
import { tableMetadata, TABLE_SOURCE_TYPE } from "../lib/lookup/lookup-import.server";

// GET /app/lookup-download?id=… — the CSV a lookup table was uploaded from
// (spec 28, Edit lookup table → Download CSV). Resource route: shop-scoped,
// same permission as the Training page. The file is stored gzipped, so it is
// sent as-is with Content-Encoding: gzip and the browser inflates it — a
// 100MB table never has to be decompressed on the server.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "ai_agent" });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const source = await db.dataSource.findFirst({
    where: { id, shopId, type: TABLE_SOURCE_TYPE },
    select: { id: true, name: true, metadata: true },
  });
  const file = source
    ? await db.lookupFile.findFirst({ where: { dataSourceId: source.id, shopId }, select: { gzip: true } })
    : null;
  if (!source || !file) return new Response("Not found", { status: 404 });

  const uploaded = tableMetadata(source.metadata).filename;
  const base = (uploaded || source.name).replace(/\.csv$/i, "").replace(/[^\w.\- ]+/g, "_").trim() || "table";
  return new Response(new Uint8Array(file.gzip), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Disposition": `attachment; filename="${base}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
