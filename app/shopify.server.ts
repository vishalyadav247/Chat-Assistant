import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { env } from "./lib/env.server";

env(); // validate environment at boot — fail fast on misconfiguration

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ session }) => {
      // On install (and token refresh): ensure the shop row + default config,
      // then kick the initial catalog sync. Lazy imports avoid a require cycle
      // (these modules import authenticate/unauthenticated from this file).
      const { onShopAuthenticated } = await import("./lib/install.server");
      await onShopAuthenticated(session.shop);
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
// Shop-domain login — powers the "Log in with your store" card on the public
// landing page (`app/routes/_index`).
//
// This was removed on 2026-08-21 citing "App Store review requirement 2.3.1 —
// no manual .myshopify.com entry". That citation was never verifiable: the QA
// note recording it already flagged that a shopify.dev search could not find
// the rule, and a second search on 2026-09-07 found nothing either. What does
// exist is Shopify's own app template, which ships this exact form and
// documents `shopify.login` as the supported way to build it. Restored on the
// user's call — see the PROGRESS.md decisions entry for 2026-09-07.
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
