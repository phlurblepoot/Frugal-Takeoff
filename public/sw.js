// public/sw.js — the app's service worker: phone push notifications
// (ONLYOFFICE Phase 5, added 2026-09-27). It shows what the server pushes
// (server/push.ts) and opens the right page when one is tapped.
//
// Deliberately nothing else: no caching, no offline copy, so a new release is
// never hidden behind an old one.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data && event.data.text() }; }
  const title = data.title || 'New notification';
  const shown = self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    // One per notification: a second push about the same thing replaces it.
    tag: data.id || undefined,
    data: { link: typeof data.link === 'string' && data.link.startsWith('/') ? data.link : '/', id: data.id || null },
  });
  // The number on the app icon (installed app, where supported).
  const badge = typeof data.unread === 'number' && self.navigator.setAppBadge
    ? self.navigator.setAppBadge(data.unread).catch(() => {})
    : Promise.resolve();
  event.waitUntil(Promise.all([shown, badge]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { link = '/', id = null } = event.notification.data || {};
  event.waitUntil((async () => {
    // An open window of the app: bring it forward and let it go there
    // itself (no reload), marking the notification read on the way.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open-notification', link, id });
      return;
    }
    // Otherwise open the app there; the page marks it read (?fromNotification=).
    const url = new URL(link, self.location.origin);
    if (id) url.searchParams.set('fromNotification', id);
    await self.clients.openWindow(url.href);
  })());
});
