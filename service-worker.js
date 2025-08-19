const CACHE_NAME = "anwesenheit-v1";
const RELATIVE_ASSETS = [
  "",              // index.html
  "index.html",
  "manifest.json",
  "logo.png",
  "icon-192.png",
  "icon-512.png",
];
const URLS_TO_CACHE = RELATIVE_ASSETS.map(p =>
  new URL(p, self.registration.scope).toString()
);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of URLS_TO_CACHE) {
      const resp = await fetch(new Request(url, { cache: "reload" }));
      if (!resp.ok) throw new Error(`Precache failed for ${url}: ${resp.status}`);
      await cache.put(url, resp.clone());
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : undefined)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    return cached || fetch(event.request);
  })());
});
