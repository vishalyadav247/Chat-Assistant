import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { getVapidPublicKey } from "../lib/notify/vapid.server";
import { requireShopAccess } from "../lib/access.server";
import { verifyPassword } from "../lib/team/password.server";
import { notifyPrefsSchema, parseNotifyPrefs, setPassword, updateMemberProfile } from "../lib/team/team.server";
import { revokeMemberSessions } from "../lib/team/web-session.server";
import { useAppBridge } from "../lib/ui/surface";
import { hasPushSubscription, pushState, subscribePush, unsubscribePush, type PushState } from "../lib/ui/push-client";
import { routeError } from "../lib/ui/route-error";

// Account page (spec 18) — web surface only: profile, password, browser
// notification preferences, sign out everywhere. In the admin there is no
// personal account (Shopify staff identity), so it bounces to the dashboard.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request);
  if (access.surface !== "web" || !access.member) {
    // No personal account inside the Shopify admin (staff identity) — render
    // a note rather than redirecting (a document redirect would drop the
    // embedded params and bounce).
    return { available: false as const };
  }
  const member = access.member;
  const subs = await db.pushSubscription.count({ where: { shopId: access.shopId, memberId: member.id } });
  return {
    available: true as const,
    member: { name: member.name, email: member.email, role: member.role, hasPassword: Boolean(member.passwordHash) },
    prefs: parseNotifyPrefs(member.notifyPrefs, member.role),
    vapidPublicKey: await getVapidPublicKey(),
    subscribedDevices: subs,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const access = await requireShopAccess(request);
  if (access.surface !== "web" || !access.member) throw new Response("Forbidden", { status: 403 });
  const member = access.member;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  switch (intent) {
    case "profile": {
      const name = String(form.get("name") ?? "");
      const ok = await updateMemberProfile(access.shopId, member.id, { name });
      return { ok, intent, error: ok ? undefined : "Enter a name." };
    }
    case "password": {
      const current = String(form.get("current") ?? "");
      const next = String(form.get("password") ?? "");
      const confirm = String(form.get("confirm") ?? "");
      if (next !== confirm) return { ok: false, intent, error: "Passwords don't match." };
      if (member.passwordHash && !(await verifyPassword(current, member.passwordHash))) {
        return { ok: false, intent, error: "Current password is incorrect." };
      }
      const result = await setPassword(access.shopId, member.id, next, access.sessionId ?? undefined);
      return { ok: result.ok, intent, error: result.error };
    }
    case "notify-prefs": {
      let raw: unknown = {};
      try {
        raw = JSON.parse(String(form.get("prefs") ?? "{}"));
      } catch {
        raw = {};
      }
      const parsed = notifyPrefsSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, intent, error: "Invalid preferences." };
      const ok = await updateMemberProfile(access.shopId, member.id, { notifyPrefs: parsed.data });
      return { ok, intent };
    }
    case "signout-all": {
      await revokeMemberSessions(access.shopId, member.id, access.sessionId ?? undefined);
      await db.pushSubscription.deleteMany({ where: { shopId: access.shopId, memberId: member.id } });
      return { ok: true, intent };
    }
    default:
      return { ok: false, intent, error: "Unknown action." };
  }
};

type Prefs = z.infer<typeof notifyPrefsSchema>;

export default function AccountPage() {
  const data = useLoaderData<typeof loader>();
  if (!data.available) return <AccountUnavailable />;
  return <AccountForm data={data} />;
}

function AccountUnavailable() {
  return (
    <s-page heading="Account">
      <s-section>
        <s-paragraph>
          Personal accounts belong to the ChatConvert web app. Use <strong>Open in web</strong> from the Inbox or
          Settings → Team members to manage your web login and browser notifications.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

type AccountData = Extract<Awaited<ReturnType<typeof loader>>, { available: true }>;

function AccountForm({ data }: { data: AccountData }) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const [name, setName] = useState(data.member.name);
  const [current, setCurrent] = useState("");
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [prefs, setPrefs] = useState<Prefs>(data.prefs);

  // Push state for THIS browser.
  const [push, setPush] = useState<PushState>("unsupported");
  const [subscribedHere, setSubscribedHere] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    setPush(pushState());
    hasPushSubscription().then(setSubscribedHere);
  }, []);

  const processed = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || processed.current === fetcher.data) return;
    processed.current = fetcher.data;
    const d = fetcher.data;
    if (d.ok) {
      const msg: Record<string, string> = {
        profile: "Profile saved",
        password: "Password updated — other devices were signed out",
        "notify-prefs": "Notification preferences saved",
        "signout-all": "Signed out everywhere else",
      };
      shopify.toast.show(msg[d.intent] ?? "Saved");
      if (d.intent === "password") {
        setCurrent("");
        setPasswordValue("");
        setConfirm("");
      }
    } else if (d.error) {
      shopify.toast.show(d.error, { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const savePrefs = (next: Prefs) => {
    setPrefs(next);
    fetcher.submit({ intent: "notify-prefs", prefs: JSON.stringify(next) }, { method: "post" });
  };

  const enablePush = async () => {
    setPushBusy(true);
    const result = await subscribePush(data.vapidPublicKey);
    setPushBusy(false);
    setPush(result.state);
    if (result.ok) {
      setSubscribedHere(true);
      shopify.toast.show("Browser notifications enabled on this device");
    } else {
      shopify.toast.show(result.error ?? "Couldn't enable notifications", { isError: true });
    }
  };
  const disablePush = async () => {
    setPushBusy(true);
    await unsubscribePush();
    setPushBusy(false);
    setSubscribedHere(false);
    shopify.toast.show("Browser notifications disabled on this device");
  };

  const pushHelp =
    !data.vapidPublicKey
      ? "Browser notifications aren't configured on this server yet."
      : push === "unsupported"
        ? "This browser doesn't support notifications."
        : push === "denied"
          ? "Notifications are blocked for this site — allow them in your browser's site settings, then reload."
          : subscribedHere
            ? "This device will receive notifications."
            : "Enable notifications on this device to get alerted even when the tab is in the background.";

  return (
    <s-page heading="Account">
      <s-stack gap="base">
        <s-section heading="Profile">
          <s-stack gap="base">
            <s-box maxInlineSize="420px">
              <s-text-field label="Name" value={name} maxLength={100} onInput={(e) => setName(e.currentTarget.value)} />
            </s-box>
            <s-text tone="neutral">
              {data.member.email} · role: {data.member.role}
            </s-text>
            <s-stack direction="inline">
              <s-button
                variant="primary"
                disabled={busy || !name.trim() || name.trim() === data.member.name}
                onClick={() => fetcher.submit({ intent: "profile", name }, { method: "post" })}
              >
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Browser notifications">
          <s-stack gap="base">
            <s-paragraph>{pushHelp}</s-paragraph>
            {data.vapidPublicKey && push !== "unsupported" && push !== "denied" ? (
              <s-stack direction="inline" gap="small">
                {subscribedHere ? (
                  <s-button disabled={pushBusy} onClick={disablePush}>
                    Disable on this device
                  </s-button>
                ) : (
                  <s-button variant="primary" disabled={pushBusy} loading={pushBusy} onClick={enablePush}>
                    Enable on this device
                  </s-button>
                )}
                <s-text tone="neutral">
                  {data.subscribedDevices} device{data.subscribedDevices === 1 ? "" : "s"} enabled
                </s-text>
              </s-stack>
            ) : null}
            <s-stack gap="small-200">
              <s-text type="strong">Notify me when…</s-text>
              <s-checkbox
                label="A conversation is handed over to a human"
                checked={prefs.push.handover}
                onChange={(e) => savePrefs({ ...prefs, push: { ...prefs.push, handover: e.currentTarget.checked } })}
              />
              <s-checkbox
                label="A shopper replies in a conversation that's waiting for a human (mine or unassigned)"
                checked={prefs.push.humanReply}
                onChange={(e) => savePrefs({ ...prefs, push: { ...prefs.push, humanReply: e.currentTarget.checked } })}
              />
              <s-checkbox
                label="Any new conversation starts (noisy)"
                checked={prefs.push.newConversation}
                onChange={(e) => savePrefs({ ...prefs, push: { ...prefs.push, newConversation: e.currentTarget.checked } })}
              />
              <s-checkbox
                label="Play a sound in the inbox when something new arrives"
                checked={prefs.sound}
                onChange={(e) => savePrefs({ ...prefs, sound: e.currentTarget.checked })}
              />
              <s-checkbox
                label="Also email me handover requests"
                checked={prefs.emailHandover}
                onChange={(e) => savePrefs({ ...prefs, emailHandover: e.currentTarget.checked })}
              />
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading={data.member.hasPassword ? "Change password" : "Set a password"}>
          <s-stack gap="base">
            {!data.member.hasPassword ? (
              <s-paragraph>
                You signed in from the Shopify admin. Set a password to sign in directly at this address next time.
              </s-paragraph>
            ) : null}
            <s-box maxInlineSize="420px">
              <s-stack gap="base">
                {data.member.hasPassword ? (
                  <s-password-field
                    label="Current password"
                    value={current}
                    autocomplete="current-password"
                    onInput={(e) => setCurrent(e.currentTarget.value)}
                  />
                ) : null}
                <s-password-field
                  label="New password"
                  value={password}
                  autocomplete="new-password"
                  details="At least 8 characters"
                  onInput={(e) => setPasswordValue(e.currentTarget.value)}
                />
                <s-password-field
                  label="Confirm new password"
                  value={confirm}
                  autocomplete="new-password"
                  onInput={(e) => setConfirm(e.currentTarget.value)}
                />
              </s-stack>
            </s-box>
            <s-stack direction="inline">
              <s-button
                variant="primary"
                disabled={busy || password.length < 8 || password !== confirm || (data.member.hasPassword && !current)}
                onClick={() => fetcher.submit({ intent: "password", current, password, confirm }, { method: "post" })}
              >
                {data.member.hasPassword ? "Update password" : "Set password"}
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Sessions">
          <s-stack gap="base">
            <s-paragraph>Sign out of ChatConvert on every other device and browser (this one stays signed in).</s-paragraph>
            <s-stack direction="inline">
              <s-button tone="critical" disabled={busy} onClick={() => fetcher.submit({ intent: "signout-all" }, { method: "post" })}>
                Sign out everywhere else
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
