// SynChat service worker: makes the app installable, lets it open without a network,
// and shows push notifications. Plain JavaScript, served from the site root.

const SHELL = "synchat-shell-v1";

self.addEventListener("install", (event) => {
  // Keep a copy of the page itself so the app can at least open offline.
  event.waitUntil(caches.open(SHELL).then((cache) => cache.add("/")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never cache the API, uploads or the socket: messages must always come from the server.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/") || url.pathname.startsWith("/uploads/")) return;

  if (request.mode === "navigate") {
    // Pages: the network first, so a new version is picked up; the saved copy when offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    // Built files have a content hash in their name, so a cached copy is never stale.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* an unreadable payload still gets a generic notification below */
  }
  const title = typeof data.title === "string" ? data.title : "SynChat";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "New message",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // One notification per chat: a newer message replaces the older one.
      tag: typeof data.conversationId === "string" ? data.conversationId : undefined,
      renotify: true,
      data: { conversationId: data.conversationId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data && event.notification.data.conversationId;
  const target = conversationId ? `/?c=${encodeURIComponent(conversationId)}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Use a SynChat window that is already open, if there is one.
      const existing = clients[0];
      if (existing) {
        existing.postMessage({ type: "open-conversation", conversationId });
        return existing.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
