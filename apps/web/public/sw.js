/* Chief Command Center service worker: Web Push only (no offline cache). */

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
