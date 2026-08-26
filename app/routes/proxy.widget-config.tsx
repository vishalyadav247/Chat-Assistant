import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShopId } from "../lib/tenancy.server";
import { buildWidgetConfig } from "../lib/widget/config.server";
import { touchWidgetSeen } from "../lib/embed-status.server";

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
  // Only the theme app embed makes this request, so reaching this line proves
  // the embed is live on the published theme — the signal Settings needs and
  // that would otherwise cost the read_themes scope. Fire-and-forget and
  // throttled to once an hour, so a busy storefront does not turn a cached GET
  // into a write per page view.
  void touchWidgetSeen(shopId);
  const payload = await buildWidgetConfig(shopId, session.shop);

  return Response.json(payload, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
};
