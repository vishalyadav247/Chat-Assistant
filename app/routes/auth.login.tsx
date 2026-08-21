import { redirect } from "react-router";

// The Shopify library treats /auth/login as its configured login path, so the
// auth.$ splat cannot serve it — authenticate.admin() refuses and the route
// 500s on a public URL (QA routing audit).
//
// The template's shop-domain form that used to live here was removed
// deliberately: App Store review requirement 2.3.1 forbids asking a merchant to
// type their .myshopify.com domain. Installation happens through the App Store
// listing, and Shopify bounces merchants into /?shop=… which _index redirects
// to /app. So this path has no legitimate UI — send anyone who lands here to
// the marketing page instead of showing them a stack trace.
//
// Do NOT re-add a shop-domain input here.
export const loader = () => redirect("/");
export const action = () => redirect("/");
