import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { allowAttempt, clearAttempts, clientKey } from "../lib/team/login-limiter.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import {
  createAdminSession,
  adminLoginConfigured,
  adminSafeNext,
  readAdminSession,
  verifyAdminLogin,
} from "../lib/admin/admin-auth.server";

// Admin login (spec 19). Two kinds of operator sign in here: the ADMIN_EMAIL /
// ADMIN_PASSWORD pair from the server's .env (root — its platform_admins row is
// a mirror, never a stored password), and accounts created at /admin/access,
// which have a real hash. See admin-auth.server.ts.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const next = adminSafeNext(url.searchParams.get("next"));
  const session = await readAdminSession(request);
  if (session) throw redirect(next);
  return { next, configured: adminLoginConfigured() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) return { error: "Request blocked. Reload the page and try again." };
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = adminSafeNext(String(form.get("next") ?? ""));

  const key = clientKey(request, `admin:${email}`);
  if (!allowAttempt(key)) {
    return { error: "Too many attempts from this device. Try again in a few minutes." };
  }

  const result = await verifyAdminLogin(email, password);
  if (!result.ok) return { error: result.error };

  clearAttempts(key);
  const headers = await createAdminSession(request, result.admin.id);
  throw redirect(next, { headers });
};

export default function AdminLogin() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    // Same glass surface as the console itself, but the theme follows the OS —
    // nobody has chosen one yet at the sign-in screen.
    <div className="cca" data-theme="system">
      <div className="cca-auth">
        <div className="cca-auth__card">
          <div className="cca-auth__head">
            <span className="cca-brand__mark" aria-hidden="true">
              C
            </span>
            <h1>Admin console</h1>
            <p>
              Operator sign-in for the ChatConvert team. Global settings here apply to every
              installed store.
            </p>
          </div>

          {data.configured ? null : (
            <s-banner tone="warning">
              This server has no <code>ADMIN_EMAIL</code> / <code>ADMIN_PASSWORD</code> in
              its <code>.env</code>, so only accounts created inside the console can sign in.
              Set both and restart the app to enable the root login.
            </s-banner>
          )}
          {actionData?.error ? <s-banner tone="critical">{actionData.error}</s-banner> : null}

          <Form method="post" className="cca-auth__form">
            <input type="hidden" name="next" value={data.next} />
            <s-email-field
              label="Email"
              name="email"
              value={email}
              required
              autocomplete="email"
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
            <s-password-field
              label="Password"
              name="password"
              value={password}
              required
              autocomplete="current-password"
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
            <s-button type="submit" variant="primary" loading={busy}>
              Sign in
            </s-button>
          </Form>

          <p className="cca-auth__foot">
            Merchant? Open ChatConvert from your Shopify admin instead.
          </p>
        </div>
      </div>
    </div>
  );
}
