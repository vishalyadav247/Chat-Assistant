import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { readWebSession } from "../lib/team/web-session.server";

// /web → inbox when signed in, otherwise the login page.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await readWebSession(request);
  throw redirect(session ? "/app/inbox" : "/web/login");
};
