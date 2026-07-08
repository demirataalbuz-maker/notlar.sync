// PWA service worker: uygulama kabugunu onbellekler -> telefonda "ana ekrana
// ekle" ile kurulur, sunucuya ulasilamadiginda kabuk yine acilir (notlar WS
// gelince dolar; offline duzenleme kuyrugu index.html tarafinda).
// API istekleri ASLA onbellekten donmez - bayat veri canli senkronu bozar.
const CACHE = 'notlar-sync-v1';
const SHELL = ['/', '/harita.html', '/tools.js', '/vault.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/') || u.pathname.startsWith('/files/')) return;
  // once ag (guncel kabuk), dusmezse onbellek (offline acilis)
  e.respondWith(
    fetch(e.request).then((r) => {
      const kopya = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, kopya));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
