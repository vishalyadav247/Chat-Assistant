import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { AuthCard, authStyles } from "../components/web/AuthCard";
import { allowAttempt, clearAttempts, clientKey } from "../lib/team/login-limiter.server";
import { safeNext } from "../lib/team/safe-next";
import { sameOrigin } from "../lib/team/same-origin.server";
import { verifyLogin, type LoginCandidate } from "../lib/team/team.server";
import { createWebSession, readWebSession } from "../lib/team/web-session.server";

// Web login (spec 18): email + password. When the address belongs to several
// stores the form shows a store picker and resubmits with the chosen shopId
// (the password is verified again — nothing is kept server-side in between).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const session = await readWebSession(request);
  if (session) throw redirect(next);
  return { next, reset: url.searchParams.get("reset") === "1", invited: url.searchParams.get("invited") === "1" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) return { ok: false as const, error: "Request blocked. Reload the page and try again.", candidates: null };
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const shopId = String(form.get("shopId") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));

  const key = clientKey(request, email);
  if (!allowAttempt(key)) {
    return { ok: false as const, error: "Too many attempts from this device. Try again in a few minutes.", candidates: null };
  }

  const result = await verifyLogin(email, password);
  if (!result.ok) return { ok: false as const, error: result.error, candidates: null };

  let chosen: LoginCandidate | undefined;
  if (result.candidates.length === 1) chosen = result.candidates[0];
  else if (shopId) chosen = result.candidates.find((c) => c.shopId === shopId);
  if (!chosen) {
    return { ok: true as const, error: null, candidates: result.candidates.map((c) => ({ shopId: c.shopId, shopName: c.shopName, role: c.role })) };
  }

  clearAttempts(key);
  const { headers } = await createWebSession({ request, shopId: chosen.shopId, memberId: chosen.memberId });
  throw redirect(next, { headers });
};

export default function WebLogin() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const candidates = actionData?.candidates ?? null;

  return (
    <AuthCard
      title={candidates ? "Choose a store" : "Sign in"}
      subtitle={
        candidates
          ? "Your email is a team member on more than one store."
          : "Sign in to review and reply to customer conversations."
      }
      footer={
        candidates ? null : (
          <>
            <Link to="/web/forgot">Forgot password?</Link>
            <span>Store owner? Open ChatConvert from your Shopify admin.</span>
          </>
        )
      }
    >
      {data.reset ? <s-banner tone="success">Password updated — sign in with your new password.</s-banner> : null}
      {data.invited ? <s-banner tone="success">You&apos;re all set — sign in to get started.</s-banner> : null}
      {actionData?.error ? <s-banner tone="critical">{actionData.error}</s-banner> : null}

      {candidates ? (
        <div className={authStyles.pick}>
          {candidates.map((c) => (
            <Form key={c.shopId} method="post">
              <input type="hidden" name="email" value={email} />
              <input type="hidden" name="password" value={password} />
              <input type="hidden" name="next" value={data.next} />
              <input type="hidden" name="shopId" value={c.shopId} />
              <button type="submit" className={authStyles.pickButton} disabled={busy}>
                {c.shopName}
                <span className={authStyles.pickRole}>{c.role}</span>
              </button>
            </Form>
          ))}
        </div>
      ) : (
        <Form method="post" className={authStyles.form}>
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
      )}
    </AuthCard>
  );
}
