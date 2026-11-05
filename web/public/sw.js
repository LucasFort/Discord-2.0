/* Service worker do Nexo: mostra os avisos que chegam com o app fechado (Web Push). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    (async () => {
      // Com o Nexo aberto e em foco, o próprio app já avisa: não repete.
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (open.some((c) => c.focused)) return;
      await self.registration.showNotification(d.title || 'Nexo', {
        body: d.body || 'Nova mensagem',
        tag: d.tag,
        renotify: !!d.tag,
        icon: '/icon-192.png',
        badge: '/favicon-32.png',
        data: { url: d.url || '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        client.postMessage({ type: 'nexo:open', url });
        return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
