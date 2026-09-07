import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { login } from "../shopify.server";

// The Shopify library treats /auth/login as its configured login path, so the
// auth.$ splat cannot serve it — authenticate.admin() refuses and the route
// 500s on a public URL (QA routing audit).
//
// The login UI itself lives on "/" (one card, one place). This route only has
// to handle the library bouncing here, and stale bookmarks:
//
//   • with ?shop=… — login() throws a redirect to the managed-install screen,
//     so the install completes instead of dead-ending;
//   • without one — login() returns {} and we send them to the card on "/".
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await login(request);
  return redirect("/");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await login(request);
  return redirect("/");
};
