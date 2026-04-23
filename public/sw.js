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
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});
