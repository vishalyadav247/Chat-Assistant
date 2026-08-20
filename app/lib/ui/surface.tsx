import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

// Surface context (spec 18). The same /app/* pages render inside the Shopify
// admin (App Bridge present → window.shopify) and on the standalone web
// surface (no App Bridge). Components keep calling `useAppBridge()` — this
// module's shim returns the real global in the admin and a small compatible
// object (toast) on the web, so call sites don't branch.

export type Surface = "admin" | "web";

export interface ToastOptions {
  isError?: boolean;
  duration?: number;
}

export interface ShopifyLike {
  toast: { show: (message: string, options?: ToastOptions) => void };
  // Present only in the admin (real App Bridge). Call sites already guard.
  saveBar?: { show?: (id: string) => void; hide?: (id: string) => void };
  reviews?: { request: () => Promise<{ success: boolean; code: string; message?: string }> };
  [key: string]: unknown;
}

interface ToastItem {
  id: number;
  message: string;
  isError: boolean;
}

interface SurfaceContextValue {
  surface: Surface;
  shim: ShopifyLike;
}

const SurfaceContext = createContext<SurfaceContextValue>({
  surface: "admin",
  shim: { toast: { show: () => undefined } },
});

const serverProxy = new Proxy({} as ShopifyLike, {
  get(_, prop) {
    throw Error(`shopify.${String(prop)} can't be used in a server environment. Move this into an effect.`);
  },
});

export function SurfaceProvider({ surface, children }: { surface: Surface; children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const show = useCallback((message: string, options?: ToastOptions) => {
    const id = ++counter.current;
    setToasts((list) => [...list, { id, message, isError: Boolean(options?.isError) }]);
    const ttl = options?.duration ?? (options?.isError ? 6000 : 3500);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ttl);
  }, []);

  const shim = useMemo<ShopifyLike>(() => ({ toast: { show } }), [show]);
  const value = useMemo(() => ({ surface, shim }), [surface, shim]);

  return (
    <SurfaceContext.Provider value={value}>
      {children}
      <WebToastHost toasts={toasts} />
    </SurfaceContext.Provider>
  );
}

export function useSurface(): Surface {
  return useContext(SurfaceContext).surface;
}

/** Drop-in replacement for `@shopify/app-bridge-react`'s useAppBridge. */
export function useAppBridge(): ShopifyLike {
  const { surface, shim } = useContext(SurfaceContext);
  if (surface === "web") return shim;
  if (typeof window === "undefined") return serverProxy;
  const global = (window as unknown as { shopify?: ShopifyLike }).shopify;
  if (!global) {
    // App Bridge script not (yet) loaded — degrade to the web shim instead of
    // crashing the page.
    return shim;
  }
  return global;
}

function WebToastHost({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 1000,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            background: t.isError ? "#8e1f0b" : "#1a1a1a",
            color: "#fff",
            padding: "10px 16px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: "0 4px 16px rgba(0,0,0,.24)",
            maxWidth: 420,
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

/** Mirrors AppProvider's embedded behaviour: polaris.js dispatches
 *  `shopify:navigate` for same-origin s-link / s-button[href] clicks; routing
 *  them through react-router keeps the web surface a single-page app. */
export function NavigateBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const handle = (event: Event) => {
      const target = event.target as Element | null;
      const href = target?.getAttribute?.("href");
      if (href) navigate(href);
    };
    document.addEventListener("shopify:navigate", handle);
    return () => document.removeEventListener("shopify:navigate", handle);
  }, [navigate]);
  return null;
}
