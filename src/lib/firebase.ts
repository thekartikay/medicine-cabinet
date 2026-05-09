import { initializeApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  getToken as getAppCheckToken,
  type AppCheck,
} from 'firebase/app-check';
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
  doc,
  updateDoc,
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { getStorage } from 'firebase/storage';
import { getMessaging, getToken } from 'firebase/messaging';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);

// ─── App Check (MC-031) ─────────────────────────────────────────────────────
// Initialised before Auth/Firestore/Functions so the reCAPTCHA Enterprise
// provider can attach App Check tokens to every outbound request these
// services make. We:
//   • Skip init when there is no `window` (SSR / build-time evaluation).
//     reCAPTCHA Enterprise only runs in a real browser; importing it server-
//     side would throw on document/navigator access.
//   • Skip init when VITE_RECAPTCHA_SITE_KEY is missing. Without a key we
//     cannot mint tokens, but we still want the dev server to boot — calling
//     code paths that require App Check will fail loudly at request time.
//   • Set isTokenAutoRefreshEnabled so the SDK refreshes ahead of expiry
//     without us building a manual refresh loop.
export const appCheck: AppCheck | null = (() => {
  if (typeof window === 'undefined') return null;
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
  if (!siteKey) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        '[AppCheck] VITE_RECAPTCHA_SITE_KEY is not set — skipping App Check init. ' +
        'Callable Cloud Functions with enforceAppCheck:true will reject requests until this is configured.',
      );
    }
    return null;
  }
  return initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
})();

// Dev-only sanity check: confirm a token was actually minted, without
// printing the token itself.
if (import.meta.env.DEV && appCheck) {
  getAppCheckToken(appCheck, /* forceRefresh */ false)
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(`[AppCheck] Token issued, length: ${result.token.length} chars`);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[AppCheck] Token request failed:', (err as Error)?.message ?? err);
    });
}

export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const functions = getFunctions(app, 'asia-south1');
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

if (import.meta.env.DEV) {
  connectAuthEmulator(auth, 'http://localhost:9099');
  connectFirestoreEmulator(db, 'localhost', 8080);
  connectFunctionsEmulator(functions, 'localhost', 5001);
}

// getMessaging throws in environments that don't support the Push API (e.g. iOS webview without entitlement)
export const messaging = (() => {
  try {
    return getMessaging(app);
  } catch {
    return null;
  }
})();

// ─── FCM token registration (MC-006) ────────────────────────────────────────
// Asks the browser/device for notification permission, requests a per-install
// FCM registration token, and persists it on users/{uid}.fcmToken so Cloud
// Functions can target this user. No-ops gracefully when:
//   • the browser denies permission
//   • the runtime has no Push API (older iOS WKWebViews, Capacitor without
//     the FCM plugin) — `messaging` is null in that case
//   • the VAPID key env var isn't configured (e.g. local dev)
//
// Safe to call repeatedly; getToken returns a stable token until the user
// clears site data or revokes permission, and updateDoc with the same value
// is a no-op write.
export async function requestNotificationPermission(uid: string): Promise<void> {
  if (!messaging) return;
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) return;

  // Guard against environments where Notification isn't a constructor (some
  // mobile webviews) — fail closed rather than throwing into App.tsx.
  if (typeof Notification === 'undefined') return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const token = await getToken(messaging, { vapidKey });
    if (!token) return;

    await updateDoc(doc(db, 'users', uid), { fcmToken: token });
  } catch {
    // Never let a notification-registration failure break the auth flow.
  }
}
