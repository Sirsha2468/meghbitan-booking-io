importScripts('https://www.gstatic.com/firebasejs/11.6.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.1/firebase-messaging-compat.js');
importScripts('./firebase-config.js');

firebase.initializeApp(self.MEGHBITAN_FIREBASE_CONFIG);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    self.registration.showNotification(data.title || 'Meghbitan Homestay Reminder', {
        body: data.body || 'A scheduled booking reminder is due.',
        icon: './icon.svg',
        badge: './icon.svg',
        tag: data.reminderId || 'meghbitan-reminder',
        data: { url: './' },
        requireInteraction: true
    });
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = new URL(event.notification.data?.url || './', self.location.origin).href;
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            const existing = clients.find((client) => client.url.startsWith(self.location.origin));
            if (existing) return existing.focus();
            return self.clients.openWindow(targetUrl);
        })
    );
});
