import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { AdminShell } from "../components/admin/AdminShell";
import { AdminCard, AdminPage } from "../components/admin/AdminUi";
import { useAppBridge } from "../lib/ui/surface";
import { requireAdminUser } from "../lib/admin/admin-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import {
  resetRuntimeConfig,
  runtimeConfig,
  runtimeConfigForUi,
  saveRuntimeConfig,
  type ConfigSource,
} from "../lib/admin/runtime-config.server";
import { sendEmail } from "../lib/email/email.server";
import { getVapidPublicKey } from "../lib/notify/vapid.server";

// Admin → Settings (spec 19). Everything that used to require an .env edit
// + redeploy. Dashboard values win; environment variables remain the fallback,
// and each section shows which source is currently in effect.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requireAdminUser(request);
  const [ui, vapidPublicKey] = await Promise.all([
    Promise.resolve(runtimeConfigForUi()),
    getVapidPublicKey(),
  ]);
  return {
    adminEmail: session.admin.email,
    ...ui,
    pushReady: Boolean(vapidPublicKey),
    nodeEnv: process.env.NODE_ENV ?? "development",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const session = await requireAdminUser(request);
  if (!sameOrigin(request))
    return { ok: false as const, error: "Request blocked. Reload the page and try again.", note: null };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const str = (name: string) => String(form.get(name) ?? "").trim();
  const bool = (name: string) => String(form.get(name) ?? "") === "true";

  try {
    if (intent === "ai") {
      // Blank = leave the stored key untouched (the field never shows it).
      const key = str("openaiApiKey");
      if (key) await saveRuntimeConfig({ openaiApiKey: key });
      return {
        ok: true as const,
        error: null,
        note: key ? "API key updated." : "No change — leave blank to keep the current key.",
      };
    }

    if (intent === "ai-clear") {
      await saveRuntimeConfig({ openaiApiKey: "" });
      return { ok: true as const, error: null, note: "Dashboard key cleared — falling back to OPENAI_API_KEY." };
    }

    if (intent === "ai-test") {
      const key = runtimeConfig().openaiApiKey;
      if (!key) return { ok: false as const, error: "No OpenAI key configured.", note: null };
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!res) return { ok: false as const, error: "Could not reach api.openai.com.", note: null };
      if (!res.ok) return { ok: false as const, error: `OpenAI rejected the key (HTTP ${res.status}).`, note: null };
      return { ok: true as const, error: null, note: "Key works — OpenAI accepted it." };
    }

    if (intent === "email") {
      const provider = str("emailProvider");
      const patch: Parameters<typeof saveRuntimeConfig>[0] = {
        emailProvider: provider === "resend" || provider === "smtp" ? provider : "log",
        emailFrom: str("emailFrom"),
        smtpHost: str("smtpHost"),
        smtpUser: str("smtpUser"),
        smtpSecure: bool("smtpSecure"),
      };
      const port = Number(str("smtpPort"));
      if (Number.isFinite(port) && port > 0) patch.smtpPort = Math.floor(port);
      const resendKey = str("resendApiKey");
      if (resendKey) patch.resendApiKey = resendKey;
      const smtpPass = String(form.get("smtpPass") ?? "");
      if (smtpPass) patch.smtpPass = smtpPass;
      await saveRuntimeConfig(patch);
      return { ok: true as const, error: null, note: "Email settings saved." };
    }

    if (intent === "email-test") {
      const result = await sendEmail({
        to: session.admin.email,
        subject: "ChatConvert admin test email",
        text: "This is a test message from the ChatConvert admin console. If you received it, transactional email is working.",
        html: "<p>This is a test message from the ChatConvert admin console. If you received it, transactional email is working.</p>",
      });
      return result.delivered
        ? { ok: true as const, error: null, note: `Sent to ${session.admin.email} via ${result.provider}.` }
        : {
            ok: false as const,
            error:
              result.provider === "log"
                ? "Provider is 'log' — nothing was sent. Pick Resend or SMTP and save first."
                : `Delivery failed via ${result.provider}${result.error ? ` (${result.error})` : ""}.`,
            note: null,
          };
    }

    if (intent === "links") {
      await saveRuntimeConfig({ webAppUrl: str("webAppUrl"), appStoreHandle: str("appStoreHandle") });
      return { ok: true as const, error: null, note: "Links saved." };
    }

    if (intent === "flags") {
      await saveRuntimeConfig({
        embedStatusEnabled: bool("embedStatusEnabled"),
        // Accepted whatever the environment: isBillingTestMode() discards it in
        // production anyway, so storing it there is inert rather than dangerous.
        billingTestMode: bool("billingTestMode"),
      });
      return { ok: true as const, error: null, note: "Flags saved." };
    }

    if (intent === "reset") {
      await resetRuntimeConfig();
      return {
        ok: true as const,
        error: null,
        note: "All dashboard settings cleared — environment values are in effect.",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save.";
    return { ok: false as const, error: message.slice(0, 300), note: null };
  }
  return { ok: false as const, error: "Unknown action.", note: null };
};

function SourceBadge({ source }: { source: ConfigSource }) {
  if (source === "dashboard") return <s-badge tone="info">Dashboard</s-badge>;
  if (source === "environment") return <s-badge>Environment</s-badge>;
  return <s-badge tone="warning">Default</s-badge>;
}

export default function AdminSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  // Feedback as a toast (like the admin/web surfaces), not a banner on top.
  const handled = useRef<unknown>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok && result.note) shopify.toast.show(result.note);
    else if (result.error) shopify.toast.show(result.error, { isError: true });
  }, [fetcher.data, fetcher.state, shopify]);

  const [openaiKey, setOpenaiKey] = useState("");
  const [provider, setProvider] = useState(data.emailProvider);
  const [emailFrom, setEmailFrom] = useState(data.emailFrom);
  const [resendKey, setResendKey] = useState("");
  const [smtpHost, setSmtpHost] = useState(data.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(data.smtpPort));
  const [smtpUser, setSmtpUser] = useState(data.smtpUser);
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpSecure, setSmtpSecure] = useState(data.smtpSecure);
  const [webAppUrl, setWebAppUrl] = useState(data.webAppUrl);
  const [appStoreHandle, setAppStoreHandle] = useState(data.appStoreHandle);
  const [embedStatus, setEmbedStatus] = useState(data.embedStatusEnabled);
  const [billingTestMode, setBillingTestMode] = useState(data.billingTestMode);

  const submit = (values: Record<string, string>) => fetcher.submit(values, { method: "post" });

  return (
    <AdminShell adminEmail={data.adminEmail}>
      <AdminPage heading="Settings" subheading="Operator configuration for the whole app. A value set here wins over the matching environment variable and applies within ~30 seconds — no redeploy.">
        <s-stack gap="base">
          <AdminCard heading="OpenAI API key">
            <s-stack gap="base">
              <s-stack direction="inline" gap="small-300">
                <s-text color="subdued">
                  Powers every chat, summary and embedding. Stored encrypted; never shown again after saving.
                </s-text>
                <SourceBadge source={data.sources.openaiApiKey} />
              </s-stack>
              <s-text>
                Current key: <s-text type="strong">{data.openaiApiKeyMasked || "not set"}</s-text>
              </s-text>
              <s-password-field
                label="New key"
                placeholder="sk-… (leave blank to keep the current key)"
                value={openaiKey}
                onInput={(e) => setOpenaiKey(e.currentTarget.value)}
              />
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  loading={busy}
                  onClick={() => {
                    submit({ intent: "ai", openaiApiKey: openaiKey });
                    setOpenaiKey("");
                  }}
                >
                  Save key
                </s-button>
                <s-button loading={busy} onClick={() => submit({ intent: "ai-test" })}>
                  Test connection
                </s-button>
                {data.sources.openaiApiKey === "dashboard" ? (
                  <s-button tone="critical" variant="tertiary" loading={busy} onClick={() => submit({ intent: "ai-clear" })}>
                    Clear
                  </s-button>
                ) : null}
              </s-stack>
            </s-stack>
          </AdminCard>

          <AdminCard heading="Transactional email">
            <s-stack gap="base">
              <s-stack direction="inline" gap="small-300">
                <s-text color="subdued">
                  Team invites, password resets and handover notifications. &quot;Log&quot; prints messages instead of
                  sending, and the UI falls back to copy-link.
                </s-text>
                <SourceBadge source={data.sources.emailProvider} />
              </s-stack>

              <s-stack direction="inline" gap="base">
                <s-select
                  label="Provider"
                  value={provider}
                  onInput={(e) => setProvider(e.currentTarget.value as typeof provider)}
                >
                  <s-option value="log">Log only (no delivery)</s-option>
                  <s-option value="resend">Resend</s-option>
                  <s-option value="smtp">SMTP</s-option>
                </s-select>
                <s-text-field
                  label="From address"
                  placeholder="ChatConvert <no-reply@yourdomain.com>"
                  value={emailFrom}
                  onInput={(e) => setEmailFrom(e.currentTarget.value)}
                />
              </s-stack>

              {provider === "resend" ? (
                <s-password-field
                  label="Resend API key"
                  placeholder={data.resendApiKeyMasked ? `${data.resendApiKeyMasked} (blank keeps it)` : "re_…"}
                  value={resendKey}
                  onInput={(e) => setResendKey(e.currentTarget.value)}
                />
              ) : null}

              {provider === "smtp" ? (
                <>
                  <s-stack direction="inline" gap="base">
                    <s-text-field label="SMTP host" value={smtpHost} onInput={(e) => setSmtpHost(e.currentTarget.value)} />
                    <s-box maxInlineSize="130px">
                      <s-number-field
                        label="Port"
                        min={1}
                        max={65535}
                        value={smtpPort}
                        onInput={(e) => setSmtpPort(e.currentTarget.value)}
                      />
                    </s-box>
                  </s-stack>
                  <s-stack direction="inline" gap="base">
                    <s-text-field label="Username" value={smtpUser} onInput={(e) => setSmtpUser(e.currentTarget.value)} />
                    <s-password-field
                      label="Password"
                      placeholder={data.smtpPassSet ? "•••••••• (blank keeps it)" : ""}
                      value={smtpPass}
                      onInput={(e) => setSmtpPass(e.currentTarget.value)}
                    />
                  </s-stack>
                  <s-checkbox
                    label="Use TLS on connect (port 465)"
                    checked={smtpSecure}
                    onInput={(e) => setSmtpSecure(e.currentTarget.checked)}
                  />
                </>
              ) : null}

              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  loading={busy}
                  onClick={() => {
                    submit({
                      intent: "email",
                      emailProvider: provider,
                      emailFrom,
                      resendApiKey: resendKey,
                      smtpHost,
                      smtpPort,
                      smtpUser,
                      smtpPass,
                      smtpSecure: String(smtpSecure),
                    });
                    setResendKey("");
                    setSmtpPass("");
                  }}
                >
                  Save email settings
                </s-button>
                <s-button loading={busy} onClick={() => submit({ intent: "email-test" })}>
                  Send test email to me
                </s-button>
              </s-stack>
            </s-stack>
          </AdminCard>

          <AdminCard heading="Links & listing">
            <s-stack gap="base">
              <s-stack direction="inline" gap="small-300">
                <s-text color="subdued">
                  Used in invite, reset and notification emails, and for the App Store review link.
                </s-text>
                <SourceBadge source={data.sources.webAppUrl} />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-text-field
                  label="Web app URL"
                  details="Public origin for /web links. Blank = WEB_APP_URL or SHOPIFY_APP_URL."
                  value={webAppUrl}
                  onInput={(e) => setWebAppUrl(e.currentTarget.value)}
                />
                <s-text-field
                  label="App Store handle"
                  details="apps.shopify.com/<handle>. Blank hides the 'Leave a review' link."
                  value={appStoreHandle}
                  onInput={(e) => setAppStoreHandle(e.currentTarget.value)}
                />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  loading={busy}
                  onClick={() => submit({ intent: "links", webAppUrl, appStoreHandle })}
                >
                  Save links
                </s-button>
              </s-stack>
            </s-stack>
          </AdminCard>

          <AdminCard heading="Operational flags">
            <s-stack gap="base">
              <s-text color="subdued">Runtime switches that used to need an .env edit and a redeploy.</s-text>
              {/* Dev only, and rendered only there. The switch is discarded in
                  production by isBillingTestMode(), so showing it live would be a
                  control that looks connected and is not — which is exactly what
                  it was before, under a banner claiming merchants could not be
                  charged while they were being charged normally. */}
              {data.nodeEnv === "production" ? null : (
                <s-switch
                  label="Billing test mode"
                  details="Uses the mock billing provider — no Shopify call at all. REQUIRED to switch plans on the dev app, which is a custom app: Shopify refuses appSubscriptionCreate for those. Ignored in production, which is why this switch is not shown there."
                  checked={billingTestMode}
                  onInput={(e) => setBillingTestMode(e.currentTarget.checked)}
                />
              )}
              <s-switch
                label="Theme embed detection"
                details="Queries the published theme to detect whether the app embed is enabled. Needs the read_themes scope, declared since 2026-08-26. Storefront traffic already proves the embed is ON without this; the theme read is what can prove it is OFF. Turn off if Shopify throttles the themes API."
                checked={embedStatus}
                onInput={(e) => setEmbedStatus(e.currentTarget.checked)}
              />
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  loading={busy}
                  onClick={() =>
                    submit({
                      intent: "flags",
                      embedStatusEnabled: String(embedStatus),
                      billingTestMode: String(billingTestMode),
                    })
                  }
                >
                  Save flags
                </s-button>
              </s-stack>
            </s-stack>
          </AdminCard>

          <AdminCard heading="Web push">
            <s-stack gap="base">
              <s-text color="subdued">
                VAPID keys are generated automatically on first use and kept in the database. Set VAPID_PUBLIC_KEY /
                VAPID_PRIVATE_KEY to manage them yourself.
              </s-text>
              <s-badge tone={data.pushReady ? "success" : "warning"}>
                {data.pushReady ? "Keys provisioned" : "Unavailable"}
              </s-badge>
            </s-stack>
          </AdminCard>

          <AdminCard heading="Reset">
            <s-stack gap="base">
              <s-text color="subdued">
                Clears every value stored in this dashboard. The app falls back to its environment variables.
              </s-text>
              <s-stack direction="inline" gap="base">
                <s-button tone="critical" loading={busy} onClick={() => submit({ intent: "reset" })}>
                  Clear all dashboard settings
                </s-button>
              </s-stack>
            </s-stack>
          </AdminCard>
        </s-stack>
      </AdminPage>
    </AdminShell>
  );
}
