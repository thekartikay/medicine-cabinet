import { useState } from 'react'

interface Props {
  household: { hId: string; name: string }
  onDone: () => void
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
  { code: 'te', label: 'తెలుగు (Telugu)' },
]

const INVITE_TEXT: Record<string, (name: string, hId: string) => string> = {
  en: (name, hId) =>
    `Hi ${name}! Join our family medicine cabinet on MediCab.\nDownload here: https://play.google.com/store/apps/details?id=com.medicab.app\nThen use this code to join: ${hId}`,
  hi: (name, hId) =>
    `नमस्ते ${name}! MediCab पर हमारे परिवार की दवाई कैबिनेट से जुड़ें।\nयहाँ डाउनलोड करें: https://play.google.com/store/apps/details?id=com.medicab.app\nजोड़ने का कोड: ${hId}`,
  kn: (name, hId) =>
    `ನಮಸ್ಕಾರ ${name}! MediCab ನಲ್ಲಿ ನಮ್ಮ ಕುಟುಂಬದ ಔಷಧ ಕ್ಯಾಬಿನೆಟ್‌ಗೆ ಸೇರಿ.\nಇಲ್ಲಿ ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ: https://play.google.com/store/apps/details?id=com.medicab.app\nಸೇರಲು ಕೋಡ್: ${hId}`,
  ta: (name, hId) =>
    `வணக்கம் ${name}! MediCab-ல் எங்கள் குடும்ப மருந்து கேபினட்டில் சேரவும்.\nஇங்கே பதிவிறக்கவும்: https://play.google.com/store/apps/details?id=com.medicab.app\nசேர குறியீடு: ${hId}`,
  te: (name, hId) =>
    `నమస్కారం ${name}! MediCab లో మా కుటుంబ మందుల కేబినెట్‌లో చేరండి.\nఇక్కడ డౌన్‌లోడ్ చేయండి: https://play.google.com/store/apps/details?id=com.medicab.app\nచేరడానికి కోడ్: ${hId}`,
}

export function InviteMember({ household, onDone }: Props) {
  const [memberName, setMemberName] = useState('')
  const [lang, setLang] = useState('en')

  function handleInvite() {
    const recipient = memberName.trim() || 'there'
    const message = INVITE_TEXT[lang](recipient, household.hId)
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank')
    onDone()
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
          disabled={!memberName.trim()}
        >
          <WhatsAppIcon />
          <span className="si-pill-label">Send invite via WhatsApp</span>
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
