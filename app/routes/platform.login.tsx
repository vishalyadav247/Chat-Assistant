import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { AuthCard, authStyles } from "../components/web/AuthCard";
import { allowAttempt, clearAttempts, clientKey } from "../lib/team/login-limiter.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import {
  createPlatformSession,
  platformNeedsBootstrap,
  platformSafeNext,
  readPlatformSession,
  verifyPlatformLogin,
} from "../lib/platform/platform-auth.server";

// Platform admin login (spec 19). Operator accounts live in platform_admins;
// the first one is created via scripts/platform-admin.ts (or the env-var
// bootstrap — see verifyPlatformLogin).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const next = platformSafeNext(url.searchParams.get("next"));
  const session = await readPlatformSession(request);
  if (session) throw redirect(next);
  return { next, needsBootstrap: await platformNeedsBootstrap() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) return { error: "Request blocked. Reload the page and try again." };
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = platformSafeNext(String(form.get("next") ?? ""));

  const key = clientKey(request, `platform:${email}`);
  if (!allowAttempt(key)) {
    return { error: "Too many attempts from this device. Try again in a few minutes." };
  }

  const result = await verifyPlatformLogin(email, password);
  if (!result.ok) return { error: result.error };

  clearAttempts(key);
  const headers = await createPlatformSession(request, result.admin.id);
  throw redirect(next, { headers });
};

export default function PlatformLogin() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <AuthCard
      title="Platform admin"
      subtitle="Operator sign-in for the ChatConvert team. Global settings here apply to every installed store."
      footer={<span>Merchant? Open ChatConvert from your Shopify admin instead.</span>}
    >
      {data.needsBootstrap ? (
        <s-banner tone="info">
          No platform admins exist yet. Create the first one with{" "}
          <code>npx tsx scripts/platform-admin.ts create &lt;email&gt; &lt;name&gt; &lt;password&gt;</code>
          {" "}(or sign in with the PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD env credentials).
        </s-banner>
      ) : null}
      {actionData?.error ? <s-banner tone="critical">{actionData.error}</s-banner> : null}

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
    </AuthCard>
  );
}
