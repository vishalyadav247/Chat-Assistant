// Browser-side Web Push helpers for the standalone web surface (spec 18).
// Service worker lives at /sw.js (public/). Subscriptions are stored per
// member via /app/push-subscription.

export type PushState = "unsupported" | "denied" | "default" | "granted";

export function pushState(): PushState {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission as PushState;
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

/** Ask permission (if needed) and register the subscription on the server. */
export async function subscribePush(vapidPublicKey: string): Promise<{ ok: boolean; state: PushState; error?: string }> {
  const state = pushState();
  if (state === "unsupported") return { ok: false, state, error: "This browser doesn't support notifications." };
  if (state === "denied") return { ok: false, state, error: "Notifications are blocked for this site in your browser settings." };
  const permission = state === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, state: permission as PushState, error: "Permission not granted." };
  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      }));
    const res = await fetch("/app/push-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) return { ok: false, state: "granted", error: "Couldn't save the subscription." };
    return { ok: true, state: "granted" };
  } catch (error) {
    console.error("push_subscribe_failed", error);
    return { ok: false, state: pushState(), error: "Couldn't enable notifications." };
  }
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
      headers: { "Content-Type": "application/json" },
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
