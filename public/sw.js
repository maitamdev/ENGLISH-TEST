const STATIC_CACHE = "lexiduel-static-v1";
const STATIC_PATHS = ["/images/lexi-host.png", "/images/product-board.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_PATHS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || request.mode === "navigate") return;
  if (!url.pathname.startsWith("/_next/static/") && !url.pathname.startsWith("/images/")) return;
  event.respondWith(caches.match(request).then((cached) => {
    const fresh = fetch(request).then((response) => { if (response.ok) void caches.open(STATIC_CACHE).then((cache) => cache.put(request, response.clone())); return response; });
    return cached || fresh;
  }));
});

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(payload.title || "LexiDuel", { body: payload.body || "Bạn có một hoạt động học tập mới.", icon: "/images/lexi-host.png", badge: "/images/lexi-host.png", data: { url: payload.url || "/dashboard" }, tag: payload.tag || "lexiduel-learning" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = event.notification.data?.url || "/dashboard";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).pathname === destination);
    return existing ? existing.focus() : self.clients.openWindow(destination);
  }));
});
