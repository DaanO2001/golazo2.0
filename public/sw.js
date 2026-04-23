self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Golazo', {
      body: data.body || 'Er is een update!',
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: self.location.origin + '/?tab=resultaat' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'SHOW_TAB', tab: 'resultaat' });
          return;
        }
      }
      return clients.openWindow(self.location.origin + '/?tab=resultaat');
    })
  );
});
