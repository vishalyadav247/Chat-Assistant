import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { destroyWebSession } from "../lib/team/web-session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const headers = await destroyWebSession(request);
  throw redirect("/web/login", { headers });
};

// GET also signs out (handy for the notification service worker / bookmarks).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const headers = await destroyWebSession(request);
  throw redirect("/web/login", { headers });
};
