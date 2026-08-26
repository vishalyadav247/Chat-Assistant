import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

// The ≤900px nav drawer behaviour shared by the web shell (spec 18) and the
// operator console (spec 19). Extracted so /platform gets the identical drawer
// instead of a rail that CSS hides off-screen with no way to open it.
//
// Contract: scroll lock + focus trap + Escape while open, focus returned to the
// opener on close, and the drawer closes on every navigation.

export function useNavDrawer() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;
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
        setOpen(false);
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
  }, [open]);

  return { open, setOpen, navRef, railRef, menuBtnRef };
}
