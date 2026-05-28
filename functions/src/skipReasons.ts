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

// AK-155 — Three-tier urgency for a skip reason (mirrors src/lib/skipReasons.ts):
//   🔴 clinical      — high-priority / critical FCM
//   🟡 informational — normal FCM
//   🟢 benign        — no FCM at all
export type SkipUrgencyTier = 'clinical' | 'informational' | 'benign'

const SKIP_URGENCY: Record<string, SkipUrgencyTier> = {
  // 🔴 Clinical
  feeling_better: 'clinical',
  adverse_reaction: 'clinical',
  blood_sugar_low: 'clinical',
  side_effects: 'clinical',
  // 🟡 Informational
  ran_out: 'informational',
  inhaler_empty: 'informational',
  doctor_changed: 'informational',
  injection_site_sore: 'informational',
  device_issue: 'informational',
  fasting: 'informational',
  away_from_supplies: 'informational',
  // 🟢 Benign
  traveling: 'benign',
  forgot: 'benign',
  busy: 'benign',
  not_home: 'benign',
  no_symptoms: 'benign',
  pain_resolved: 'benign',
  took_alternative: 'benign',
  at_daily_limit: 'benign',
  festival: 'benign',
  other: 'benign',
}

export function getSkipUrgency(id: string | null | undefined): SkipUrgencyTier {
  if (!id) return 'benign'
  return SKIP_URGENCY[id] ?? 'benign'
}

// AK-NNN — Reasons that streak-track. Three consecutive skips with the same
// reason on the same treatment trigger a "3 days running" caregiver alert. The
// set mirrors the AK-155 clinical tier — symptom/improvement signals where a
// repeated pattern warrants a check-in beyond the per-log push. Preventive-
// category treatments also streak-track on benign reasons (handled at the
// call site), so this list is the *reason*-axis of eligibility only.
//
// Typed as string[] (not SkipReasonId[]) because the functions package
// compiles standalone and can't import the client type union. Values stay in
// sync with src/lib/skipReasons.ts manually.
const STREAK_TRACKED_REASONS: string[] = [
  'side_effects',
  'adverse_reaction',
  'blood_sugar_low',
  'feeling_better',
]

export function isStreakTrackedReason(id: string | null | undefined): boolean {
  return !!id && STREAK_TRACKED_REASONS.includes(id)
}
