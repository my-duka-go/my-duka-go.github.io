// Farm on the Go - offline app files.
// Keeps the app's own files so it opens with no internet. Records live in IndexedDB and are not touched here.
// Only this app's caches are ever removed - the other DukaGO apps on the same address keep theirs.
const CACHE_PREFIX = 'farm-on-the-go-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v1-2026-11-06-1';
const SHELL_FILES = ['./', './index.html', './app.js', './crops.js', './manifest.json', './icons/icon-192-f1.png', './icons/icon-512-f1.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL('./', location).pathname)) return;
  if (url.searchParams.has('build-check')) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('./index.html') : null);
    if (hit) return hit;
    try { const r = await fetch(req); if (r.ok && r.type === 'basic') c.put(req, r.clone()); return r; }
    catch (e) { return req.mode === 'navigate' ? (await c.match('./index.html')) : Response.error(); }
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((w) => w.length ? w[0].focus() : self.clients.openWindow('./index.html')));
});
