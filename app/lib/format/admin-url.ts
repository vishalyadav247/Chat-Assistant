// Deep links back into the Shopify admin. Pure + browser-safe: the web shell
// (no App Bridge) builds one on the client, the billing flow builds one on the
// server, and they must agree.
//
// The distinction that matters is the API key. `/store/{store}/apps` is the
// merchant's APP LIST — landing there means "we lost you", not "here is the
// app". `/store/{store}/apps/{apiKey}` opens THIS app embedded, which is what
// every "open in admin" affordance means. The bare list survives only as the
// fallback for when the key is unavailable (tests, a missing env var), because
// a URL ending in `/apps/` would 404.

/** Store handle for admin.shopify.com — "acme" from "acme.myshopify.com". */
export function storeHandle(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

/**
 * URL of this app inside the Shopify admin.
 *
 * @param shopDomain the *.myshopify.com domain
 * @param apiKey     SHOPIFY_API_KEY; "" falls back to the app list
 * @param path       optional in-app path, e.g. "/app/plan-usage"
 */
export function adminAppUrl(shopDomain: string, apiKey: string, path = ""): string {
  const base = `https://admin.shopify.com/store/${storeHandle(shopDomain)}`;
  return apiKey ? `${base}/apps/${apiKey}${path}` : `${base}/apps`;
}
