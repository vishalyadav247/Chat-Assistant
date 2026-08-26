import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { logWarn } from "../log.server";

// Recent orders for the Inbox details pane (spec 10).
//
// The row used to be hard-coded to "No info" for every conversation, so a
// merchant expanded it on each chat and learned nothing. It is populated from
// the Admin API using read_orders, a scope this app already holds for the
// in-widget order lookup.
//
// DATA MINIMISATION (protected customer data, level 2): this deliberately
// selects only what the merchant already sees on their own Orders list —
// number, date, status, total. It does NOT read the shipping address, the
// customer's phone, or line items. Nothing here is stored; it is fetched per
// view and rendered.

export interface RecentOrder {
  id: string;
  name: string;
  processedAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  total: string;
  currency: string;
  /** Deep link into the merchant's own admin. */
  adminUrl: string;
}

const RECENT_ORDERS_QUERY = `#graphql
  query InboxRecentOrders($search: String!) {
    orders(first: 5, query: $search, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        processedAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

interface OrdersResponse {
  data?: {
    orders?: {
      nodes?: Array<{
        id: string;
        name: string;
        processedAt: string | null;
        displayFinancialStatus: string | null;
        displayFulfillmentStatus: string | null;
        currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
      }>;
    };
  };
}

/**
 * Build the Shopify order search term for a contact.
 *
 * Returns null when we have nothing to match on — an anonymous visitor who has
 * never given an email has no orders to show, and querying on an empty string
 * would return the shop's most recent orders, i.e. SOMEONE ELSE'S data.
 */
function searchTermFor(contact: { email: string | null; shopifyCustomerId: string | null }): string | null {
  if (contact.shopifyCustomerId) {
    // gid://shopify/Customer/123 → 123; the orders query matches the numeric id.
    const numeric = contact.shopifyCustomerId.split("/").pop();
    if (numeric && /^\d+$/.test(numeric)) return `customer_id:${numeric}`;
  }
  const email = contact.email?.trim();
  if (email) return `email:${JSON.stringify(email)}`;
  return null;
}

/**
 * Up to 5 recent orders for this contact, or [] when there is nothing to look
 * up. Never throws: the details pane must render even if Shopify is unreachable
 * or the scope was declined.
 */
export async function recentOrdersForContact(
  admin: AdminApiContext | null,
  contact: { email: string | null; shopifyCustomerId: string | null } | null,
  shopDomain: string,
): Promise<RecentOrder[]> {
  if (!admin || !contact) return [];
  const search = searchTermFor(contact);
  if (!search) return [];

  try {
    const response = await admin.graphql(RECENT_ORDERS_QUERY, { variables: { search } });
    const body = (await response.json()) as OrdersResponse;
    const store = shopDomain.replace(/\.myshopify\.com$/, "");
    return (body.data?.orders?.nodes ?? []).map((node) => ({
      id: node.id,
      name: node.name,
      processedAt: node.processedAt,
      financialStatus: node.displayFinancialStatus,
      fulfillmentStatus: node.displayFulfillmentStatus,
      total: node.currentTotalPriceSet?.shopMoney?.amount ?? "0",
      currency: node.currentTotalPriceSet?.shopMoney?.currencyCode ?? "USD",
      adminUrl: `https://admin.shopify.com/store/${store}/orders/${node.id.split("/").pop()}`,
    }));
  } catch (error) {
    // A declined scope, a throttle or a network blip must degrade to "no info",
    // never to a broken inbox.
    logWarn("inbox_recent_orders_failed", error instanceof Error ? error.message : String(error), {
      shopDomain,
    });
    return [];
  }
}
