// AK-118 — Shared country list for phone-number entry. Six countries cover
// the MediCab beta + NRI users in their typical destinations. Adding a new
// country = one row here, no other changes needed.
//
// `dial` is the country calling code prefix in E.164 form (with the '+').
// Phone composition: `${dial}${localPhone.replace(/\D/g, '')}` produces a
// Firebase-Auth-ready E.164 string.

export interface Country {
  flag: string
  code: string
  dial: string
  label: string
}

export const COUNTRIES: Country[] = [
  { flag: '🇮🇳', code: 'IN', dial: '+91',  label: 'India'     },
  { flag: '🇺🇸', code: 'US', dial: '+1',   label: 'US / CA'   },
  { flag: '🇬🇧', code: 'GB', dial: '+44',  label: 'UK'        },
  { flag: '🇦🇪', code: 'AE', dial: '+971', label: 'UAE'       },
  { flag: '🇦🇺', code: 'AU', dial: '+61',  label: 'Australia' },
  { flag: '🇸🇬', code: 'SG', dial: '+65',  label: 'Singapore' },
]
