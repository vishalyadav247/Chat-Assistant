import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShopId } from "../lib/tenancy.server";
import { buildWidgetConfig } from "../lib/widget/config.server";

// GET /apps/chatconvert/widget-config — the widget boot payload (spec 05).
// Shop identity comes ONLY from the verified proxy signature. Uninstalled
// app → Shopify stops proxying / session is null → 404 → widget renders
// nothing (silently).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("app not installed", { status: 404 });
  }

  const shopId = await resolveShopId(session.shop);
  const payload = await buildWidgetConfig(shopId, session.shop);

  return Response.json(payload, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
};
