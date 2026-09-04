import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { destroyAdminSession } from "../lib/admin/admin-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";

// Sign out of the admin surface (spec 19). POST only for the real
// logout; a stray GET just bounces to the login page.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) throw redirect("/admin/login");
  const headers = await destroyAdminSession(request);
  throw redirect("/admin/login", { headers });
};

export const loader = async (_: LoaderFunctionArgs) => {
  throw redirect("/admin/login");
};
