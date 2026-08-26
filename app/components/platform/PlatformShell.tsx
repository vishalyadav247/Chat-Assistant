import { useRef, useState, type ReactNode } from "react";
import { Form, NavLink, useLocation } from "react-router";
import { ConfirmDeleteModal } from "../ui/ConfirmDeleteModal";
import { useNavDrawer } from "../web/use-nav-drawer";

// Chrome for the authed /platform pages (spec 19).
//
// CONSISTENCY RULE (user, 2026-08-20): the operator console must look like the
// rest of ChatConvert, not like a third product. It therefore reuses the WEB
// SHELL's markup and stylesheet verbatim (`ccws-*` in web-shell.css) — same
// rail, brand mark, nav treatment, active state and content surface as
// /app on the standalone web surface. The ONLY additions are a "Platform"
// badge next to the brand so an operator can tell the surfaces apart.
// Page bodies use Polaris <s-page>/<s-section> + app/components/ui, exactly
// like every merchant page.
//
// NOT a security boundary — every loader/action calls requirePlatformAdmin.

const NAV: { href: string; label: string; icon: string; end?: boolean }[] = [
  { href: "/platform", label: "Overview", icon: "home", end: true },
  { href: "/platform/usage", label: "Usage", icon: "chart-line" },
  { href: "/platform/logs", label: "Logs", icon: "alert-triangle" },
  { href: "/platform/ai", label: "AI model", icon: "wand" },
  { href: "/platform/plans", label: "Plans", icon: "credit-card" },
  { href: "/platform/promo-codes", label: "Coupons", icon: "discount" },
  { href: "/platform/settings", label: "Settings", icon: "settings" },
  { href: "/platform/admins", label: "Admins", icon: "person" },
];

function initials(value: string): string {
  return value.slice(0, 2).toUpperCase() || "?";
}

export function PlatformShell(props: { adminEmail: string; children: ReactNode }) {
  const location = useLocation();
  // Sign-out asks first (user, 2026-08-20) — the form submits only on confirm.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const signOutForm = useRef<HTMLFormElement>(null);
  // ≤900px the rail is a slide-in drawer (web-shell.css); without the top bar
  // and this state an operator on a phone had NO way to navigate. Same hook,
  // same markup and same classes as WebShell so the two surfaces behave alike.
  const { open: drawerOpen, setOpen: setDrawerOpen, navRef, railRef, menuBtnRef } = useNavDrawer();

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
          <span className="ccws-topbarShop">Platform console</span>
        </span>
        <NavLink
          to="/platform/settings"
          className="ccws-topbarAvatar"
          aria-label="Platform settings"
          title={props.adminEmail}
        >
          {initials(props.adminEmail)}
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
        aria-label="Platform navigation"
        // Complementary landmark as a desktop rail; a real modal dialog while
        // it is the ≤900px drawer (scrim + focus trap + Escape).
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
      >
        <div className="ccws-brand">
          <div className="ccws-brandMark" aria-hidden="true">
            C
          </div>
          <div className="ccws-brandText">
            <span className="ccws-brandName">ChatConvert</span>
            <span className="ccws-brandShop">Platform console</span>
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
          {NAV.map((item) => {
            const active = item.end
              ? location.pathname === item.href
              : location.pathname.startsWith(item.href);
            return (
              <NavLink
                key={item.href}
                to={item.href}
                className={active ? "ccws-navItem ccws-navItemActive" : "ccws-navItem"}
                aria-current={active ? "page" : undefined}
              >
                <span className="ccws-navMain">
                  <span className="ccws-navIcon" aria-hidden="true">
                    <s-icon type={item.icon as never} size="small" />
                  </span>
                  <span className="ccws-navLabel">{item.label}</span>
                </span>
              </NavLink>
            );
          })}
        </nav>
        <div className="ccws-railFooter">
          <div className="ccws-user" title={props.adminEmail}>
            <span className="ccws-avatar" aria-hidden="true">
              {initials(props.adminEmail)}
            </span>
            <span className="ccws-userMeta">
              <span className="ccws-userName">{props.adminEmail}</span>
              <span className="ccws-userRole">Platform admin</span>
            </span>
          </div>
          <Form method="post" action="/platform/logout" ref={signOutForm}>
            <button type="button" className="ccws-railLink" onClick={() => setConfirmSignOut(true)}>
              Sign out
            </button>
          </Form>
        </div>
      </aside>
      <div className="ccws-main">
        <div className="ccws-content">{props.children}</div>
      </div>
      <ConfirmDeleteModal
        open={confirmSignOut}
        title="Sign out of the platform console?"
        body="You'll need your email and password to sign back in."
        confirmLabel="Sign out"
        onConfirm={() => signOutForm.current?.requestSubmit()}
        onCancel={() => setConfirmSignOut(false)}
      />
    </div>
  );
}
