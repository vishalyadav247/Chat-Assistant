import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Form, NavLink, useLocation } from "react-router";
import { ensurePushSubscribed, pushState, subscribePush } from "../../lib/ui/push-client";

// Standalone web shell (spec 18): rail nav + account footer around the same
// /app pages the Shopify admin renders. No App Bridge here — navigation is
// react-router (NavLink + the shopify:navigate bridge for s-link clicks).

export interface WebNavItem {
  href: string;
  label: string;
  badge?: number;
}

export interface WebShellProps {
  shopName: string;
  shopDomain: string;
  member: { name: string; role: string; email: string };
  nav: WebNavItem[];
  vapidPublicKey: string;
  /** The member's push preference (any event enabled). */
  pushWanted: boolean;
  children: ReactNode;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

const DISMISS_KEY = "cc_push_notice_dismissed";

export function WebShell(props: WebShellProps) {
  const location = useLocation();
  const adminUrl = `https://admin.shopify.com/store/${props.shopDomain.replace(".myshopify.com", "")}/apps`;

  // Push: re-sync silently when already granted; otherwise offer once.
  const [notice, setNotice] = useState<"hidden" | "offer" | "busy" | "error">("hidden");
  const [noticeError, setNoticeError] = useState("");
  useEffect(() => {
    if (!props.vapidPublicKey || !props.pushWanted) return;
    const state = pushState();
    if (state === "granted") {
      // Re-sync once per browser session (subscriptions rotate, rows get pruned).
      if (window.sessionStorage.getItem("cc_push_synced") !== "1") {
        window.sessionStorage.setItem("cc_push_synced", "1");
        void ensurePushSubscribed(props.vapidPublicKey);
      }
    } else if (state === "default" && window.localStorage.getItem(DISMISS_KEY) !== "1") {
      setNotice("offer");
    }
  }, [props.vapidPublicKey, props.pushWanted]);

  const enable = async () => {
    setNotice("busy");
    const result = await subscribePush(props.vapidPublicKey);
    if (result.ok) {
      setNotice("hidden");
    } else {
      setNoticeError(result.error ?? "Couldn't enable notifications.");
      setNotice("error");
    }
  };
  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setNotice("hidden");
  };

  return (
    <div className="ccws-shell">
      <aside className="ccws-rail" aria-label="ChatConvert navigation">
        <div className="ccws-brand">
          <div className="ccws-brandMark" aria-hidden="true">
            C
          </div>
          <div className="ccws-brandText">
            <span className="ccws-brandName">ChatConvert</span>
            <span className="ccws-brandShop" title={props.shopDomain}>
              {props.shopName}
            </span>
          </div>
        </div>
        <nav className="ccws-nav">
          {props.nav.map((item) => {
            const active =
              item.href === "/app" ? location.pathname === "/app" : location.pathname.startsWith(item.href);
            return (
              <NavLink
                key={item.href}
                to={item.href}
                className={active ? "ccws-navItem ccws-navItemActive" : "ccws-navItem"}
                aria-current={active ? "page" : undefined}
              >
                <span>{item.label}</span>
                {item.badge ? <span className="ccws-badge">{item.badge > 99 ? "99+" : item.badge}</span> : null}
              </NavLink>
            );
          })}
        </nav>
        <div className="ccws-railFooter">
          <NavLink to="/app/account" className="ccws-user" title={props.member.email}>
            <span className="ccws-avatar" aria-hidden="true">
              {initials(props.member.name)}
            </span>
            <span className="ccws-userMeta">
              <span className="ccws-userName">{props.member.name}</span>
              <span className="ccws-userRole">{props.member.role} · Account</span>
            </span>
          </NavLink>
          <a className="ccws-railLink" href={adminUrl} target="_blank" rel="noopener noreferrer">
            Open Shopify admin ↗
          </a>
          <Form method="post" action="/web/logout">
            <button type="submit" className="ccws-railLink">
              Sign out
            </button>
          </Form>
        </div>
      </aside>
      <div className="ccws-main">
        {notice !== "hidden" ? (
          <div className="ccws-notice" role="status">
            <span>
              {notice === "error"
                ? noticeError
                : "Get a browser notification when a shopper needs a human — even when this tab is in the background."}
            </span>
            <span className="ccws-noticeActions">
              {notice !== "error" ? (
                <button type="button" className="ccws-noticeButton" onClick={enable} disabled={notice === "busy"}>
                  {notice === "busy" ? "Enabling…" : "Enable notifications"}
                </button>
              ) : null}
              <button type="button" className="ccws-noticeGhost" onClick={dismiss}>
                {notice === "error" ? "Dismiss" : "Not now"}
              </button>
            </span>
          </div>
        ) : null}
        <div className="ccws-content">{props.children}</div>
      </div>
    </div>
  );
}
