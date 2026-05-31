importScripts('https://www.gstatic.com/firebasejs/12.12.1/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/12.12.1/firebase-messaging-compat.js')

firebase.initializeApp({
  apiKey: "AIzaSyAc8BcBMtN_Tciqvy0pUh-YIMGmNfzRa0w",
  authDomain: "medicab-dev-2025.firebaseapp.com",
  projectId: "medicab-dev-2025",
  storageBucket: "medicab-dev-2025.firebasestorage.app",
  messagingSenderId: "800406331344",
  appId: "1:800406331344:web:e6d45e0498431078a323d5"
})

const messaging = firebase.messaging()

messaging.onBackgroundMessage((payload) => {
  self.registration.showNotification(
    payload.notification.title,
    {
      body: payload.notification.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.data?.slotId,
      requireInteraction: true,
      data: payload.data,
    }
  )
})
