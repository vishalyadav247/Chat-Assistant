import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminSurface } from "../lib/access.server";
import { ensureOwnerMember, mintHandoffToken, webBaseUrl } from "../lib/team/team.server";

// Admin → web handoff (spec 18). Only reachable from the embedded admin
// (authenticate.admin behind requireAdminSurface): creates/refreshes the owner
// TeamMember row and mints a 2-minute single-use token the new tab exchanges
// for a web session at /web/handoff.

export const action = async ({ request }: ActionFunctionArgs) => {
  const access = await requireAdminSurface(request);
  try {
    const owner = await ensureOwnerMember(access.shopId, access.shopDomain);
    const token = await mintHandoffToken(access.shopId, owner.id, request.headers.get("user-agent"));
    return { ok: true as const, url: `${webBaseUrl()}/web/handoff?t=${encodeURIComponent(token)}` };
  } catch (error) {
    console.error("web_handoff_error", error);
    return { ok: false as const, error: "Couldn't prepare the web session. Try again." };
  }
};

export const loader = async () => new Response("Method Not Allowed", { status: 405 });

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
