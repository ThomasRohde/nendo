// The service worker of an exported web app (ADR-0037). It keeps exactly the folder's own files, in
// a cache named by the app's address and this version, and answers those addresses from it, so the
// installed app opens without the network. It answers no other request: a linked picture and a
// view's own requests go to the network as before. Export → Web app writes the page's digest into
// the version, so a newer page published in the folder installs a newer worker; it waits until the
// page asks it to take over, so nothing is swapped under an open file.
const version = '__NENDO_WEB_APP_VERSION__';
const scope = self.registration.scope;
const cachePrefix = `nendo-web-app ${scope} `;
const cacheName = cachePrefix + version;
const page = new URL('index.html', scope).href;
const kept = [page, ...['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'].map((path) => new URL(path, scope).href)];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(kept.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(cachePrefix) && key !== cacheName) await caches.delete(key);
    // The page that installed the first version is answered from now on, without a reload.
    await self.clients.claim();
  })());
});

// The page asks a waiting version to take over when the person chooses Reload.
self.addEventListener('message', (event) => {
  if (event.data === 'nendo-web-app-take-over') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const address = url.origin + url.pathname;
  const key = address === scope ? page : address;
  if (!kept.includes(key)) return;
  event.respondWith(caches.open(cacheName)
    .then((cache) => cache.match(key))
    .then((answer) => answer ?? fetch(event.request)));
});
