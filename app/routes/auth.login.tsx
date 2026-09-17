import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { login } from "../shopify.server";

// The Shopify library treats /auth/login as its configured login path, so the
// auth.$ splat cannot serve it — authenticate.admin() refuses and the route
// 500s on a public URL (QA routing audit).
//
// Redirect-only (QA-C1): there is no store-domain form anywhere (App Store
// requirement 2.3.1). With ?shop=… (a library bounce) login() throws a redirect
// to the managed-install screen; without one we send the visitor to "/", which
// points to the App Store listing. No action — nothing here accepts a typed domain.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) await login(request);
  return redirect("/");
};
