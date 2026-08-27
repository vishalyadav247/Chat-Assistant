import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { hasFeature, requiredPlanName } from "../lib/billing/plans.server";
import { PlanBanner } from "../components/ui/PlanGate";
import { getVapidPublicKey } from "../lib/notify/vapid.server";
import { sendPushToMembers } from "../lib/notify/push.server";
import { requireShopAccess } from "../lib/access.server";
import { verifyPassword } from "../lib/team/password.server";
import { notifyPrefsSchema, parseNotifyPrefs, setPassword, updateMemberProfile } from "../lib/team/team.server";
import { revokeMemberSessions } from "../lib/team/web-session.server";
import { useAppBridge } from "../lib/ui/surface";
import {
  hasPushSubscription,
  needsIosInstall,
  pushDiagnostics,
  pushState,
  type PushDiagnostics,
  subscribePush,
  unsubscribePush,
  type PushState,
} from "../lib/ui/push-client";
import { routeError } from "../lib/ui/route-error";
import { APP_NAME } from "./app";

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
  // Push is plan-gated server-side in app.push-subscription; without this the
  // member could enable it here and simply never receive anything.
  const shop = await db.shop.findUnique({ where: { id: access.shopId }, select: { plan: true } });
  const pushAllowed = hasFeature(shop?.plan ?? "free", "push_notifications");
  return {
    available: true as const,
    pushAllowed,
    pushPlan: pushAllowed ? null : requiredPlanName("push_notifications"),
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
    case "push-test": {
      // Proves the whole chain — VAPID keys, stored subscription, push service,
      // service worker — instead of leaving "enabled" as a claim.
      const result = await sendPushToMembers(access.shopId, [member.id], {
        title: "ChatConvert",
        body: "Test notification — push is working on this device.",
        url: "/app/inbox",
        tag: "push-test",
      });
      return {
        ok: result.sent > 0,
        intent,
        error:
          result.sent > 0
            ? undefined
            : "No device received it. Enable notifications on this device, then try again.",
      };
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

/** Per-device checklist. When notifications "are enabled" but nothing arrives,
 *  this says which link of the chain is actually missing on THIS phone. */
function PushChecklist({
  diagnostics,
  lastError,
}: {
  diagnostics: PushDiagnostics;
  lastError: string | null;
}) {
  const rows: { label: string; ok: boolean; detail?: string }[] = [
    { label: "Secure connection (https)", ok: diagnostics.secureContext, detail: diagnostics.origin },
    {
      label: "Browser supports notifications",
      ok: diagnostics.serviceWorkerApi && diagnostics.pushApi && diagnostics.notificationApi,
      detail: diagnostics.iosNeedsInstall ? "iPhone: add to Home Screen first" : undefined,
    },
    { label: "Permission allowed", ok: diagnostics.permission === "granted", detail: diagnostics.permission },
    { label: "Background service running", ok: diagnostics.serviceWorkerRegistered },
    {
      label: "This device is registered",
      ok: diagnostics.subscribedHere,
      detail: diagnostics.endpointHost ?? undefined,
    },
  ];
  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 13 }}>Notifications not arriving on this device?</summary>
      <s-stack gap="small-200">
        {rows.map((row) => (
          <s-text key={row.label} tone={row.ok ? "neutral" : "critical"}>
            {row.ok ? "✓" : "✗"} {row.label}
            {row.detail ? ` — ${row.detail}` : ""}
          </s-text>
        ))}
        {lastError ? <s-text tone="critical">Last attempt — {lastError}</s-text> : null}
        <s-text tone="neutral">
          Every line must be ✓ on the device you want notified. Enabling on a computer does not cover your phone —
          each device registers separately.
        </s-text>
      </s-stack>
    </details>
  );
}

function AccountUnavailable() {
  return (
    <s-page heading={APP_NAME}>
      <s-stack gap="base">
        <s-heading>Account</s-heading>
        <s-section>
          <s-paragraph>
            Personal accounts belong to the ChatConvert web app. Use <strong>Open in web</strong> from the
            Inbox or
            Settings → Team members to manage your web login and browser notifications.
          </s-paragraph>
        </s-section>
      </s-stack>
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
  const [iosInstall, setIosInstall] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PushDiagnostics | null>(null);
  const [lastPushError, setLastPushError] = useState<string | null>(null);
  const revalidator = useRevalidator();
  useEffect(() => {
    setPush(pushState());
    setIosInstall(needsIosInstall());
    hasPushSubscription().then(setSubscribedHere);
    pushDiagnostics().then(setDiagnostics);
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
        "push-test": "Test notification sent",
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
    // The checklist is a snapshot — re-read it so it reflects THIS attempt
    // rather than the state the page loaded with.
    pushDiagnostics().then(setDiagnostics);
    setLastPushError(
      result.ok ? null : `${result.reason ?? "failed"}: ${result.detail ?? result.error ?? ""}`,
    );
    if (result.ok) {
      setSubscribedHere(true);
      // The "N devices enabled" count comes from the loader — refresh it so it
      // reflects this device immediately.
      revalidator.revalidate();
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
    revalidator.revalidate();
    shopify.toast.show("Browser notifications disabled on this device");
  };

  const pushHelp =
    !data.vapidPublicKey
      ? "Browser notifications aren't configured on this server yet."
      : push === "unsupported"
        ? diagnostics && !diagnostics.secureContext
          ? "Notifications need a secure connection. This page is on " +
            diagnostics.origin +
            " — open the app on its https:// address instead (a plain http:// address, like a LAN IP, can't register notifications)."
          : iosInstall
            ? "On iPhone and iPad, notifications only work once ChatConvert is on your Home Screen: tap Share → Add to Home Screen, open it from there, then come back to enable them."
            : "This browser doesn't support notifications."
        : push === "denied"
          ? "Notifications are blocked for this site — allow them in your browser's site settings, then reload."
          : subscribedHere
            ? "This device will receive notifications."
            : "Enable notifications on this device to get alerted even when the tab is in the background.";

  return (
    <s-page heading={APP_NAME}>
      <s-stack gap="base">
        <s-heading>Account</s-heading>
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
            <PlanBanner plan={data.pushPlan} heading="Browser notifications need a higher plan">
              You can set your preferences now, but notifications won&apos;t be delivered until your
              store upgrades.
            </PlanBanner>
            <s-paragraph>{pushHelp}</s-paragraph>
            {data.pushAllowed && data.vapidPublicKey && push !== "unsupported" && push !== "denied" ? (
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
                {data.subscribedDevices > 0 ? (
                  <s-button
                    disabled={busy}
                    onClick={() => fetcher.submit({ intent: "push-test" }, { method: "post" })}
                  >
                    Send test
                  </s-button>
                ) : null}
                <s-text tone="neutral">
                  {data.subscribedDevices} device{data.subscribedDevices === 1 ? "" : "s"} enabled
                </s-text>
              </s-stack>
            ) : null}
            {diagnostics ? <PushChecklist diagnostics={diagnostics} lastError={lastPushError} /> : null}
            <s-stack gap="small-200">
              <s-text type="strong">Notify me when…</s-text>
              <s-checkbox
                label="A conversation is handed over to a human"
                checked={prefs.push.handover}
                onInput={(e) => savePrefs({ ...prefs, push: { ...prefs.push, handover: e.currentTarget.checked } })}
              />
              <s-checkbox
                label="A shopper replies in a conversation that's waiting for a human (mine or unassigned)"
                checked={prefs.push.humanReply}
                onInput={(e) => savePrefs({ ...prefs, push: { ...prefs.push, humanReply: e.currentTarget.checked } })}
              />
              <s-checkbox
                label="Any new conversation starts (noisy)"
                checked={prefs.push.newConversation}
                onInput={(e) => savePrefs({ ...prefs, push: { ...prefs.push, newConversation: e.currentTarget.checked } })}
              />
              <s-checkbox
                label="Play a sound in the inbox when something new arrives"
                checked={prefs.sound}
                onInput={(e) => savePrefs({ ...prefs, sound: e.currentTarget.checked })}
              />
              <s-checkbox
                label="Also email me handover requests"
                checked={prefs.emailHandover}
                onInput={(e) => savePrefs({ ...prefs, emailHandover: e.currentTarget.checked })}
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
