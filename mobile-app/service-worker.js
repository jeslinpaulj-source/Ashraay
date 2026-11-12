const CACHE = "ashraay-mobile-shell-v12";
const SHELL = [
  "/",
  "/style.css",
  "/app.js",
  "/api-base.js",
  "/i18n-mobile.js",
  "/shared/auth.js",
  "/shared/login-screen.js",
  "/shared/login.css",
  "/shared/logo-mark.png",
  "/shared/login-hero-mobile.jpg",
  "/shared/i18n.js",
  "/shared/i18n-proto.js",
  "/shared/offline.js",
  "/shared/logo.png",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("ashraay-mobile-shell-") && key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !SHELL.includes(url.pathname) ||
    (request.mode === "navigate" && url.search)
  ) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && !url.search) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") return caches.match("/");
      return Response.error();
    })
  );
});
