// AK-190 — Firebase Analytics scaffolding + DPDP-safe event helpers.
//
// Phase-0 instrumentation foundation. This module is additive and safe to ship
// to production: nothing is collected until the user grants analytics consent,
// and the typed helpers below are the ONLY way to emit events, so health
// content and PII can never reach Analytics by construction.
//
// DPDP guardrails (non-negotiable — see AK-190):
//   • Never log health content (medicine names, strengths, ingredients,
//     conditions, dose times, adherence values).
//   • Never log PII (names, phone, address, email).
//   • The pseudonymous user id is a SHA-256 hash of the Firebase UID — never
//     the phone, email, or name.
//   • All collection is gated behind analytics consent, which DEFAULTS TO
//     DENIED (opt-in). `setAnalyticsConsent(true)` must be called before any
//     event or user id is sent.
//
// Consent note: MediCab's shipped consent record (MC-017a) is a single blanket
// "I agree" record, not a per-purpose model. Rather than mutate that immutable
// legal record here, analytics consent is tracked as an additive, opt-in
// purpose via setAnalyticsConsent(); persisting/collecting it through the
// consent UI is follow-up wiring. The default-denied stance keeps us DPDP-safe
// in the meantime.
//
// The firebase/analytics SDK is dynamically imported on first use (mirrors
// ensureMessaging in lib/firebase.ts) so it never lands in the entry chunk and
// so this module can be imported in pure-Node tests without pulling the SDK.

import type { Analytics } from 'firebase/analytics'
import { app } from './firebase'

// ─── Event taxonomy ─────────────────────────────────────────────────────────
// The only event names that may be emitted. Adding an event means adding it
// here AND adding a typed helper — there is deliberately no free-form `track`.
export const ANALYTICS_EVENTS = {
  screenView: 'screen_view',
  onboardingStep: 'onboarding_step',
  addMedicineStep: 'add_medicine_step',
  doseLogged: 'dose_logged',
  refillRequested: 'refill_requested',
  refillStep: 'refill_step',
} as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]

// Funnel step vocabularies. These are UI-flow labels — never health content.
export type OnboardingStep =
  | 'welcome'
  | 'sign_in'
  | 'consent'
  | 'create_household'
  | 'add_first_member'
  | 'completed'

export type AddMedicineStep = 'search' | 'details' | 'schedule' | 'review' | 'confirm'

export type RefillStep = 'started' | 'address' | 'review' | 'submitted'

export type AnalyticsParamValue = string | number | boolean

// ─── DPDP sanitisation (pure) ────────────────────────────────────────────────
// Defence-in-depth with a default-DENY allowlist: anything routed through
// dispatch() is scrubbed down to a known-safe set of param keys, so a health
// or PII key (medicine, dose_time, name, phone, condition, …) can never be
// emitted even if a caller bypassed the typed helpers. Values are further
// restricted to short primitives so free text can't ride along. Adding a new
// param key is a deliberate edit here — forcing a DPDP review per key.
export const ALLOWED_PARAM_KEYS: readonly string[] = [
  'screen_name', // GA screen_view — a route/screen label, not a person's name
  'screen_class',
  'step', // funnel step label (onboarding / add-medicine / refill)
  'source', // e.g. dose_logged source: 'manual' | 'reminder'
]

const MAX_STRING_LEN = 100

function isAllowedKey(key: string): boolean {
  return ALLOWED_PARAM_KEYS.includes(key)
}

// Returns a copy containing only allowlisted keys with safe primitive values.
// Drops non-allowlisted keys, over-long strings, and any non-primitive value.
export function sanitizeEventParams(
  params: Record<string, unknown>,
): Record<string, AnalyticsParamValue> {
  const clean: Record<string, AnalyticsParamValue> = {}
  for (const [key, raw] of Object.entries(params)) {
    if (!isAllowedKey(key)) continue
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      clean[key] = raw
    } else if (typeof raw === 'boolean') {
      clean[key] = raw
    } else if (typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_STRING_LEN) {
      clean[key] = raw
    }
    // everything else (objects, arrays, null, long strings) is dropped
  }
  return clean
}

export interface PreparedEvent {
  name: AnalyticsEventName
  params: Record<string, AnalyticsParamValue>
}

// Pure decision + sanitisation step. Returns null when consent is not granted
// (so nothing is sent), otherwise the sanitised event. Kept pure so the
// consent gate and the scrubber are unit-testable without the firebase SDK.
export function prepareEvent(
  name: AnalyticsEventName,
  params: Record<string, unknown>,
  consentGranted: boolean,
): PreparedEvent | null {
  if (!consentGranted) return null
  return { name, params: sanitizeEventParams(params) }
}

// ─── Pseudonymous id (pure) ──────────────────────────────────────────────────
// SHA-256 hex of the Firebase UID. The UID is already an opaque id (not PII),
// and hashing further decouples the analytics identity from the auth identity.
export async function hashUid(uid: string): Promise<string> {
  const bytes = new TextEncoder().encode(uid)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Consent + SDK wiring ────────────────────────────────────────────────────
let consentGranted = false
let _analytics: Analytics | null = null
let _analyticsInitTried = false

export function hasAnalyticsConsent(): boolean {
  return consentGranted
}

// Lazily initialise Analytics. Browser + production only (DEV is skipped like
// App Check), and only when the runtime supports it. Idempotent.
async function ensureAnalytics(): Promise<Analytics | null> {
  if (_analyticsInitTried) return _analytics
  _analyticsInitTried = true
  if (import.meta.env.DEV || typeof window === 'undefined') return null
  try {
    const { getAnalytics, isSupported, setConsent } = await import('firebase/analytics')
    if (!(await isSupported())) return null
    // Default consent to denied before init; setAnalyticsConsent flips it.
    setConsent({ analytics_storage: 'denied', ad_storage: 'denied' })
    _analytics = getAnalytics(app)
    return _analytics
  } catch {
    _analytics = null
    return null
  }
}

// Grant or revoke analytics consent. Updates the SDK consent mode + collection
// flag and the in-module gate. Until this is called with `true`, nothing is
// collected.
export async function setAnalyticsConsent(granted: boolean): Promise<void> {
  consentGranted = granted
  const analytics = await ensureAnalytics()
  if (!analytics) return
  const { setConsent, setAnalyticsCollectionEnabled } = await import('firebase/analytics')
  setConsent({ analytics_storage: granted ? 'granted' : 'denied', ad_storage: 'denied' })
  setAnalyticsCollectionEnabled(analytics, granted)
}

// Set the pseudonymous user id (hashed UID). No-ops without consent.
export async function setAnalyticsUser(uid: string): Promise<void> {
  if (!consentGranted) return
  const analytics = await ensureAnalytics()
  if (!analytics) return
  const hashed = await hashUid(uid)
  const { setUserId } = await import('firebase/analytics')
  setUserId(analytics, hashed)
}

// Clear the user id on sign-out.
export async function clearAnalyticsUser(): Promise<void> {
  const analytics = await ensureAnalytics()
  if (!analytics) return
  const { setUserId } = await import('firebase/analytics')
  setUserId(analytics, null)
}

// Internal transport. Applies the consent gate + scrubber, then emits.
async function dispatch(name: AnalyticsEventName, params: Record<string, unknown>): Promise<void> {
  const prepared = prepareEvent(name, params, consentGranted)
  if (!prepared) return
  const analytics = await ensureAnalytics()
  if (!analytics) return
  const { logEvent } = await import('firebase/analytics')
  // Cast to string so the SDK resolves the custom-event overload uniformly for
  // every name in our taxonomy. Some names (e.g. 'screen_view') are reserved GA
  // events whose typed overloads expect a different param shape; routing them
  // all through the generic overload keeps one code path and our own typed
  // helpers remain the safety boundary.
  logEvent(analytics, prepared.name as string, prepared.params)
}

// ─── Typed event helpers (the only public emit surface) ──────────────────────
export function logScreenView(screenName: string): void {
  void dispatch(ANALYTICS_EVENTS.screenView, { screen_name: screenName })
}

export function logOnboardingStep(step: OnboardingStep): void {
  void dispatch(ANALYTICS_EVENTS.onboardingStep, { step })
}

export function logAddMedicineStep(step: AddMedicineStep): void {
  void dispatch(ANALYTICS_EVENTS.addMedicineStep, { step })
}

export function logDoseLogged(source: 'manual' | 'reminder' = 'manual'): void {
  // No medicine, time, or adherence value — only the non-health source.
  void dispatch(ANALYTICS_EVENTS.doseLogged, { source })
}

export function logRefillRequested(): void {
  void dispatch(ANALYTICS_EVENTS.refillRequested, {})
}

export function logRefillStep(step: RefillStep): void {
  void dispatch(ANALYTICS_EVENTS.refillStep, { step })
}
