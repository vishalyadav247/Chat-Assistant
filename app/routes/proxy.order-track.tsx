import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { resolveShopId } from "../lib/tenancy.server";
import { loadShopSettings } from "../lib/settings/save.server";
import { get17TrackShipment, type ShipmentInfo } from "../lib/tracking/seventeen-track.server";
import { logError } from "../lib/log.server";

// POST /apps/chatconvert/order-track — in-widget order status (spec 05 delta).
// The shopper proves ownership with order number + the email/phone on the
// order; no login. Shop identity comes ONLY from the verified proxy signature.
// Response is a minimal status subset — never the order's own email/phone/
// address (the shopper already typed the contact; echoing the order's copy
// back would leak PII to anyone who guesses a number).

// ── Lookup throttle (in-memory token bucket, shop + client IP) ─────────────
declare global {
  // eslint-disable-next-line no-var
  var orderTrackBuckets: Map<string, { tokens: number; at: number }> | undefined;
}
const TRACK_CAPACITY = 8;
const TRACK_REFILL_PER_MS = 8 / 60_000; // 8 lookups per minute

function consumeTrackToken(key: string): boolean {
  if (!global.orderTrackBuckets) global.orderTrackBuckets = new Map();
  const now = Date.now();
  const bucket = global.orderTrackBuckets.get(key) ?? { tokens: TRACK_CAPACITY, at: now };
  bucket.tokens = Math.min(
    TRACK_CAPACITY,
    bucket.tokens + (now - bucket.at) * TRACK_REFILL_PER_MS,
  );
  bucket.at = now;
  global.orderTrackBuckets.set(key, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  if (global.orderTrackBuckets.size > 10_000) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [k, b] of global.orderTrackBuckets) {
      if (b.at < cutoff) global.orderTrackBuckets.delete(k);
    }
  }
  return true;
}

const bodySchema = z.union([
  // Order-number lookup: ownership proven by the contact on the order.
  z.object({
    orderNumber: z.string().min(1).max(64),
    method: z.enum(["email", "phone"]),
    contact: z.string().min(3).max(200),
  }),
  // Bare tracking-number lookup: integration mode only (real-time provider).
  z.object({ trackingNumber: z.string().min(4).max(64) }),
]);

const ORDER_QUERY = `#graphql
  query OrderTrack($search: String!) {
    orders(first: 20, query: $search, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        createdAt
        displayFulfillmentStatus
        email
        phone
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress { phone }
        lineItems(first: 10) {
          nodes { title quantity image { url(transform: { maxWidth: 96, maxHeight: 96 }) } }
        }
        fulfillments(first: 5) {
          createdAt
          updatedAt
          displayStatus
          trackingInfo(first: 5) { company number url }
        }
      }
    }
  }
`;

interface OrderNode {
  name: string;
  createdAt: string;
  displayFulfillmentStatus: string;
  email: string | null;
  phone: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  shippingAddress: { phone: string | null } | null;
  lineItems: { nodes: Array<{ title: string; quantity: number; image: { url: string } | null }> };
  fulfillments: Array<{
    createdAt: string;
    updatedAt: string;
    displayStatus: string | null;
    trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
  }>;
}

/** Order names carry merchant-configured prefixes/suffixes ("#24-25/JGW-1113")
 *  while shoppers type "1113" — compare alphanumerics only, suffix match. */
const alnum = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
const digits = (s: string) => s.replace(/\D/g, "");
/** Search-syntax safety: the value is embedded in a Shopify search string. */
const sanitizeTerm = (s: string) => s.replace(/["\\()]/g, "").trim();

function numberMatches(orderName: string, input: string): boolean {
  const name = alnum(orderName);
  const want = alnum(input);
  if (!want) return false;
  // A 2-char suffix matched far too many orders, which made guessing cheap
  // (QA D13). Require the whole number or a a substantial suffix.
  return name === want || (want.length >= 4 && name.endsWith(want));
}

function contactMatches(order: OrderNode, method: "email" | "phone", contact: string): boolean {
  if (method === "email") {
    return Boolean(order.email) && order.email!.trim().toLowerCase() === contact.trim().toLowerCase();
  }
  const want = digits(contact);
  // A 7-digit tail is a ~10^7 guess space against an unauthenticated endpoint;
  // require a full national number so the check is real (QA D13).
  if (want.length < 10) return false;
  return [order.phone, order.shippingAddress?.phone].some((candidate) => {
    const have = digits(candidate || "");
    if (have.length < 10) return false;
    // Country-code tolerant: compare the last 10 digits.
    return have.slice(-10) === want.slice(-10);
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) {
    return new Response("app not installed", { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }
  const noStore = { headers: { "Cache-Control": "no-store" } };

  // Unauthenticated + hits the Admin API + returns order facts: without a
  // throttle an attacker can brute-force order numbers / phone tails (QA D13).
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (!consumeTrackToken(`${session.shop}:${clientIp}`)) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 429, ...noStore });
  }

  const shopId = await resolveShopId(session.shop);
  const settings = await loadShopSettings(shopId);
  const tracking = settings.orderTracking;
  const integrated = tracking.mode === "integration" && Boolean(tracking.apiKey);

  // ── Bare tracking number (integration mode only) ─────────────────────────
  // Real-time provider status card. Custom mode opens the merchant's tracking
  // URL client-side; default mode has no tracking-number form at all.
  if ("trackingNumber" in parsed.data) {
    if (!integrated) {
      return Response.json({ ok: false, error: "unsupported" }, noStore);
    }
    const shipment = await get17TrackShipment(tracking.apiKey, parsed.data.trackingNumber);
    if (!shipment) {
      return Response.json({ ok: false, error: "not_found" }, noStore);
    }
    return Response.json({ ok: true, shipment }, noStore);
  }

  const { orderNumber, method, contact } = parsed.data;

  const fetchOrders = async (search: string): Promise<OrderNode[]> => {
    const response = await admin.graphql(ORDER_QUERY, { variables: { search } });
    const body = (await response.json()) as { data?: { orders?: { nodes: OrderNode[] } } };
    return body.data?.orders?.nodes ?? [];
  };

  try {
    // Email search survives exotic order-name prefixes; name search covers the
    // phone method (order search has no phone filter). Contact is ALWAYS
    // re-verified against the order itself — the search is just retrieval.
    const primary =
      method === "email"
        ? `email:${sanitizeTerm(contact)}`
        : `name:${sanitizeTerm(orderNumber)}`;
    let candidates = await fetchOrders(primary);
    let match = candidates.find(
      (o) => numberMatches(o.name, orderNumber) && contactMatches(o, method, contact),
    );
    if (!match && method === "email") {
      candidates = await fetchOrders(`name:${sanitizeTerm(orderNumber)}`);
      match = candidates.find(
        (o) => numberMatches(o.name, orderNumber) && contactMatches(o, method, contact),
      );
    }

    if (!match) {
      return Response.json({ ok: false, error: "not_found" }, noStore);
    }

    // Integration mode: enrich with the provider's real-time status for the
    // first fulfillment that has a tracking number (best-effort).
    let shipment: ShipmentInfo | null = null;
    if (integrated) {
      const trackedNumber = match.fulfillments
        .map((f) => f.trackingInfo[0]?.number)
        .find((n): n is string => Boolean(n));
      if (trackedNumber) {
        shipment = await get17TrackShipment(tracking.apiKey, trackedNumber).catch(() => null);
      }
    }

    return Response.json(
      {
        ok: true,
        order: {
          name: match.name,
          status: match.displayFulfillmentStatus,
          createdAt: match.createdAt,
          total: match.totalPriceSet.shopMoney.amount,
          currency: match.totalPriceSet.shopMoney.currencyCode,
          itemsCount: match.lineItems.nodes.reduce((sum, li) => sum + li.quantity, 0),
          items: match.lineItems.nodes.map((li) => ({
            title: li.title,
            quantity: li.quantity,
            image: li.image?.url ?? null,
          })),
          fulfillments: match.fulfillments.map((f) => ({
            status: f.displayStatus,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
            company: f.trackingInfo[0]?.company ?? null,
            trackingNumber: f.trackingInfo[0]?.number ?? null,
            trackingUrl: f.trackingInfo[0]?.url ?? null,
          })),
          shipment,
        },
      },
      noStore,
    );
  } catch (error) {
    // Missing scope / protected-customer-data not granted / API hiccup —
    // degrade to a soft failure the widget can message. Log just the GraphQL
    // error messages (the client's thrown object embeds the whole response).
    const gqlErrors = (
      error as { body?: { errors?: { graphQLErrors?: Array<{ message?: string }> } } }
    ).body?.errors?.graphQLErrors;
    logError(
      "order_track_lookup_failed",
      gqlErrors?.map((e) => e.message).join(" | ") ||
        (error instanceof Error ? error.message : error),
    );
    return Response.json({ ok: false, error: "unavailable" }, noStore);
  }
};
