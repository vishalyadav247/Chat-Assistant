import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { destroyPlatformSession } from "../lib/platform/platform-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";

// Sign out of the platform admin surface (spec 19). POST only for the real
// logout; a stray GET just bounces to the login page.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) throw redirect("/platform/login");
  const headers = await destroyPlatformSession(request);
  throw redirect("/platform/login", { headers });
};

export const loader = async (_: LoaderFunctionArgs) => {
  throw redirect("/platform/login");
};
