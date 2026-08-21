import { useState } from "react";
import type { ActionFunctionArgs } from "react-router";
import { Form, Link, useActionData, useNavigation } from "react-router";
import { AuthCard, authStyles } from "../components/web/AuthCard";
import { emailConfigured } from "../lib/email/email.server";
import { allowAttempt, clientKey } from "../lib/team/login-limiter.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import { requestPasswordReset } from "../lib/team/team.server";

// Forgot password (spec 18). Always answers the same way (no account
// enumeration). Without an email provider the owner can issue a reset link
// from Settings → Team instead.

export const loader = async () => ({ emailConfigured: emailConfigured() });

export const action = async ({ request }: ActionFunctionArgs) => {
  // Cross-site submissions would let any page mint reset links (and reset
  // emails) for an address of the attacker's choosing. Answer identically so a
  // blocked request is indistinguishable from a delivered one.
  if (!sameOrigin(request)) return { done: true as const };
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  if (!allowAttempt(clientKey(request, `forgot:${email}`))) {
    return { done: true as const };
  }
  await requestPasswordReset(email);
  return { done: true as const };
};

export default function WebForgot() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [email, setEmail] = useState("");
  const busy = navigation.state !== "idle";

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your email and we'll send a link to set a new password."
      footer={<Link to="/web/login">Back to sign in</Link>}
    >
      {actionData?.done ? (
        <s-banner tone="success">
          If that email belongs to a team member, a reset link is on its way. If nothing arrives, ask the
          store owner to send you a reset link from Settings → Team members.
        </s-banner>
      ) : (
        <Form method="post" className={authStyles.form}>
          <s-email-field
            label="Email"
            name="email"
            value={email}
            required
            autocomplete="email"
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
          <s-button type="submit" variant="primary" loading={busy}>
            Send reset link
          </s-button>
        </Form>
      )}
    </AuthCard>
  );
}
