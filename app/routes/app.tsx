import type {
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import db from "../db.server";

import { can, requireShopAccess, type Permission } from "../lib/access.server";
import { parseNotifyPrefs } from "../lib/team/team.server";
import { resolveReviewPromptEligible } from "../lib/review.server";
import { getDateTimePrefs } from "../lib/format/prefs.server";
import { getVapidPublicKey } from "../lib/notify/vapid.server";
import { DateTimeProvider } from "../lib/format/context";
import { NavigateBridge, SurfaceProvider } from "../lib/ui/surface";
import { AppLoading } from "../components/AppLoading";
import { ReviewPrompt } from "../components/ReviewPrompt";
import { WebShell } from "../components/web/WebShell";
import { routeError } from "../lib/ui/route-error";
import webShellStylesHref from "../components/web/web-shell.css?url";
import appMobileStylesHref from "../components/app-mobile.css?url";
import appLoadingStylesHref from "../components/app-loading.css?url";

// Layout for every /app/* page on BOTH surfaces (spec 18):
//   admin → App Bridge + <s-app-nav> (unchanged embedded experience)
//   web   → ChatConvert shell (no App Bridge), role-filtered nav, push prompt

// icon: Polaris icon name, shown only in the web shell's mobile drawer
// (spec 20) — the desktop rail and admin <s-app-nav> stay text-only.
const NAV: Array<{ href: string; label: string; permission: Permission; icon: string }> = [
  { href: "/app", label: "Dashboard", permission: "dashboard", icon: "home" },
  { href: "/app/inbox", label: "Inbox", permission: "inbox", icon: "chat" },
  { href: "/app/contacts", label: "Contacts", permission: "contacts", icon: "person" },
  { href: "/app/chatbox", label: "Chatbox", permission: "chatbox", icon: "text-block" },
  { href: "/app/ai-agent", label: "AI Agent", permission: "ai_agent", icon: "wand" },
  {
    href: "/app/proactive-chat",
    label: "Proactive Chat",
    permission: "proactive",
    icon: "megaphone",
  },
  {
    href: "/app/curated-answers",
    label: "Curated Answers",
    permission: "curated",
    icon: "book-open",
  },
  { href: "/app/analytics", label: "Analytics", permission: "analytics", icon: "chart-line" },
  { href: "/app/plan-usage", label: "Plan & Usage", permission: "plan", icon: "credit-card" },
  { href: "/app/settings", label: "Settings", permission: "settings", icon: "settings" },
];

// Served as a <link> (not a CSS module) so the stylesheet survives a client
// re-render of the document — in dev a hydration mismatch anywhere would
// otherwise drop Vite's injected styles and unstyle the web shell.
export const links: LinksFunction = () => [
  { rel: "stylesheet", href: webShellStylesHref },
  { rel: "stylesheet", href: appMobileStylesHref },
  { rel: "stylesheet", href: appLoadingStylesHref },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request);
  // Shop-wide date/time display preference (Settings → General) for every page.
  const dateTimePrefs = await getDateTimePrefs(access.shopId);

  if (access.surface === "admin") {
    const reviewPromptEligible = await resolveReviewPromptEligible(
      access.shopDomain,
    );
    return {
      surface: "admin" as const,
      dateTimePrefs,
      // eslint-disable-next-line no-undef
      apiKey: process.env.SHOPIFY_API_KEY || "",
      reviewPromptEligible,
    };
  }

  const member = access.member!;
  const [shop, unread] = await Promise.all([
    db.shop.findUnique({
      where: { id: access.shopId },
      select: { name: true },
    }),
    db.conversation.count({
      where: {
        shopId: access.shopId,
        isTest: false,
        unread: true,
        status: "open",
        blocked: false,
      },
    }),
  ]);
  const prefs = parseNotifyPrefs(member.notifyPrefs, member.role);
  return {
    surface: "web" as const,
    dateTimePrefs,
    shopName: shop?.name || access.shopDomain.replace(".myshopify.com", ""),
    shopDomain: access.shopDomain,
    member: { name: member.name, role: member.role, email: member.email },
    nav: NAV.filter((item) => can(access.role, "web", item.permission)).map(
      (item) => ({
        href: item.href,
        label: item.label,
        icon: item.icon,
        badge: item.href === "/app/inbox" && unread > 0 ? unread : undefined,
      }),
    ),
    vapidPublicKey: await getVapidPublicKey(),
    pushWanted:
      prefs.push.handover ||
      prefs.push.humanReply ||
      prefs.push.newConversation,
  };
};

export default function App() {
  const data = useLoaderData<typeof loader>();

  if (data.surface === "web") {
    return (
      <>
        <AppLoading />
        <AppProvider embedded={false}>
          <SurfaceProvider surface="web">
            <DateTimeProvider prefs={data.dateTimePrefs}>
              <NavigateBridge />
              <WebShell
                shopName={data.shopName}
                shopDomain={data.shopDomain}
                member={data.member}
                nav={data.nav}
                vapidPublicKey={data.vapidPublicKey}
                pushWanted={data.pushWanted}
              >
                <Outlet />
              </WebShell>
            </DateTimeProvider>
          </SurfaceProvider>
        </AppProvider>
      </>
    );
  }

  return (
    <>
      <AppLoading />
      <AppProvider embedded apiKey={data.apiKey}>
        <SurfaceProvider surface="admin">
          <DateTimeProvider prefs={data.dateTimePrefs}>
            <s-app-nav>
              {NAV.map((item) => (
                <s-link key={item.href} href={item.href}>
                  {item.label}
                </s-link>
              ))}
            </s-app-nav>
            <ReviewPrompt eligible={data.reviewPromptEligible} />
            <Outlet />
          </DateTimeProvider>
        </SurfaceProvider>
      </AppProvider>
    </>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  // 403 (web-surface role gate) renders the shared "No access" page; other
  // errors keep Shopify's boundary behaviour.
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
