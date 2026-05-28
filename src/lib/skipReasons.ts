// AK-154 — Structured skip reasons. The member skip bottom sheet shows five
// category-aware chips (plus a free-text "Other"); the chosen chip's id is
// persisted on DoseLog.skipReason. getSkipReasonChips() picks the right five
// for a treatment based on its category and (for chronic) its dosage form.

import type {
  DosageForm,
  SkipReasonDef,
  SkipReasonId,
  TreatmentCategory,
} from '../types'

// Human-readable labels — phrased for an elderly patient (Rajan), not clinical.
export const SKIP_REASON_LABELS: Record<SkipReasonId, string> = {
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

// Single source of truth for every reason's category + clinical/refill flags.
// Chip sets below reference these so a flag never drifts between sets.
const DEFS: Record<SkipReasonId, SkipReasonDef> = {
  traveling:          { id: 'traveling',          label: SKIP_REASON_LABELS.traveling,          category: 'time_place' },
  forgot:             { id: 'forgot',             label: SKIP_REASON_LABELS.forgot,             category: 'time_place' },
  busy:               { id: 'busy',               label: SKIP_REASON_LABELS.busy,               category: 'time_place' },
  not_home:           { id: 'not_home',           label: SKIP_REASON_LABELS.not_home,           category: 'time_place' },
  away_from_supplies: { id: 'away_from_supplies', label: SKIP_REASON_LABELS.away_from_supplies, category: 'time_place' },
  side_effects:       { id: 'side_effects',       label: SKIP_REASON_LABELS.side_effects,       category: 'medication' },
  ran_out:            { id: 'ran_out',            label: SKIP_REASON_LABELS.ran_out,            category: 'medication', isRefillAlert: true },
  feeling_better:     { id: 'feeling_better',     label: SKIP_REASON_LABELS.feeling_better,     category: 'medication', isClinical: true },
  doctor_changed:     { id: 'doctor_changed',     label: SKIP_REASON_LABELS.doctor_changed,     category: 'medication' },
  adverse_reaction:   { id: 'adverse_reaction',   label: SKIP_REASON_LABELS.adverse_reaction,   category: 'medication', isClinical: true },
  no_symptoms:        { id: 'no_symptoms',        label: SKIP_REASON_LABELS.no_symptoms,        category: 'medication' },
  pain_resolved:      { id: 'pain_resolved',      label: SKIP_REASON_LABELS.pain_resolved,      category: 'medication' },
  took_alternative:   { id: 'took_alternative',   label: SKIP_REASON_LABELS.took_alternative,   category: 'medication' },
  at_daily_limit:     { id: 'at_daily_limit',     label: SKIP_REASON_LABELS.at_daily_limit,     category: 'medication' },
  inhaler_empty:      { id: 'inhaler_empty',      label: SKIP_REASON_LABELS.inhaler_empty,      category: 'medication', isRefillAlert: true },
  device_issue:       { id: 'device_issue',       label: SKIP_REASON_LABELS.device_issue,       category: 'medication' },
  blood_sugar_low:    { id: 'blood_sugar_low',    label: SKIP_REASON_LABELS.blood_sugar_low,    category: 'medication', isClinical: true },
  injection_site_sore:{ id: 'injection_site_sore',label: SKIP_REASON_LABELS.injection_site_sore,category: 'medication' },
  fasting:            { id: 'fasting',            label: SKIP_REASON_LABELS.fasting,            category: 'event' },
  festival:           { id: 'festival',           label: SKIP_REASON_LABELS.festival,           category: 'event' },
  other:              { id: 'other',              label: SKIP_REASON_LABELS.other,              category: 'other' },
}

const chips = (...ids: SkipReasonId[]): SkipReasonDef[] => ids.map(id => DEFS[id])

const CHRONIC_ORAL    = chips('traveling', 'forgot', 'side_effects', 'ran_out', 'fasting')
const CHRONIC_INHALER = chips('forgot', 'not_home', 'inhaler_empty', 'device_issue', 'traveling')
const CHRONIC_INJECT  = chips('forgot', 'away_from_supplies', 'blood_sugar_low', 'injection_site_sore', 'traveling')
const ACUTE_ORAL      = chips('forgot', 'busy', 'feeling_better', 'side_effects', 'doctor_changed')
const PRN             = chips('no_symptoms', 'took_alternative', 'at_daily_limit', 'pain_resolved', 'festival')
const PREVENTIVE      = chips('forgot', 'traveling', 'ran_out', 'side_effects', 'festival')

// Returns the five chips (excluding 'other') for a treatment. dosageForm only
// affects the chronic set: inhalers and injectables get device/clinical chips;
// everything else (and all non-chronic categories) uses the oral/default set.
export function getSkipReasonChips(
  category: TreatmentCategory,
  dosageForm?: DosageForm,
): SkipReasonDef[] {
  switch (category) {
    case 'chronic':
      if (dosageForm === 'inhaler') return CHRONIC_INHALER
      if (dosageForm === 'injection') return CHRONIC_INJECT
      return CHRONIC_ORAL
    case 'acute':
      return ACUTE_ORAL
    case 'prn':
      return PRN
    case 'preventive':
      return PREVENTIVE
  }
}
