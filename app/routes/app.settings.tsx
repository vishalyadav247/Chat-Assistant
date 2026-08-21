import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useFetcher, useLoaderData, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { env } from "../lib/env.server";
import { reviewFallbackUrl } from "../lib/review";
import { resolveAvailabilityFor } from "../lib/settings/availability.server";
import { applySettingsIntent, loadShopSettings } from "../lib/settings/save.server";
import {
  downloadDataRequest,
  isDataRequestOverdue,
} from "../lib/compliance/data-request.server";
import type { ShopSettingsData } from "../lib/settings/schemas";
import { SaveBar } from "../components/SaveBar";
import { TabPills } from "../components/ui/TabPills";
import { SettingsGeneral } from "../components/SettingsGeneral";
import { SettingsChatbox } from "../components/SettingsChatbox";
import { SettingsAvailability } from "../components/SettingsAvailability";
import { SettingsSurvey } from "../components/SettingsSurvey";
import { SettingsPrivacy } from "../components/SettingsPrivacy";
import { requireShopAccess } from "../lib/access.server";
import { applyTeamIntent, isTeamIntent } from "../lib/team/team-intents.server";
import { listMembers } from "../lib/team/team.server";
import { getQuota } from "../lib/billing/plans.server";
import { emailConfigured } from "../lib/email/email.server";
import { formatDate as formatDateWithPrefs } from "../lib/format/datetime";
import { routeError } from "../lib/ui/route-error";

// Settings (spec 16): General / Chatbox / Privacy & Data Requests tabs plus
// the Chat availability (?tab=availability) and Satisfaction survey
// (?tab=survey) sub-views, deep-linkable via ?tab= from other pages (06) —
// same URL convention as the AI-agent pages.

/** Tab switches only change ?tab= — nothing the loader returns depends on it,
 *  and re-running it would reset unsaved edits in the other tabs' drafts. */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "settings" });
  const { shopId, shopDomain } = access;

  const [shop, settings, ownerSession, dataRequestRows, members] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId } }),
    loadShopSettings(shopId),
    db.session.findFirst({ where: { shop: shopDomain }, orderBy: { accountOwner: "desc" } }),
    db.dataRequest.findMany({ where: { shopId }, orderBy: { requestedAt: "desc" }, take: 50 }),
    listMembers(shopId),
  ]);
  const ownerMember = members.find((m) => m.role === "owner") ?? null;

  const timezone = shop?.timezone || "UTC";
  const preview = await resolveAvailabilityFor(shopId, settings.availability, timezone);
  // Pre-formatted dates follow the shop's global date format (Store information).
  const dtPrefs = { dateFormat: settings.storeInfo.dateFormat, timeFormat: settings.storeInfo.timeFormat, timeZone: timezone };
  const formatDate = (date: Date) => formatDateWithPrefs(date, dtPrefs);

  const fallbackName = shopDomain.replace(".myshopify.com", "");
  const ownerName =
    ownerMember?.name ||
    [ownerSession?.firstName, ownerSession?.lastName].filter(Boolean).join(" ") ||
    fallbackName;

  return {
    shopDomain: shopDomain,
    apiKey: process.env.SHOPIFY_API_KEY || "",
    settings,
    timezone,
    // Theme app-embed detection (spec 13's helper; "unknown" until read_themes).
    embedStatus: await (async () => {
      const { getEmbedStatus } = await import("../lib/embed-status.server");
      return getEmbedStatus(shopDomain);
    })(),
    defaultStoreName: shop?.name ?? fallbackName,
    // null until SHOPIFY_APP_STORE_HANDLE is set (listing live) — link hidden.
    reviewUrl: reviewFallbackUrl(env().SHOPIFY_APP_STORE_HANDLE),
    owner: {
      name: ownerName,
      email: ownerMember?.email ?? ownerSession?.email ?? "—",
      since: shop?.installedAt ? formatDate(shop.installedAt) : "—",
    },
    // Team (spec 18): real logins for the standalone web app.
    team: {
      members: members.filter((m) => m.role !== "owner"),
      seatsUsed: members.filter((m) => m.role !== "owner").length,
      // null = unlimited (plan enforcement "open" or a very high cap).
      seatQuota: (() => {
        const q = getQuota(shop?.plan ?? "free", "team_seats");
        return q >= 1_000_000 ? null : q;
      })(),
      emailConfigured: emailConfigured(),
      surface: access.surface,
      selfId: access.member?.id ?? null,
    },
    availabilityPreview: { status: preview.status, message: preview.message },
    dataRequests: dataRequestRows.map((row) => ({
      id: row.id,
      date: formatDate(row.requestedAt),
      email: row.customerEmail,
      status: row.status,
      dueAt: formatDate(row.dueAt),
      isOverdue: isDataRequestOverdue(row),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "settings" });
  const { shopId, shopDomain } = access;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  // The SaveBar submits every dirty tab at once (the draft spans all views),
  // so one round-trip can carry several slices. Each is applied in order —
  // applySettingsIntent re-reads the blob per call, so merges never clobber.
  if (intent === "save-settings") {
    let slices: Array<{ intent: string; payload: unknown }> = [];
    try {
      slices = JSON.parse(String(formData.get("payload") ?? "[]"));
    } catch {
      return { ok: false as const, intent, error: "Couldn't read the settings payload." };
    }
    if (!Array.isArray(slices) || slices.length === 0) {
      return { ok: false as const, intent, error: "Nothing to save." };
    }
    for (const slice of slices) {
      const sliceForm = new FormData();
      sliceForm.set("intent", String(slice?.intent ?? ""));
      sliceForm.set("payload", JSON.stringify(slice?.payload ?? {}));
      const result = await applySettingsIntent({
        shopId,
        shopDomain: shopDomain,
        formData: sliceForm,
      });
      if (!result.ok) return { ...result, intent };
    }
    return { ok: true as const, intent };
  }
  if (isTeamIntent(intent)) {
    let raw: unknown = {};
    try {
      raw = JSON.parse(String(formData.get("payload") ?? "{}"));
    } catch {
      raw = {};
    }
    return applyTeamIntent({ access, intent, raw });
  }
  // Data-request export (spec 17): compiled fresh on download, returned in the
  // action payload for a client-side Blob save (see app.contacts.tsx export).
  if (formData.get("intent") === "download-data-request") {
    try {
      const { json, filename } = await downloadDataRequest(
        shopId,
        String(formData.get("id") ?? ""),
      );
      return { ok: true as const, intent: "download-data-request", json, filename };
    } catch {
      return {
        ok: false as const,
        intent: "download-data-request",
        error: "Couldn't compile the export — the request may no longer exist.",
      };
    }
  }
  return applySettingsIntent({ shopId, shopDomain: shopDomain, formData });
};

const VIEWS = ["general", "chatbox", "privacy", "availability", "survey"] as const;
type View = (typeof VIEWS)[number];
const isView = (value: string): value is View => (VIEWS as readonly string[]).includes(value);

const TABS: Array<{ view: View; label: string }> = [
  { view: "general", label: "General" },
  { view: "chatbox", label: "Chatbox" },
  { view: "privacy", label: "Privacy & Data Requests" },
];

const INTENTS: Record<View, string> = {
  general: "save-general",
  chatbox: "save-chatbox",
  privacy: "save-privacy",
  availability: "save-availability",
  survey: "save-survey",
};

function sliceFor(view: View, settings: ShopSettingsData, timezone: string): unknown {
  switch (view) {
    case "general":
      return {
        name: settings.storeInfo.name,
        dateFormat: settings.storeInfo.dateFormat,
        timeFormat: settings.storeInfo.timeFormat,
        theme: settings.theme,
        inbox: settings.inbox,
      };
    case "chatbox":
      // apiKey is excluded: the Connect button owns it (validate-then-persist),
      // so typing a key must not arm the SaveBar or ride along with Save.
      return {
        cartDrawer: settings.cartDrawer,
        orderTracking: {
          mode: settings.orderTracking.mode,
          customUrl: settings.orderTracking.customUrl,
          provider: settings.orderTracking.provider,
        },
      };
    case "availability":
      return { availability: settings.availability, timezone };
    case "survey":
      return { survey: settings.survey };
    case "privacy":
      return { retentionDays: settings.retentionDays };
  }
}

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  // The active view lives in the URL (?tab=general|chatbox|availability|
  // survey|privacy) so tabs are deep-linkable and survive reloads.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const view: View = rawTab && isView(rawTab) ? rawTab : "general";

  const go = useCallback(
    (next: View) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("tab", next);
          return params;
        },
        { preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const [draft, setDraft] = useState<ShopSettingsData>(data.settings);
  const [timezone, setTimezone] = useState(data.timezone);

  // Reset the draft only when the SAVED blob changes (save / reload) — logo
  // upload, team invites and data-request downloads revalidate the loader
  // without touching these fields, and must not wipe in-progress edits
  // (same guard as app.chatbox.tsx). logoUrl is excluded here because it IS
  // persisted by its own fetcher; it is merged into the draft below.
  const savedJson = useMemo(
    () =>
      JSON.stringify({
        settings: { ...data.settings, storeInfo: { ...data.settings.storeInfo, logoUrl: null } },
        timezone: data.timezone,
      }),
    [data.settings, data.timezone],
  );
  const lastSaved = useRef(savedJson);
  useEffect(() => {
    if (lastSaved.current === savedJson) return;
    lastSaved.current = savedJson;
    setDraft(data.settings);
    setTimezone(data.timezone);
  }, [savedJson, data.settings, data.timezone]);

  // Logo upload / remove persist immediately (SettingsGeneral's own fetcher):
  // merge just that one field so the rest of the draft survives.
  const savedLogoUrl = data.settings.storeInfo.logoUrl;
  useEffect(() => {
    setDraft((d) =>
      d.storeInfo.logoUrl === savedLogoUrl
        ? d
        : { ...d, storeInfo: { ...d.storeInfo, logoUrl: savedLogoUrl } },
    );
  }, [savedLogoUrl]);

  const saving = fetcher.state !== "idle";
  // Dirty across EVERY slice, not just the visible tab: switching tabs must
  // not hide (and then silently drop) another tab's unsaved edits.
  const dirtyViews = useMemo(
    () =>
      VIEWS.filter(
        (v) =>
          JSON.stringify(sliceFor(v, draft, timezone)) !==
          JSON.stringify(sliceFor(v, data.settings, data.timezone)),
      ),
    [draft, timezone, data.settings, data.timezone],
  );
  const dirty = dirtyViews.length > 0;

  const save = useCallback(() => {
    if (dirtyViews.length === 0) return;
    fetcher.submit(
      {
        intent: "save-settings",
        payload: JSON.stringify(
          dirtyViews.map((v) => ({
            intent: INTENTS[v],
            payload: sliceFor(v, draft, timezone),
          })),
        ),
      },
      { method: "post" },
    );
  }, [fetcher, dirtyViews, draft, timezone]);

  const discard = useCallback(() => {
    setDraft(data.settings);
    setTimezone(data.timezone);
  }, [data.settings, data.timezone]);

  const discardView = useCallback(
    (view: View) => {
      const init = data.settings;
      setDraft((current) => {
        switch (view) {
          case "general":
            return {
              ...current,
              theme: init.theme,
              inbox: init.inbox,
              storeInfo: {
                ...current.storeInfo,
                name: init.storeInfo.name,
                dateFormat: init.storeInfo.dateFormat,
                timeFormat: init.storeInfo.timeFormat,
              },
            };
          case "chatbox":
            return { ...current, cartDrawer: init.cartDrawer, orderTracking: init.orderTracking };
          case "availability":
            return { ...current, availability: init.availability };
          case "survey":
            return { ...current, survey: init.survey };
          case "privacy":
            return { ...current, retentionDays: init.retentionDays };
        }
      });
      if (view === "availability") setTimezone(data.timezone);
    },
    [data.settings, data.timezone],
  );

  const cancelSubView = useCallback(() => {
    discardView(view);
    go("chatbox");
  }, [discardView, view, go]);

  // Data-request export round-trip → client-side download. Same pattern as the
  // contacts CSV export (app.contacts.tsx): in the embedded admin only
  // App-Bridge-authenticated fetches carry the session token, so the JSON
  // rides back in the action payload and is saved as a Blob here.
  const downloadFetcher = useFetcher<typeof action>();
  const processedDownload = useRef<unknown>(null);
  useEffect(() => {
    const result = downloadFetcher.data;
    if (downloadFetcher.state !== "idle" || !result || processedDownload.current === result) {
      return;
    }
    processedDownload.current = result;
    if (result.intent !== "download-data-request") return;
    if (!result.ok || !("json" in result)) {
      shopify.toast.show(result.error ?? "Export failed — please try again.", { isError: true });
      return;
    }
    const blob = new Blob([result.json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    shopify.toast.show("Data request export downloaded");
  }, [downloadFetcher.state, downloadFetcher.data, shopify]);

  // Order-tracking provider connect (spec 16 delta): own fetcher so the
  // validate+persist round-trip doesn't collide with the SaveBar state.
  const connectFetcher = useFetcher<typeof action>();
  const connecting = connectFetcher.state !== "idle";
  useEffect(() => {
    if (connectFetcher.state !== "idle" || !connectFetcher.data) return;
    if (connectFetcher.data.intent !== "connect-tracking") return;
    if (connectFetcher.data.ok) {
      shopify.toast.show("Order tracking integration updated");
    }
  }, [connectFetcher.state, connectFetcher.data, shopify]);

  const connectError =
    connectFetcher.state === "idle" &&
    connectFetcher.data &&
    connectFetcher.data.intent === "connect-tracking" &&
    !connectFetcher.data.ok
      ? connectFetcher.data.error
      : undefined;

  const lastResult = fetcher.state === "idle" ? fetcher.data : undefined;
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Settings saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const inSubView = view === "availability" || view === "survey";
  const activeTab: View = inSubView ? "chatbox" : view;

  return (
    <s-page heading="Settings">
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />

      <s-stack gap="base">
        {lastResult && !lastResult.ok ? (
          <s-banner tone="critical" heading="Couldn't save settings">
            {lastResult.error ?? "Something went wrong — please try again."}
          </s-banner>
        ) : null}

        <TabPills
          tabs={TABS.map((tab) => ({ id: tab.view, label: tab.label }))}
          active={activeTab}
          onChange={(view) => go(view)}
        />

        {view === "general" ? (
          <SettingsGeneral
            name={draft.storeInfo.name}
            dateFormat={draft.storeInfo.dateFormat}
            timeFormat={draft.storeInfo.timeFormat}
            timeZone={data.timezone}
            onDateFormatChange={(dateFormat) =>
              setDraft((d) => ({ ...d, storeInfo: { ...d.storeInfo, dateFormat } }))
            }
            onTimeFormatChange={(timeFormat) =>
              setDraft((d) => ({ ...d, storeInfo: { ...d.storeInfo, timeFormat } }))
            }
            onOpenAvailability={() => go("availability")}
            placeholderName={data.defaultStoreName}
            logoUrl={draft.storeInfo.logoUrl}
            theme={draft.theme}
            inbox={draft.inbox}
            embedStatus={data.embedStatus}
            shopDomain={data.shopDomain}
            apiKey={data.apiKey}
            owner={data.owner}
            team={data.team}
            reviewUrl={data.reviewUrl}
            onNameChange={(name) =>
              setDraft((d) => ({ ...d, storeInfo: { ...d.storeInfo, name } }))
            }
            onThemeChange={(theme) => setDraft((d) => ({ ...d, theme }))}
            onInboxChange={(inbox) => setDraft((d) => ({ ...d, inbox }))}
          />
        ) : null}

        {view === "chatbox" ? (
          <s-stack gap="base">
            {connectError ? (
              <s-banner tone="critical" heading="Couldn't connect the tracking provider">
                {connectError}
              </s-banner>
            ) : null}
            <SettingsChatbox
              cartDrawer={draft.cartDrawer}
              orderTracking={draft.orderTracking}
              savedTracking={data.settings.orderTracking}
              connecting={connecting}
              onCartDrawerChange={(cartDrawer) => setDraft((d) => ({ ...d, cartDrawer }))}
              onOrderTrackingChange={(orderTracking) => setDraft((d) => ({ ...d, orderTracking }))}
              onConnect={(apiKey) =>
                connectFetcher.submit(
                  { intent: "connect-tracking", payload: JSON.stringify({ apiKey }) },
                  { method: "post" },
                )
              }
              onManageAvailability={() => go("availability")}
              onManageSurvey={() => go("survey")}
            />
          </s-stack>
        ) : null}

        {view === "availability" ? (
          <SettingsAvailability
            value={draft.availability}
            timezone={timezone}
            preview={data.availabilityPreview}
            onChange={(availability) => setDraft((d) => ({ ...d, availability }))}
            onTimezoneChange={setTimezone}
            onCancel={cancelSubView}
          />
        ) : null}

        {view === "survey" ? (
          <SettingsSurvey
            value={draft.survey}
            onChange={(survey) => setDraft((d) => ({ ...d, survey }))}
            onCancel={cancelSubView}
          />
        ) : null}

        {view === "privacy" ? (
          <SettingsPrivacy
            retentionDays={draft.retentionDays}
            dataRequests={data.dataRequests}
            downloadingId={
              downloadFetcher.state !== "idle"
                ? String(downloadFetcher.formData?.get("id") ?? "")
                : null
            }
            onRetentionChange={(retentionDays) => setDraft((d) => ({ ...d, retentionDays }))}
            onDownload={(id) =>
              downloadFetcher.submit({ intent: "download-data-request", id }, { method: "post" })
            }
          />
        ) : null}
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
