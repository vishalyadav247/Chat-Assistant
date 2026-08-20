import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { AuthCard, authStyles } from "../components/web/AuthCard";
import { MIN_PASSWORD_LENGTH } from "../lib/team/password.server";
import { resetPassword } from "../lib/team/team.server";
import { findToken } from "../lib/team/tokens.server";
import { sameOrigin } from "../lib/team/same-origin.server";

// Password reset landing (spec 18).

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const row = await findToken(params.token ?? "", "reset");
  return { valid: Boolean(row), minLength: MIN_PASSWORD_LENGTH };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) return { error: "Request blocked. Reload the page and try again." };
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (password !== confirm) return { error: "Passwords don't match." };
  const result = await resetPassword(params.token ?? "", password);
  if (!result.ok) return { error: result.error };
  throw redirect("/web/login?reset=1");
};

export default function WebReset() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  if (!data.valid) {
    return (
      <AuthCard
        title="Reset link not valid"
        subtitle="This link is invalid, expired, or was already used."
        footer={
          <>
            <Link to="/web/forgot">Request a new link</Link>
            <Link to="/web/login">Sign in</Link>
          </>
        }
      >
        {null}
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set a new password" footer={<Link to="/web/login">Back to sign in</Link>}>
      {actionData?.error ? <s-banner tone="critical">{actionData.error}</s-banner> : null}
      <Form method="post" className={authStyles.form}>
        <s-password-field
          label="New password"
          name="password"
          value={password}
          required
          minLength={data.minLength}
          autocomplete="new-password"
          details={`At least ${data.minLength} characters`}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        <s-password-field
          label="Confirm password"
          name="confirm"
          value={confirm}
          required
          autocomplete="new-password"
          onInput={(e) => setConfirm(e.currentTarget.value)}
        />
        <s-button type="submit" variant="primary" loading={busy}>
          Update password
        </s-button>
      </Form>
    </AuthCard>
  );
}
