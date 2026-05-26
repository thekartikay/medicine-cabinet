import { useState } from 'react'
import { auth } from '../lib/firebase'
import { createPendingInvite } from '../services/firestoreService'
import { COUNTRIES } from '../lib/countries'

interface Props {
  household: { hId: string; name: string }
  adminName: string
  onDone: () => void
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
  { code: 'te', label: 'తెలుగు (Telugu)' },
]

interface InviteParams {
  memberName: string
  adminName: string
  householdName: string
  joinCode: string
}

// Deterministic 6-digit code derived from the household id. Must match the
// computeJoinCode() in functions/src/index.ts byte-for-byte; both sides hash
// `btoa(hId)` (browser) / `Buffer.from(hId).toString('base64')` (Node).
export function computeJoinCode(hId: string): string {
  const b64 = btoa(hId)
  const digits = b64.replace(/[^0-9]/g, '')
  return digits.slice(0, 6).padStart(6, '0')
}

// Each translation has the join code as a standalone line so it survives
// WhatsApp's URL-encoding and is easy for the recipient to copy.
const INVITE_TEXT: Record<string, (p: InviteParams) => string> = {
  en: ({ memberName, adminName, householdName, joinCode }) =>
`Hi ${memberName}! ${adminName} has added you to ${householdName} on MediCab.

Your join code: ${joinCode}

Steps:
1. Download MediCab (coming soon to Play Store)
2. Sign in with your phone number
3. Enter code ${joinCode} when asked`,

  hi: ({ memberName, adminName, householdName, joinCode }) =>
`नमस्ते ${memberName}! ${adminName} ने आपको MediCab पर ${householdName} की दवा कैबिनेट में जोड़ा है।

आपका 6-अंकीय जॉइन कोड: ${joinCode}

जुड़ने के लिए:
1. Play Store से MediCab डाउनलोड करें
2. अपने फ़ोन नंबर से साइन इन करें
3. 'Join a household' पर टैप करें और दर्ज करें: ${joinCode}`,

  kn: ({ memberName, adminName, householdName, joinCode }) =>
`ನಮಸ್ಕಾರ ${memberName}! ${adminName} ಅವರು ನಿಮ್ಮನ್ನು MediCab ನಲ್ಲಿ ${householdName} ಔಷಧ ಕ್ಯಾಬಿನೆಟ್‌ಗೆ ಸೇರಿಸಿದ್ದಾರೆ.

ನಿಮ್ಮ 6-ಅಂಕಿಯ ಸೇರುವ ಕೋಡ್: ${joinCode}

ಸೇರಲು:
1. Play Store ನಿಂದ MediCab ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ
2. ನಿಮ್ಮ ಫೋನ್ ಸಂಖ್ಯೆಯಿಂದ ಸೈನ್ ಇನ್ ಮಾಡಿ
3. 'Join a household' ಒತ್ತಿ ಮತ್ತು ನಮೂದಿಸಿ: ${joinCode}`,

  ta: ({ memberName, adminName, householdName, joinCode }) =>
`வணக்கம் ${memberName}! ${adminName} உங்களை MediCab-ல் ${householdName} மருந்து கேபினட்டில் சேர்த்துள்ளார்கள்.

உங்கள் 6 இலக்க சேர்க்கை குறியீடு: ${joinCode}

சேர:
1. Play Store-ல் இருந்து MediCab பதிவிறக்கவும்
2. உங்கள் தொலைபேசி எண்ணுடன் உள்நுழையவும்
3. 'Join a household' தட்டவும், உள்ளிடவும்: ${joinCode}`,

  te: ({ memberName, adminName, householdName, joinCode }) =>
`నమస్కారం ${memberName}! ${adminName} మిమ్మల్ని MediCab లో ${householdName} మందుల కేబినెట్‌లో జోడించారు.

మీ 6-అంకెల చేరే కోడ్: ${joinCode}

చేరడానికి:
1. Play Store నుండి MediCab డౌన్‌లోడ్ చేయండి
2. మీ ఫోన్ నంబర్‌తో సైన్ ఇన్ చేయండి
3. 'Join a household' నొక్కి నమోదు చేయండి: ${joinCode}`,
}

export function InviteMember({ household, adminName, onDone }: Props) {
  const [memberName, setMemberName] = useState('')
  const [lang, setLang] = useState('en')
  const [copied, setCopied] = useState(false)
  // AK-166 — Optional phone collection. When provided, we pre-stage a
  // pendingInvite doc with the member's name + language + phone, and target
  // the WhatsApp share at the specific recipient (wa.me/<phone>) so the
  // admin doesn't have to pick from contacts. Empty falls back to the
  // legacy contact-picker share.
  const [inviteDialCode, setInviteDialCode] = useState('+91')
  const [inviteLocalPhone, setInviteLocalPhone] = useState('')
  const [sending, setSending] = useState(false)

  const joinCode = computeJoinCode(household.hId)

  async function handleInvite() {
    if (sending) return
    setSending(true)
    try {
      const recipient = memberName.trim() || 'there'
      const message = INVITE_TEXT[lang]({
        memberName: recipient,
        adminName,
        householdName: household.name,
        joinCode,
      })

      const digits = inviteLocalPhone.replace(/\D/g, '')
      const hasPhone = digits.length >= (inviteDialCode === '+91' ? 10 : 7)

      if (hasPhone) {
        const phoneE164 = inviteDialCode + digits
        // Best-effort write — the WhatsApp share works either way. If the
        // Firestore write fails (rules / network), we still open WhatsApp
        // with the contact pre-targeted; the admin can retry from Settings.
        try {
          const currentUid = auth.currentUser?.uid
          if (currentUid) {
            await createPendingInvite(household.hId, {
              phoneE164,
              memberName: recipient,
              languagePref: lang,
              createdBy: currentUid,
            })
          }
        } catch {
          // Swallow — the WhatsApp share is the user-visible outcome.
        }
        window.open(
          `https://wa.me/${phoneE164.replace('+', '')}?text=${encodeURIComponent(message)}`,
          '_blank',
        )
      } else {
        window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank')
      }
      onDone()
    } finally {
      setSending(false)
    }
  }

  async function handleCopyCode() {
    try {
      await navigator.clipboard.writeText(joinCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API is unavailable on some older webviews. Fall back silently.
    }
  }

  return (
    <div className="si-root">
      <div className="si-hero">
        <div className="si-icon-circle" aria-hidden="true">
          <InviteIcon />
        </div>
        <h1 className="si-app-name">MediCab</h1>
        <p className="si-app-sub">Invite family members</p>
      </div>

      <div className="si-panel">
        <h2 className="si-panel-title">Add a family member</h2>

        <div className="si-code-display" aria-label="Household join code">
          <span className="si-code-label">JOIN CODE</span>
          <span className="si-code-digits">{joinCode}</span>
          <button
            type="button"
            className="si-code-copy"
            onClick={handleCopyCode}
            aria-label="Copy join code"
          >
            {copied ? 'Copied!' : 'Copy code'}
          </button>
        </div>

        <label className="si-label" htmlFor="member-name">Member's name</label>
        <input
          id="member-name"
          className="si-pill-input"
          type="text"
          value={memberName}
          onChange={e => setMemberName(e.target.value)}
          placeholder="e.g. Rajan"
          autoFocus
        />

        <label className="si-label" htmlFor="invite-phone">Phone number</label>
        <div className="si-phone-row">
          <select
            className="si-dial-select"
            value={inviteDialCode}
            onChange={e => setInviteDialCode(e.target.value)}
            aria-label="Country code"
          >
            {COUNTRIES.map(c => (
              <option key={c.code} value={c.dial}>
                {c.flag} {c.dial}
              </option>
            ))}
          </select>
          <input
            id="invite-phone"
            className="si-pill-input si-phone-input"
            type="tel"
            value={inviteLocalPhone}
            onChange={e => setInviteLocalPhone(e.target.value.replace(/[^\d\s\-()]/g, ''))}
            placeholder="Phone number"
          />
        </div>
        <p className="im-hint">
          {inviteLocalPhone.trim() === ''
            ? 'Add phone for direct WhatsApp invite (optional)'
            : 'Opens WhatsApp directly to send your invite'}
        </p>

        <label className="si-label" htmlFor="invite-lang">Language</label>
        <select
          id="invite-lang"
          className="si-pill-input si-pill-select"
          value={lang}
          onChange={e => setLang(e.target.value)}
        >
          {LANGUAGES.map(l => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>

        <button
          className="si-pill-btn si-pill-btn--whatsapp"
          onClick={handleInvite}
          disabled={!memberName.trim() || sending}
        >
          <WhatsAppIcon />
          <span className="si-pill-label">
            {sending ? 'Opening WhatsApp…' : 'Send invite via WhatsApp'}
          </span>
        </button>

        <button className="si-back" onClick={onDone}>
          Skip for now
        </button>

        <p className="si-footer">🔒 Secure Encrypted Access</p>
      </div>
    </div>
  )
}

function InviteIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="9" cy="7" r="4" stroke="#0D9488" strokeWidth="2"/>
      <path
        d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

function WhatsAppIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/>
    </svg>
  )
}
