import { useEffect, useState } from 'react'
import { signOut, type User as FirebaseUser } from 'firebase/auth'
import { ChevronLeft, Copy, Check, LogOut, CreditCard, HelpCircle } from 'lucide-react'
import i18n from '../lib/i18n'
import { auth } from '../lib/firebase'
import {
  getUserDoc,
  updateDisplayNameEverywhere,
  updateUserPreferences,
} from '../services/firestoreService'
import type { AppUser } from '../types'
import { DeleteAccountSection } from './DeleteAccountSection'

type Role = 'admin' | 'member' | 'caregiver'

const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  member: 'Patient',
  caregiver: 'Caregiver',
}

type ProfileLang = 'en' | 'hi' | 'kn' | 'ta' | 'te'

const LANGUAGES: Array<{ code: ProfileLang; label: string }> = [
  { code: 'en', label: 'English'           },
  { code: 'hi', label: 'हिन्दी (Hindi)'     },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)'   },
  { code: 'ta', label: 'தமிழ் (Tamil)'     },
  { code: 'te', label: 'తెలుగు (Telugu)'   },
]

interface Props {
  user: FirebaseUser
  hId: string | null
  role: Role
  onBack: () => void
  onAccountDeleted: () => void
}

// Account ID is shown for support look-ups. We truncate so it fits on one line
// while still letting a support agent disambiguate two users at a glance.
function truncateUid(uid: string): string {
  if (uid.length <= 14) return uid
  return `${uid.slice(0, 8)}...${uid.slice(-4)}`
}

// Shared Profile screen used by both SettingsTab (admin/caregiver host) and
// MemberSettings. Both hosts manage their own view-stack and render this
// component when the user taps "Profile"; onBack returns them to their list.
export function Profile({ user, hId, role, onBack, onAccountDeleted }: Props) {
  const [, setAppUser] = useState<AppUser | null>(null)
  const [loadError, setLoadError] = useState('')

  // Originals captured on mount so dirty detection compares against what the
  // user actually saw, not against stale form state after a partial save.
  const initialName = user.displayName?.trim() ?? ''
  const [name, setName] = useState(initialName)
  const [originalName, setOriginalName] = useState(initialName)

  // Language preference. Matches the 5-language set offered in Settings'
  // bottom-sheet (en/hi/kn/ta/te). The 'en' default applies only when no
  // languagePref is set yet, or when the stored value is outside the
  // supported set — never as a coercion of an otherwise valid choice.
  const [lang, setLang] = useState<ProfileLang>('en')
  const [originalLang, setOriginalLang] = useState<ProfileLang>('en')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [copyOk, setCopyOk] = useState(false)

  useEffect(() => {
    let cancelled = false
    getUserDoc(user.uid)
      .then(u => {
        if (cancelled) return
        setAppUser(u)
        const pref = u?.languagePref
        const loaded: ProfileLang =
          pref === 'hi' || pref === 'kn' || pref === 'ta' || pref === 'te'
            ? pref
            : 'en'
        setLang(loaded)
        setOriginalLang(loaded)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load profile.')
      })
    return () => { cancelled = true }
  }, [user.uid])

  // Auto-clear the "Saved" flash a moment before we navigate back, mirroring
  // the AK-132/AK-138 affirmation cadence used elsewhere in the app.
  useEffect(() => {
    if (!savedMessage) return
    const t = setTimeout(() => setSavedMessage(''), 1200)
    return () => clearTimeout(t)
  }, [savedMessage])

  const nameTrimmed = name.trim()
  const nameDirty = nameTrimmed !== originalName.trim()
  const langDirty = lang !== originalLang
  const dirty = nameDirty || langDirty
  const canSave = dirty && nameTrimmed.length > 0 && !saving

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setSaveError('')
    try {
      const tasks: Promise<unknown>[] = []
      if (nameDirty) {
        tasks.push(updateDisplayNameEverywhere(user.uid, hId, user, nameTrimmed))
      }
      if (langDirty) {
        tasks.push(updateUserPreferences(user.uid, { languagePref: lang }))
      }
      await Promise.all(tasks)
      if (langDirty) {
        await i18n.changeLanguage(lang)
      }
      setOriginalName(nameTrimmed)
      setOriginalLang(lang)
      setSavedMessage('Saved')
      window.setTimeout(() => { onBack() }, 1100)
    } catch {
      setSaveError("Couldn't save changes. Try again.")
      setSaving(false)
    }
  }

  async function handleCopyUid() {
    try {
      await navigator.clipboard.writeText(user.uid)
      setCopyOk(true)
      window.setTimeout(() => setCopyOk(false), 1500)
    } catch {
      // Clipboard API may be unavailable (older WKWebView, non-HTTPS). No-op.
    }
  }

  const phoneDisplay = user.phoneNumber ?? '—'
  const emailDisplay = user.email ?? '—'

  return (
    <div className="cb-view">
      <div className="cb-subheader">
        <button
          type="button"
          className="cb-back-btn"
          onClick={onBack}
          aria-label="Back to settings"
        >
          <ChevronLeft size={20} />
        </button>
        <h2 className="cb-page-title">Profile</h2>
      </div>

      {loadError && <p className="cb-form-error" role="alert">{loadError}</p>}

      <div className="cb-form">
        <div className="cb-field">
          <label className="cb-label" htmlFor="pf-name">Display name</label>
          <input
            id="pf-name"
            className="cb-input"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={saving}
            maxLength={60}
            autoComplete="name"
          />
        </div>

        <div className="cb-field">
          <span className="cb-label">Phone</span>
          <span
            className="cb-input cb-input--readonly"
            aria-label={`Phone: ${phoneDisplay}`}
          >
            {phoneDisplay}
          </span>
        </div>

        <div className="cb-field">
          <span className="cb-label">Email</span>
          <span
            className="cb-input cb-input--readonly"
            aria-label={`Email: ${emailDisplay}`}
          >
            {emailDisplay}
          </span>
        </div>

        <div className="cb-field">
          <span className="cb-label">Role</span>
          <span
            className="cb-input cb-input--readonly"
            aria-label={`Role: ${ROLE_LABEL[role]}`}
          >
            {ROLE_LABEL[role]}
          </span>
        </div>

        <div className="cb-field">
          <label className="cb-label" htmlFor="pf-lang">Language</label>
          <select
            id="pf-lang"
            className="cb-input cb-select"
            value={lang}
            onChange={e => setLang(e.target.value as ProfileLang)}
            disabled={saving}
          >
            {LANGUAGES.map(l => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="cb-field">
          <span className="cb-label">Account ID</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              className="cb-input cb-input--readonly"
              aria-label={`Account ID: ${user.uid}`}
              style={{ flex: 1 }}
            >
              {truncateUid(user.uid)}
            </span>
            <button
              type="button"
              className="cb-back-btn"
              onClick={handleCopyUid}
              aria-label={copyOk ? 'Account ID copied' : 'Copy account ID'}
              title="Copy account ID"
            >
              {copyOk ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <p className="cb-form-error" role="alert" style={{ marginTop: 8 }}>
          {saveError}
        </p>
      )}

      {savedMessage && (
        <p
          className="tr-confirm-message"
          role="status"
          style={{ textAlign: 'center', margin: '4px 0 8px' }}
        >
          {savedMessage}
        </p>
      )}

      <button
        type="button"
        className="cb-submit-btn"
        onClick={handleSave}
        disabled={!canSave}
        style={{ marginTop: 12 }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>

      {/* ─── Sign out (AK-161) ─────────────────────────────────────── */}
      <button
        type="button"
        className="st-signout-row"
        onClick={() => signOut(auth)}
      >
        <LogOut size={16} />
        <span>Sign out</span>
      </button>

      {/* ─── More (AK-161 — inert "coming soon" stubs) ─────────────── */}
      <section className="db-card st-card">
        <button
          type="button"
          className="st-row-button pf-row-disabled"
          disabled
          aria-disabled="true"
        >
          <span className="st-toggle-icon st-toggle-icon--robin"><CreditCard size={16} /></span>
          <div className="st-toggle-text">
            <span className="st-toggle-label">Plan &amp; Billing</span>
            <span className="st-toggle-sub">Coming soon</span>
          </div>
          <span className="st-row-chev" aria-hidden="true">›</span>
        </button>
        <button
          type="button"
          className="st-row-button pf-row-disabled"
          disabled
          aria-disabled="true"
        >
          <span className="st-toggle-icon st-toggle-icon--blueberry"><HelpCircle size={16} /></span>
          <div className="st-toggle-text">
            <span className="st-toggle-label">Help &amp; Support</span>
            <span className="st-toggle-sub">Coming soon</span>
          </div>
          <span className="st-row-chev" aria-hidden="true">›</span>
        </button>
      </section>

      {/* ─── Account & Privacy (MC-017a / AK-56) ───────────────────── */}
      <DeleteAccountSection onDeleted={onAccountDeleted} />
    </div>
  )
}
