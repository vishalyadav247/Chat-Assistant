import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, NavLink, useLocation, useRouteLoaderData } from "react-router";
import { ConfirmDeleteModal } from "../ui/ConfirmDeleteModal";
import { useNavDrawer } from "../web/use-nav-drawer";
import { AdminSegmented, Icon, type IconName, type ThemePref } from "./AdminUi";
import { THEME_COOKIE, isThemePref } from "./theme";

// Chrome for the authed /admin pages (spec 19, redesigned 2026-09-03).
//
// This used to reuse the merchant web app's shell verbatim (`ccws-*` in
// web-shell.css) under a 2026-08-20 "the console must not look like a third
// product" rule. The user has since asked for a distinct, glass, mobile-first
// console — which cannot happen while a merchant surface shares the file — so
// the chrome now has its OWN classes (`cca-*` in admin.css) and web-shell.css
// is untouched by it. The drawer BEHAVIOUR is still the shared hook, so the two
// surfaces still open, trap focus and close the same way.
//
// NOT a security boundary — every loader/action calls requireAdminUser.

const NAV: { href: string; label: string; icon: IconName; end?: boolean }[] = [
  { href: "/admin", label: "Overview", icon: "home", end: true },
  { href: "/admin/usage", label: "Usage", icon: "chart" },
  { href: "/admin/logs", label: "Logs", icon: "alert" },
  { href: "/admin/ai", label: "AI model", icon: "wand" },
  { href: "/admin/plans", label: "Plans", icon: "card" },
  { href: "/admin/promo-codes", label: "Coupons", icon: "tag" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
  { href: "/admin/access", label: "Access", icon: "users" },
];

const THEME_OPTIONS: Array<{ value: ThemePref; label: string; icon: IconName }> = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "Auto", icon: "monitor" },
];

function initials(value: string): string {
  return value.slice(0, 2).toUpperCase() || "?";
}

export function AdminShell(props: { adminEmail: string; children: ReactNode }) {
  const location = useLocation();
  // Sign-out asks first (user, 2026-08-20) — the form submits only on confirm.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const signOutForm = useRef<HTMLFormElement>(null);
  const { open: drawerOpen, setOpen: setDrawerOpen, navRef, railRef, menuBtnRef } = useNavDrawer();

  // The layout loader read the cookie server-side, so the first paint is
  // already in the right theme — no flash, no blocking inline script.
  const layout = useRouteLoaderData("routes/admin") as { theme?: string } | undefined;
  const [theme, setTheme] = useState<ThemePref>(
    isThemePref(layout?.theme) ? layout.theme : "system",
  );
  useEffect(() => {
    // A year-long cookie rather than localStorage: only the cookie reaches the
    // server, and only the server can prevent the flash.
    document.cookie = `${THEME_COOKIE}=${theme};path=/;max-age=31536000;samesite=lax`;
  }, [theme]);

  const title = NAV.find((item) =>
    item.end ? location.pathname === item.href : location.pathname.startsWith(item.href),
  )?.label;

  return (
    <div className="cca" data-theme={theme}>
      <div className="cca-shell">
        <header className="cca-topbar">
          <button
            type="button"
            ref={menuBtnRef}
            className="cca-iconbtn"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="cca-topbar__title">{title ?? "Admin"}</span>
          <AdminSegmented
            ariaLabel="Colour theme"
            size="small"
            value={theme}
            options={THEME_OPTIONS}
            onChange={setTheme}
          />
        </header>

        {drawerOpen ? (
          <button
            type="button"
            className="cca-scrim"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          />
        ) : null}

        <aside
          ref={railRef}
          className={drawerOpen ? "cca-rail is-open" : "cca-rail"}
          aria-label="Admin navigation"
          // Complementary landmark as a desktop rail; a real modal dialog while
          // it is the ≤900px drawer (scrim + focus trap + Escape).
          role={drawerOpen ? "dialog" : undefined}
          aria-modal={drawerOpen ? true : undefined}
        >
          <div className="cca-brand">
            <span className="cca-brand__mark" aria-hidden="true">
              C
            </span>
            <span className="cca-brand__text">
              <span className="cca-brand__name">ChatConvert</span>
              <span className="cca-brand__sub">Admin console</span>
            </span>
            <button
              type="button"
              className="cca-iconbtn cca-rail__close"
              aria-label="Close navigation"
              onClick={() => setDrawerOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>

          <nav className="cca-nav" ref={navRef}>
            {NAV.map((item) => {
              const active = item.end
                ? location.pathname === item.href
                : location.pathname.startsWith(item.href);
              return (
                <NavLink
                  key={item.href}
                  to={item.href}
                  className={active ? "cca-nav__item is-active" : "cca-nav__item"}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>

          <div className="cca-railfoot">
            <AdminSegmented
              ariaLabel="Colour theme"
              value={theme}
              options={THEME_OPTIONS}
              onChange={setTheme}
            />
            <div className="cca-user" title={props.adminEmail}>
              <span className="cca-avatar" aria-hidden="true">
                {initials(props.adminEmail)}
              </span>
              <span className="cca-user__text">
                <span className="cca-user__name">{props.adminEmail}</span>
                <span className="cca-user__role">Admin</span>
              </span>
            </div>
            <Form method="post" action="/admin/logout" ref={signOutForm}>
              <button
                type="button"
                className="cca-btn cca-btn--ghost"
                onClick={() => setConfirmSignOut(true)}
              >
                <Icon name="logout" />
                <span>Sign out</span>
              </button>
            </Form>
          </div>
        </aside>

        <main className="cca-main">{props.children}</main>
      </div>

      <ConfirmDeleteModal
        open={confirmSignOut}
        title="Sign out of the admin console?"
        body="You'll need your email and password to sign back in."
        confirmLabel="Sign out"
        onConfirm={() => signOutForm.current?.requestSubmit()}
        onCancel={() => setConfirmSignOut(false)}
      />
    </div>
  );
}
