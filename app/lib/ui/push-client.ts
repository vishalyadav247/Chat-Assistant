// Browser-side Web Push helpers for the standalone web surface (spec 18).
// Service worker lives at /sw.js (public/). Subscriptions are stored per
// member via /app/push-subscription.

export type PushState = "unsupported" | "denied" | "default" | "granted";

/** Why enabling failed — lets call sites give an actionable message. */
export type PushFailure =
  | "insecure"
  | "unsupported"
  | "ios-install"
  | "denied"
  | "dismissed"
  | "session"
  | "plan"
  | "server"
  | "browser";

export interface PushResult {
  ok: boolean;
  state: PushState;
  reason?: PushFailure;
  /** Friendly, shown to the member. */
  error?: string;
  /** Raw technical cause (exception name/message, HTTP status) — surfaced in
   *  the account page's checklist and reported to the server log, because
   *  "it didn't work" on someone else's phone is otherwise undebuggable. */
  detail?: string;
}

export function pushState(): PushState {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission as PushState;
}

/** iOS/iPadOS only exposes Notification + PushManager to a web app that was
 *  added to the Home Screen (iOS 16.4+). In a normal Safari tab the APIs are
 *  simply absent, so "unsupported" there means "not installed yet". */
export function needsIosInstall(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iOS) return false;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return !standalone;
}

/** Browsers expose service workers and the Notification API only in a secure
 *  context: https, or localhost. A phone opening the app on a LAN address like
 *  http://192.168.1.5:3000 gets neither — the usual reason "enable" does
 *  nothing on a phone while it works on the dev machine. */
export function isInsecureContext(): boolean {
  if (typeof window === "undefined") return false;
  return !window.isSecureContext;
}

/** Everything that has to be true on THIS device for push to work — rendered
 *  as a checklist on the account page so a failure names itself. */
export interface PushDiagnostics {
  origin: string;
  secureContext: boolean;
  serviceWorkerApi: boolean;
  pushApi: boolean;
  notificationApi: boolean;
  permission: string;
  iosNeedsInstall: boolean;
  serviceWorkerRegistered: boolean;
  subscribedHere: boolean;
  endpointHost: string | null;
}

export async function pushDiagnostics(): Promise<PushDiagnostics> {
  const hasSw = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  let registration: ServiceWorkerRegistration | undefined;
  let subscription: PushSubscription | null = null;
  if (hasSw) {
    try {
      registration = await navigator.serviceWorker.getRegistration("/");
      subscription = (await registration?.pushManager.getSubscription()) ?? null;
    } catch {
      /* reported as "not registered" below */
    }
  }
  return {
    origin: typeof window === "undefined" ? "" : window.location.origin,
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    serviceWorkerApi: hasSw,
    pushApi: typeof window !== "undefined" && "PushManager" in window,
    notificationApi: typeof window !== "undefined" && "Notification" in window,
    permission: typeof Notification === "undefined" ? "unavailable" : Notification.permission,
    iosNeedsInstall: needsIosInstall(),
    serviceWorkerRegistered: Boolean(registration),
    subscribedHere: Boolean(subscription),
    endpointHost: subscription ? new URL(subscription.endpoint).host : null,
  };
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const applied = sub.options?.applicationServerKey;
  if (!applied) return false;
  const bytes = new Uint8Array(applied);
  if (bytes.length !== key.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] !== key[i]) return false;
  return true;
}

/** POST the subscription and translate the response into a failure reason.
 *  A missing/expired web session redirects to /web/login, and fetch follows
 *  redirects — so a 200 that isn't our JSON means "signed out", not "saved". */
async function storeSubscription(
  sub: PushSubscription,
): Promise<{ reason: PushFailure; detail: string } | null> {
  let res: Response;
  try {
    res = await fetch("/app/push-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(sub.toJSON()),
    });
  } catch (error) {
    return { reason: "server", detail: `fetch failed: ${(error as Error)?.message ?? error}` };
  }
  const where = `POST ${res.status}${res.redirected ? " (redirected)" : ""}`;
  if (res.status === 401) return { reason: "session", detail: where };
  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    return { reason: /plan/i.test(body) ? "plan" : "session", detail: `${where} ${body.slice(0, 80)}` };
  }
  if (!res.ok) return { reason: "server", detail: where };
  if (res.redirected || !(res.headers.get("content-type") ?? "").includes("json")) {
    return { reason: "session", detail: `${where} ${res.headers.get("content-type") ?? "no content-type"}` };
  }
  return null;
}

const MESSAGES: Record<PushFailure, string> = {
  insecure:
    "Notifications need a secure connection. Open the app on its https:// address — a plain http:// address (a LAN IP like 192.168.x.x) can't register them.",
  unsupported: "This browser doesn't support notifications.",
  "ios-install": "On iPhone and iPad, add ChatConvert to your Home Screen first, then open it from there.",
  denied: "Notifications are blocked for this site — allow them in your browser's site settings, then reload.",
  dismissed: "Permission wasn't granted. Tap Enable again and choose Allow.",
  session: "Your session expired — sign in again, then enable notifications.",
  plan: "Browser notifications are available on the Basic plan and above.",
  server: "Couldn't save the subscription. Check your connection and try again.",
  browser: "Your browser couldn't complete the subscription. Try reloading the page.",
};

function fail(reason: PushFailure, state: PushState, detail?: string): PushResult {
  return { ok: false, state, reason, error: MESSAGES[reason], detail };
}

/** Ask permission (if needed) and register the subscription on the server. */
export async function subscribePush(vapidPublicKey: string): Promise<PushResult> {
  const state = pushState();
  if (state === "unsupported") {
    if (isInsecureContext()) return fail("insecure", state);
    return fail(needsIosInstall() ? "ios-install" : "unsupported", state);
  }
  if (state === "denied") return fail("denied", state);
  if (!vapidPublicKey) return fail("server", state);
  const permission = state === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return fail("dismissed", permission as PushState);
  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const key = urlBase64ToUint8Array(vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with a different VAPID key still looks valid to the
    // browser but every send is rejected — drop it and make a fresh one.
    if (sub && !sameKey(sub, key)) {
      await sub.unsubscribe().catch(() => undefined);
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key as BufferSource,
      });
    }
    const failure = await storeSubscription(sub);
    if (failure) return report(fail(failure.reason, "granted", failure.detail));
    return { ok: true, state: "granted" };
  } catch (error) {
    console.error("push_subscribe_failed", error);
    const err = error as Error;
    return report(fail("browser", pushState(), `${err?.name ?? "Error"}: ${err?.message ?? String(error)}`));
  }
}

/** Send the failure to the server log so it can be diagnosed without the
 *  device in hand. Fire-and-forget; never changes the result. */
function report(result: PushResult): PushResult {
  try {
    void fetch("/app/push-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify({
        report: {
          reason: result.reason,
          detail: result.detail,
          state: result.state,
          origin: window.location.origin,
          standalone: !needsIosInstall(),
        },
      }),
    }).catch(() => undefined);
  } catch {
    /* diagnostics must never break the flow */
  }
  return result;
}

/** Silent re-sync: permission already granted → make sure the server knows
 *  this browser (subscriptions rotate, DB rows get pruned). */
export async function ensurePushSubscribed(vapidPublicKey: string): Promise<void> {
  if (pushState() !== "granted" || !vapidPublicKey) return;
  await subscribePush(vapidPublicKey).catch(() => undefined);
}

export async function unsubscribePush(): Promise<void> {
  if (pushState() === "unsupported") return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/app/push-subscription", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined);
    await sub.unsubscribe();
  } catch (error) {
    console.error("push_unsubscribe_failed", error);
  }
}

/** True when this browser currently holds a push subscription. */
export async function hasPushSubscription(): Promise<boolean> {
  if (pushState() !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return Boolean(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}
