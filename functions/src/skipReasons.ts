// AK-154 — Server-side copy of the skip-reason labels + clinical/refill flags.
// The functions package compiles in isolation (tsconfig rootDir: src) and does
// NOT share the client's src/lib, so this mirrors src/lib/skipReasons.ts. Keep
// the two in sync when reasons change.

export const SKIP_REASON_LABELS: Record<string, string> = {
  traveling: 'Traveling / away',
  forgot: 'Forgot',
  busy: 'Too busy today',
  not_home: 'Not at home',
  away_from_supplies: 'Away from supplies',
  side_effects: 'Feeling unwell',
  ran_out: 'Ran out of medicine',
  feeling_better: 'Feeling better',
  doctor_changed: 'Doctor changed it',
  adverse_reaction: 'Bad reaction',
  no_symptoms: 'No symptoms today',
  pain_resolved: 'Pain has resolved',
  took_alternative: 'Took something else',
  at_daily_limit: "At today's limit",
  inhaler_empty: 'Inhaler is empty',
  device_issue: 'Device problem',
  blood_sugar_low: 'Blood sugar was low',
  injection_site_sore: 'Injection site sore',
  fasting: 'Fasting today',
  festival: 'Festival / occasion',
  other: 'Other',
}

// Clinical skips → immediate high-priority / critical FCM to admins.
export const CLINICAL_REASON_IDS = new Set<string>([
  'feeling_better',
  'blood_sugar_low',
  'adverse_reaction',
])

// Out-of-supply skips → refill-prompt FCM copy.
export const REFILL_REASON_IDS = new Set<string>([
  'ran_out',
  'inhaler_empty',
])
