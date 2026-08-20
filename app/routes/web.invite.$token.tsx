import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { AuthCard, authStyles } from "../components/web/AuthCard";
import { MIN_PASSWORD_LENGTH } from "../lib/team/password.server";
import { acceptInvite, peekInvite } from "../lib/team/team.server";
import { createWebSession } from "../lib/team/web-session.server";
import { sameOrigin } from "../lib/team/same-origin.server";

// Invite acceptance (spec 18): the link from the invite email / copy-link.
// Sets the member's name + password, activates them, signs them in.

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const invite = await peekInvite(params.token ?? "");
  if (!invite) return { valid: false as const };
  return {
    valid: true as const,
    name: invite.member.name,
    email: invite.member.email,
    shopName: invite.shopName,
    alreadyActive: invite.member.status === "active",
    minLength: MIN_PASSWORD_LENGTH,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (!sameOrigin(request)) return { error: "Request blocked. Reload the page and try again." };
  const form = await request.formData();
  const name = String(form.get("name") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (password !== confirm) return { error: "Passwords don't match." };
  const result = await acceptInvite({ raw: params.token ?? "", name, password });
  if (!result.ok) return { error: result.error };
  const { headers } = await createWebSession({ request, shopId: result.member.shopId, memberId: result.member.id });
  throw redirect("/app/inbox", { headers });
};

export default function WebInvite() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [name, setName] = useState(data.valid ? data.name : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  if (!data.valid) {
    return (
      <AuthCard
        title="Invitation not valid"
        subtitle="This invitation link is invalid, expired, or was already used. Ask the store owner to send a new one."
        footer={<Link to="/web/login">Sign in</Link>}
      >
        {null}
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={`Join ${data.shopName}`}
      subtitle={
        <>
          You&apos;ve been invited as <strong>{data.email}</strong>. Set your name and password to start
          working conversations.
        </>
      }
      footer={<Link to="/web/login">Already have an account? Sign in</Link>}
    >
      {actionData?.error ? <s-banner tone="critical">{actionData.error}</s-banner> : null}
      {data.alreadyActive ? (
        <s-banner tone="info">This account is already active — setting a new password here replaces the old one.</s-banner>
      ) : null}
      <Form method="post" className={authStyles.form}>
        <s-text-field label="Your name" name="name" value={name} required maxLength={100} onInput={(e) => setName(e.currentTarget.value)} />
        <s-password-field
          label="Password"
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
          Accept invitation
        </s-button>
      </Form>
    </AuthCard>
  );
}
