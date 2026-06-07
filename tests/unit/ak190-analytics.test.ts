// AK-190 — Firebase Analytics scaffolding: DPDP guardrails.
//
// The privacy-critical logic (consent gate, param allowlist scrubber, hashed
// UID) is implemented as pure functions so it can be asserted without the
// firebase/analytics SDK (which is dynamically imported and browser-only). The
// SDK transport itself is a thin wrapper over these and isn't exercised here.

import { describe, expect, it } from 'vitest'

import {
  ANALYTICS_EVENTS,
  ALLOWED_PARAM_KEYS,
  hasAnalyticsConsent,
  hashUid,
  prepareEvent,
  sanitizeEventParams,
  setAnalyticsConsent,
} from '../../src/lib/analytics'

describe('AK-190 consent gate', () => {
  it('defaults to denied and prepareEvent emits nothing without consent', () => {
    expect(hasAnalyticsConsent()).toBe(false)
    expect(prepareEvent(ANALYTICS_EVENTS.doseLogged, { source: 'manual' }, false)).toBeNull()
  })

  it('only emits a (sanitised) event when consent is granted', () => {
    const ev = prepareEvent(ANALYTICS_EVENTS.screenView, { screen_name: 'Dashboard' }, true)
    expect(ev).not.toBeNull()
    expect(ev!.name).toBe('screen_view')
    expect(ev!.params).toEqual({ screen_name: 'Dashboard' })
  })

  it('setAnalyticsConsent toggles the in-module gate', async () => {
    await setAnalyticsConsent(true)
    expect(hasAnalyticsConsent()).toBe(true)
    await setAnalyticsConsent(false)
    expect(hasAnalyticsConsent()).toBe(false)
  })
})

describe('AK-190 param sanitiser (default-deny allowlist)', () => {
  it('keeps allowlisted keys with safe primitive values', () => {
    expect(sanitizeEventParams({ screen_name: 'Cabinet', step: 'search', source: 'reminder' })).toEqual({
      screen_name: 'Cabinet',
      step: 'search',
      source: 'reminder',
    })
  })

  it('drops health content and PII keys', () => {
    const dirty = {
      medicine: 'Crocin',
      medicine_name: 'Atorvastatin',
      strength: '500mg',
      ingredient: 'Paracetamol',
      dose_time: '08:00',
      adherence: 0.8,
      condition: 'hypertension',
      name: 'Rajan',
      phone: '+919876543210',
      email: 'a@b.com',
      address: '12 MG Road',
      uid: 'abc123',
    }
    expect(sanitizeEventParams(dirty)).toEqual({})
  })

  it('drops non-primitive values and over-long strings on allowlisted keys', () => {
    const longStep = 'x'.repeat(101)
    expect(
      sanitizeEventParams({
        step: longStep, // too long → dropped
        source: { nested: 'obj' }, // object → dropped
        screen_name: ['a'], // array → dropped
      }),
    ).toEqual({})
  })

  it('every allowlisted key is genuinely safe (no name/phone/health terms)', () => {
    // screen_name is intentionally allowed even though it contains "name" — it
    // is a route label, not a person's name. Assert the rest carry no PII hint.
    const risky = ['phone', 'email', 'address', 'medicine', 'dose', 'adherence', 'condition']
    for (const key of ALLOWED_PARAM_KEYS) {
      if (key === 'screen_name' || key === 'screen_class') continue
      for (const term of risky) {
        expect(key.includes(term)).toBe(false)
      }
    }
  })
})

describe('AK-190 hashed UID (pseudonymous id)', () => {
  it('produces a stable SHA-256 hex digest', async () => {
    // Known vector: SHA-256("abc")
    expect(await hashUid('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('never returns the raw uid and differs per input', async () => {
    const uid = 'firebase-uid-12345'
    const hashed = await hashUid(uid)
    expect(hashed).not.toBe(uid)
    expect(hashed).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashUid('other-uid')).not.toBe(hashed)
  })
})

describe('AK-190 event taxonomy', () => {
  it('exposes the baseline funnel event names', () => {
    expect(ANALYTICS_EVENTS).toEqual({
      screenView: 'screen_view',
      onboardingStep: 'onboarding_step',
      addMedicineStep: 'add_medicine_step',
      doseLogged: 'dose_logged',
      refillRequested: 'refill_requested',
      refillStep: 'refill_step',
    })
  })
})
