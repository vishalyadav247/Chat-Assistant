import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Form, NavLink, useLocation } from "react-router";
import { ensurePushSubscribed, pushState, subscribePush } from "../../lib/ui/push-client";

// Standalone web shell (spec 18): rail nav + account footer around the same
// /app pages the Shopify admin renders. No App Bridge here — navigation is
// react-router (NavLink + the shopify:navigate bridge for s-link clicks).

export interface WebNavItem {
  href: string;
  label: string;
  /** Polaris icon name — rendered only in the mobile drawer (spec 20). */
  icon?: string;
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
  const inboxBadge = props.nav.find((item) => item.href === "/app/inbox")?.badge ?? 0;

  // Mobile drawer (spec 19): the same rail markup slides in ≤900px; CSS alone
  // decides rail vs drawer so desktop DOM is unchanged.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!drawerOpen) return;
    // Scroll lock + focus trap while the drawer is open; focus goes back to
    // the hamburger on close (the rail is the only focusable region meanwhile).
    document.documentElement.classList.add("ccws-drawerLock");
    const opener = menuBtnRef.current; // captured for the cleanup (ref may change)
    navRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const focusable = () =>
      Array.from(
        railRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !railRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !railRef.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("ccws-drawerLock");
      opener?.focus();
    };
  }, [drawerOpen]);

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
      <header className="ccws-topbar">
        <button
          type="button"
          ref={menuBtnRef}
          className="ccws-menuBtn"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <s-icon type="menu" />
        </button>
        <div className="ccws-brandMark" aria-hidden="true">
          C
        </div>
        <span className="ccws-topbarText">
          <span className="ccws-topbarName">ChatConvert</span>
          <span className="ccws-topbarShop" title={props.shopDomain}>
            {props.shopName}
          </span>
        </span>
        {inboxBadge > 0 ? (
          <NavLink to="/app/inbox" className="ccws-topbarInbox">
            Inbox
            <span className="ccws-badge">{inboxBadge > 99 ? "99+" : inboxBadge}</span>
          </NavLink>
        ) : null}
        <NavLink to="/app/account" className="ccws-topbarAvatar" aria-label="Account" title={props.member.email}>
          {initials(props.member.name)}
        </NavLink>
      </header>
      {drawerOpen ? (
        <button
          type="button"
          className="ccws-scrim"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}
      <aside
        ref={railRef}
        className={drawerOpen ? "ccws-rail ccws-railOpen" : "ccws-rail"}
        aria-label="ChatConvert navigation"
        // Complementary landmark as a desktop rail; a real modal dialog while
        // it is the ≤900px drawer (scrim + focus trap + Escape). The drawer can
        // only open from the top bar, which CSS hides above 900px.
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
      >
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
          <button
            type="button"
            className="ccws-railClose"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          >
            <s-icon type="x" />
          </button>
        </div>
        <nav className="ccws-nav" ref={navRef}>
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
                <span className="ccws-navMain">
                  {item.icon ? (
                    <span className="ccws-navIcon" aria-hidden="true">
                      <s-icon type={item.icon as never} size="small" />
                    </span>
                  ) : null}
                  <span className="ccws-navLabel">{item.label}</span>
                </span>
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
