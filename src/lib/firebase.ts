import { initializeApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
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

// ─── App Check (MC-031) — production only ────────────────────────────────────
// CLAUDE.md rule #9 ("App Check enforced on all Cloud Functions") is about
// production. In the emulator, App Check would still talk to the real Firebase
// App Check service (the emulator does not proxy it) and would block every
// callable. The emulator is isolated from production and App Check there
// protects nothing — so we skip client init in DEV entirely. Server-side
// enforcement is gated by ENFORCE_APP_CHECK (process.env.FUNCTIONS_EMULATOR).
//
// In production we still need a `window` (reCAPTCHA is browser-only) and a
// configured VITE_RECAPTCHA_SITE_KEY.
//
// AK-117 — use ReCaptchaV3Provider, not Enterprise. Firebase Phone Auth
// always uses reCAPTCHA Enterprise (window.grecaptcha.enterprise). If App
// Check also registered an Enterprise key here, both consumers race to
// register on the same global namespace and Phone OTP fails on production
// with "Invalid site key or not loaded in api.js". v3 lives on the separate
// window.grecaptcha namespace, so the two coexist cleanly.
if (!import.meta.env.DEV && typeof window !== 'undefined') {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
  if (siteKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
}

export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const functions = getFunctions(app, 'asia-south1');
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

if (import.meta.env.DEV) {
  // Must be set BEFORE connectAuthEmulator. Tells the Auth SDK to skip both
  // the reCAPTCHA Enterprise enforcement-config fetch (which the emulator
  // 501s on) and real reCAPTCHA verification. The stub ApplicationVerifier
  // in SignIn.tsx is still required by the signInWithPhoneNumber signature,
  // but the SDK no longer validates it.
  auth.settings.appVerificationDisabledForTesting = true;
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
