/* ChatConvert web push service worker (spec 18).
   Shows team notifications and focuses/opens the inbox on click. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

var FALLBACK_URL = "/web/login?next=%2Fapp%2Finbox";

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "ChatConvert", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "ChatConvert";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || FALLBACK_URL },
    icon: "/favicon.ico",
    badge: "/favicon.ico",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || FALLBACK_URL;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Prefer an open top-level web-app tab (never an embedded admin iframe).
        for (const client of clients) {
          try {
            const u = new URL(client.url);
            const topLevel = !client.frameType || client.frameType === "top-level";
            if (topLevel && u.pathname.startsWith("/app")) {
              if ("navigate" in client) {
                return client
                  .navigate(url)
                  .then((c) => (c || client).focus())
                  .catch(() => self.clients.openWindow(url));
              }
              return client.focus();
            }
          } catch (e) {
            /* ignore */
          }
        }
        return self.clients.openWindow(url);
      })
      .catch(() => self.clients.openWindow(url)),
  );
});
