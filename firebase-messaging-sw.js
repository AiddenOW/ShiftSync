// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');

firebase.initializeApp({
    apiKey: "AIzaSyBHfCS2EnbmDHtWe_oVzdy0xDfnq1YNqtY",
    authDomain: "shiftsync-5ebda.firebaseapp.com",
    projectId: "shiftsync-5ebda",
    storageBucket: "shiftsync-5ebda.firebasestorage.app",
    messagingSenderId: "17662196576",
    appId: "1:17662196576:web:a6d098f307ea708f17bc05"
});

const messaging = firebase.messaging();

// Afficher la notification quand l'appli est en arrière-plan
messaging.onBackgroundMessage((payload) => {
    const { title, body, icon } = payload.notification;
    self.registration.showNotification(title, {
        body,
        icon: icon || '/ShiftSync/icon-192.png',
        badge: '/ShiftSync/icon-192.png',
        vibrate: [200, 100, 200],
        data: payload.data
    });
});

// Clic sur la notification → ouvre l'app
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes('ShiftSync') && 'focus' in client)
                    return client.focus();
            }
            return clients.openWindow('https://aiddenow.github.io/ShiftSync/');
        })
    );
});
