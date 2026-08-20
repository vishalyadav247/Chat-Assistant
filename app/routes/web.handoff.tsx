import type { LoaderFunctionArgs } from "react-router";
import { Link, redirect, useLoaderData } from "react-router";
import { AuthCard } from "../components/web/AuthCard";
import { consumeHandoffToken } from "../lib/team/team.server";
import { createWebSession } from "../lib/team/web-session.server";

// Admin → web handoff landing (spec 18): exchanges the one-time token minted
// by /app/web-handoff for a web session cookie, then lands on the inbox.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const result = token ? await consumeHandoffToken(token) : null;
  if (!result) return { ok: false as const };
  const { headers } = await createWebSession({ request, shopId: result.shopId, memberId: result.member.id });
  throw redirect("/app/inbox", { headers });
};

export default function WebHandoff() {
  useLoaderData<typeof loader>();
  return (
    <AuthCard
      title="This link has expired"
      subtitle="Handoff links from the Shopify admin are single-use and valid for two minutes."
      footer={
        <span>
          Go back to the Shopify admin and click <strong>Open in web</strong> again, or{" "}
          <Link to="/web/login">sign in with your email</Link>.
        </span>
      }
    >
      {null}
    </AuthCard>
  );
}
