/* Chief Command Center service worker: Web Push, and the app's own code kept on the device.
 *
 * A phone discards the app in the background, and every return downloaded its code again (1.6 MB in 19 requests).
 * The build's code files (/_next/static/) are named for their content, so a kept copy can never be stale: they are
 * served from this device's cache first. Pages, the API and everything else always go to the network. */

const CODE_CACHE = 'chief-code-v1';
const CODE_KEPT = 300;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('chief-code-') && name !== CODE_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/_next/static/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CODE_CACHE);
    const kept = await cache.match(req);
    if (kept) return kept;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil((async () => {
        await cache.put(req, copy);
        // Old builds' files pile up across updates: keep the newest few hundred.
        const keys = await cache.keys();
        for (const old of keys.slice(0, Math.max(0, keys.length - CODE_KEPT))) await cache.delete(old);
      })());
    }
    return res;
  })());
});

/** Where a notification leads: a tab, and optionally an approval or the Fleet Health view. */
function openTarget(data) {
  const open = (data && data.open) || {};
  return {
    tab: typeof open.tab === 'string' ? open.tab : 'chat',
    approval: typeof open.approval === 'string' ? open.approval : '',
    view: typeof open.view === 'string' ? open.view : '',
    ...(typeof open.thread === 'string' && open.thread ? { thread: open.thread } : {}),
  };
}

self.addEventListener('push', (event) => {
  let data = { title: 'Chief', body: '', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    try { data.body = event.data.text(); } catch (_) {}
  }
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'chief-reply';
  event.waitUntil((async () => {
    // The owner is looking at the app on this device: the reply or approval is already on screen.
    // (Chrome does not substitute its own notification while a page of the origin is visible.)
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    return self.registration.showNotification(data.title || 'Chief', {
      body: data.body || 'New message',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      // One notification per kind: a newer reply replaces the last one and alerts again.
      tag,
      renotify: true,
      timestamp: typeof data.at === 'number' ? data.at : Date.now(),
      // An approval blocks the chief: on a desktop it stays until handled.
      requireInteraction: tag.startsWith('approval-'),
      data: { url: data.url || '/', open: openTarget(data) },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = openTarget(event.notification.data);
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.filter((c) => new URL(c.url).origin === self.location.origin);
    const client = open.find((c) => c.focused) || open[0];
    if (!client) {
      const url = new URL('/', self.location.origin);
      url.searchParams.set('open', target.tab);
      if (target.approval) url.searchParams.set('approval', target.approval);
      if (target.view) url.searchParams.set('view', target.view);
      if (target.thread) url.searchParams.set('thread', target.thread);
      return clients.openWindow ? clients.openWindow(url.href) : undefined;
    }
    // Bring the open app forward as it is and tell it where to go. Navigating it would reload the
    // page, dropping the chat state and treating replies that just arrived as history (never spoken).
    try { client.postMessage({ type: 'chief-open', ...target }); } catch (_) { /* uncontrolled client */ }
    return client.focus();
  })());
});
