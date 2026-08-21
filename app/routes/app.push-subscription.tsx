import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { requireWebSurface } from "../lib/access.server";
import { hasFeature } from "../lib/billing/plans.server";

// Web Push subscription store (spec 18). Web surface only — the browser posts
// PushSubscription.toJSON() after permission is granted; DELETE drops it.

/** Push-service endpoints are https capability URLs on public hosts. Reject
 *  anything that could turn the send job into an SSRF vector. */
function acceptableEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return false; // localhost, single-label internal names
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return false; // IP literals
  if (/\.(local|internal|lan|localhost|home|corp)$/.test(host)) return false;
  return true;
}

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000).refine(acceptableEndpoint, "unsupported push endpoint"),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(200) }),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, member } = await requireWebSurface(request);
  const body = await request.json().catch(() => null);

  if (request.method === "DELETE") {
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (endpoint) await db.pushSubscription.deleteMany({ where: { shopId, memberId: member.id, endpoint } });
    return { ok: true };
  }

  // Browser push is a Basic+ feature (spec 15). DELETE stays ungated above so a
  // downgraded shop can always unsubscribe an existing browser; only NEW
  // subscriptions are blocked (spec 15 downgrade rule).
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  if (!hasFeature(shop?.plan ?? "free", "push_notifications")) {
    return new Response("not available on this plan", { status: 403 });
  }

  const parsed = subscriptionSchema.safeParse(body);
  if (!parsed.success) return new Response("bad request", { status: 400 });
  const sub = parsed.data;
  // Endpoints are globally unique — if another member (or shop) held this
  // endpoint, the browser now belongs to this member.
  await db.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: {
      shopId,
      memberId: member.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    },
    update: {
      shopId,
      memberId: member.id,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      failedAt: null,
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    },
  });
  return { ok: true };
};

export const loader = async () => new Response("Method Not Allowed", { status: 405 });

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
