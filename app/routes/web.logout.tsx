import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect } from "react-router";
import { sameOrigin } from "../lib/team/same-origin.server";
import { destroyWebSession, hasWebCookie } from "../lib/team/web-session.server";

// Only POST destroys the session: a GET must never sign the user out, or any
// cross-site link/image pointing at /web/logout becomes a logout CSRF. A
// cross-site POST (auto-submitting form) is the same attack, so the same
// sameOrigin guard the platform logout uses applies here too.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) throw redirect("/web/login");
  const headers = await destroyWebSession(request);
  throw redirect("/web/login", { headers });
};

// GET renders a minimal confirm page (bookmarks / typed URL) with a POST form.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!hasWebCookie(request)) throw redirect("/web/login");
  return null;
};

export default function WebLogout() {
  return (
    <main style={{ maxWidth: 420, margin: "15vh auto", padding: 24, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Sign out of ChatConvert?</h1>
      <p style={{ color: "#616161", margin: "0 0 20px" }}>You can sign back in at any time.</p>
      <Form method="post" style={{ display: "flex", gap: 12 }}>
        <button
          type="submit"
          style={{ padding: "10px 16px", borderRadius: 8, border: 0, background: "#1a1a1a", color: "#fff", cursor: "pointer" }}
        >
          Sign out
        </button>
        {/* /app (dashboard) is 403 for the agent role — send everyone to the
            inbox, the one page every role can open. */}
        <a href="/app/inbox" style={{ padding: "10px 16px", color: "#1a1a1a" }}>
          Cancel
        </a>
      </Form>
    </main>
  );
}
