// App shell offline; streams, API and the proxy always go to the network.
const CACHE = 'hdtilt-v1';
const SHELL = ['/', '/app.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|p|mcp)\//.test(url.pathname) || url.pathname === '/mcp') return;
  // Network first so a deploy shows up at once; the cache is for offline.
  e.respondWith(
    // no-cache: revalidate with the server, never trust the HTTP cache for the shell.
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});
