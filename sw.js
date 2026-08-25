// ゆきちゃっと：プッシュ通知表示専用の最小Service Worker
// （FCM等のサーバープッシュではなく、開いているタブから showNotification() を呼ぶための土台）

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// 通知をタップしたら、既存のタブがあればフォーカス、なければ新規で開く
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('/');
        })
    );
});