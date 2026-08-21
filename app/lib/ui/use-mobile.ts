import { useSyncExternalStore } from "react";
import { MOBILE_MEDIA } from "../../components/ui/tokens";

// Mobile breakpoint hook (spec 19). SSR-safe: the server (and first client
// paint) always report desktop so hydration matches; the real value applies
// in the same pass React subscribes, before the user can interact. Use ONLY
// where markup/attributes must swap (s-grid templates, chart density) —
// plain styling belongs in @media CSS.

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_MEDIA);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_MEDIA).matches,
    () => false,
  );
}
