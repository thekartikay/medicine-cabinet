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
// AK-165 — @firebase/storage and @firebase/messaging are no longer top-level
// value imports. They're dynamically imported on first use via the lazy
// getters below, so neither SDK ends up in the entry chunk. Type-only
// imports stay; they're erased at build time.
import type { FirebaseStorage } from 'firebase/storage';
import type { Messaging } from 'firebase/messaging';

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
export const googleProvider = new GoogleAuthProvider();

// AK-165 — Lazy storage. Memoized; the @firebase/storage SDK is fetched on
// first call to getStorageInstance() rather than at module load. No client
// code uses Storage today (audited at AK-165 time); the getter is in place
// for future uploads (prescription scans, etc.) without paying the bytes now.
let _storage: FirebaseStorage | null = null;
export async function getStorageInstance(): Promise<FirebaseStorage> {
  if (_storage) return _storage;
  const { getStorage } = await import('firebase/storage');
  _storage = getStorage(app);
  return _storage;
}

// AK-165 — Lazy messaging. The @firebase/messaging SDK is fetched on first
// use (typically from requestNotificationPermission, after auth resolves).
// Idempotent: returns null on subsequent calls when init failed once.
let _messaging: Messaging | null = null;
let _messagingInitTried = false;
export async function ensureMessaging(): Promise<Messaging | null> {
  if (_messagingInitTried) return _messaging;
  _messagingInitTried = true;
  try {
    const { getMessaging, onMessage } = await import('firebase/messaging');
    _messaging = getMessaging(app);
    // AK-172 — Foreground push handler. Previously attached eagerly at module
    // load; now attaches once on first messaging init. Re-broadcasts dose
    // reminders as a CustomEvent so App.tsx can render its banner without
    // pulling React into this module.
    onMessage(_messaging, (payload) => {
      if (payload.data?.type === 'dose_reminder') {
        window.dispatchEvent(new CustomEvent('foreground-dose-reminder', { detail: payload }));
      }
    });
  } catch {
    _messaging = null;
  }
  return _messaging;
}

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


// ─── FCM token registration (MC-006) ────────────────────────────────────────
// Asks the browser/device for notification permission, requests a per-install
// FCM registration token, and persists it on users/{uid}.fcmToken so Cloud
// Functions can target this user. No-ops gracefully when:
//   • the browser denies permission
//   • the runtime has no Push API (older iOS WKWebViews, Capacitor without
//     the FCM plugin) — ensureMessaging() resolves to null in that case
//   • the VAPID key env var isn't configured (e.g. local dev)
//
// Safe to call repeatedly; getToken returns a stable token until the user
// clears site data or revokes permission, and updateDoc with the same value
// is a no-op write.
//
// AK-165 — Body now lazy-imports @firebase/messaging via ensureMessaging() +
// a second dynamic import for getToken. The module is cached after the first
// dynamic import, so the second await is effectively free.
export async function requestNotificationPermission(uid: string): Promise<void> {
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;
  if (!vapidKey) return;

  // Guard against environments where Notification isn't a constructor (some
  // mobile webviews) — fail closed rather than throwing into App.tsx.
  if (typeof Notification === 'undefined') return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const m = await ensureMessaging();
    if (!m) return;

    const { getToken } = await import('firebase/messaging');
    const token = await getToken(m, { vapidKey });
    if (!token) return;

    await updateDoc(doc(db, 'users', uid), { fcmToken: token });
  } catch {
    // Never let a notification-registration failure break the auth flow.
  }
}
