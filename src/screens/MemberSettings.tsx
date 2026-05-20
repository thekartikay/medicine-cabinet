import { useEffect, useState } from 'react'
import { signOut, type User as FirebaseUser } from 'firebase/auth'
import { Bell, MessageCircle, Globe, LogOut, Check, User as UserIcon } from 'lucide-react'
import i18n from '../lib/i18n'
import { auth } from '../lib/firebase'
import { getUserDoc, updateUserPreferences } from '../services/firestoreService'
import type { AppUser } from '../types'
import { DeleteAccountSection } from './DeleteAccountSection'
import { Profile } from './Profile'

interface Props {
  user: FirebaseUser
  hId: string
  role: 'admin' | 'member' | 'caregiver'
  currentUid: string
  currentUserName: string
  onAccountDeleted: () => void
}

const LANGUAGES = [
  { code: 'en', label: 'English'           },
  { code: 'hi', label: 'हिन्दी (Hindi)'     },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)'   },
  { code: 'ta', label: 'தமிழ் (Tamil)'     },
  { code: 'te', label: 'తెలుగు (Telugu)'   },
] as const

// Lightweight settings page for members. Mirrors SettingsTab's notification
// + language behaviours but omits household management, the family roster,
// and the invite flow — those belong to the admin only.
export function MemberSettings({ user, hId, role, currentUid, currentUserName, onAccountDeleted }: Props) {
  const [view, setView] = useState<'list' | 'profile'>('list')
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [loadError, setLoadError] = useState('')
  const [showLangSheet, setShowLangSheet] = useState(false)

  useEffect(() => {
    if (view !== 'list') return
    let cancelled = false
    getUserDoc(currentUid)
      .then(u => { if (!cancelled) setAppUser(u) })
      .catch(() => { if (!cancelled) setLoadError('Could not load settings.') })
    return () => { cancelled = true }
  }, [currentUid, view])

  const pushOn = appUser?.pushNotificationsEnabled ?? true
  const waOn   = appUser?.whatsappRemindersEnabled ?? true
  const lang   = appUser?.languagePref ?? 'en'

  async function togglePush() {
    const next = !pushOn
    setAppUser(p => p ? { ...p, pushNotificationsEnabled: next } : p)
    try { await updateUserPreferences(currentUid, { pushNotificationsEnabled: next }) }
    catch { setAppUser(p => p ? { ...p, pushNotificationsEnabled: !next } : p) }
  }

  async function toggleWa() {
    const next = !waOn
    setAppUser(p => p ? { ...p, whatsappRemindersEnabled: next } : p)
    try { await updateUserPreferences(currentUid, { whatsappRemindersEnabled: next }) }
    catch { setAppUser(p => p ? { ...p, whatsappRemindersEnabled: !next } : p) }
  }

  async function pickLanguage(code: string) {
    setShowLangSheet(false)
    setAppUser(p => p ? { ...p, languagePref: code } : p)
    await i18n.changeLanguage(code)
    try { await updateUserPreferences(currentUid, { languagePref: code }) }
    catch { /* local language change still applies */ }
  }

  const langLabel = LANGUAGES.find(l => l.code === lang)?.label ?? 'English'

  if (view === 'profile') {
    return (
      <Profile
        user={user}
        hId={hId}
        role={role}
        onBack={() => setView('list')}
      />
    )
  }

  return (
    <div className="cb-view">
      <h2 className="cb-page-title">Hi {currentUserName}</h2>
      {loadError && <p className="cb-form-error" role="alert">{loadError}</p>}

      {/* ─── Profile (AK-161) ─────────────────────────────────────── */}
      <section className="db-card st-card">
        <button
          type="button"
          className="st-row-button"
          onClick={() => setView('profile')}
        >
          <span className="st-toggle-icon st-toggle-icon--blueberry"><UserIcon size={16} /></span>
          <div className="st-toggle-text">
            <span className="st-toggle-label">Profile</span>
            <span className="st-toggle-sub">Name, language, account</span>
          </div>
          <span className="st-row-chev" aria-hidden="true">›</span>
        </button>
      </section>

      {/* Notifications */}
      <section className="db-card st-card">
        <h3 className="st-section-title">Notifications</h3>

        <div className="st-toggle-row">
          <span className="st-toggle-icon st-toggle-icon--blueberry"><Bell size={16} /></span>
          <div className="st-toggle-text">
            <span className="st-toggle-label">Push notifications</span>
            <span className="st-toggle-sub">Dose reminders and alerts</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={pushOn}
            className={`cb-toggle${pushOn ? ' cb-toggle--on' : ''}`}
            onClick={togglePush}
          >
            <span className="cb-toggle-knob" />
          </button>
        </div>

        <div className="st-toggle-row">
          <span className="st-toggle-icon st-toggle-icon--robin"><MessageCircle size={16} /></span>
          <div className="st-toggle-text">
            <span className="st-toggle-label">WhatsApp reminders</span>
            <span className="st-toggle-sub">For dose confirmations</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={waOn}
            className={`cb-toggle${waOn ? ' cb-toggle--on' : ''}`}
            onClick={toggleWa}
          >
            <span className="cb-toggle-knob" />
          </button>
        </div>
      </section>

      {/* Language */}
      <section className="db-card st-card">
        <h3 className="st-section-title">Language</h3>
        <button
          type="button"
          className="st-row-button"
          onClick={() => setShowLangSheet(true)}
        >
          <span className="st-toggle-icon st-toggle-icon--robin"><Globe size={16} /></span>
          <div className="st-toggle-text">
            <span className="st-toggle-label">{langLabel}</span>
            <span className="st-toggle-sub">Tap to change</span>
          </div>
          <span className="st-row-chev" aria-hidden="true">›</span>
        </button>
      </section>

      {/* Sign out */}
      <button
        type="button"
        className="st-signout-row"
        onClick={() => signOut(auth)}
      >
        <LogOut size={16} />
        <span>Sign out</span>
      </button>

      {/* Account & Privacy (MC-017a) */}
      <DeleteAccountSection onDeleted={onAccountDeleted} />

      {/* Language bottom sheet */}
      {showLangSheet && (
        <div
          className="db-modal-overlay"
          onClick={() => setShowLangSheet(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className="db-modal" onClick={e => e.stopPropagation()}>
            <h3 className="db-modal-title">Choose language</h3>
            <ul className="st-lang-list">
              {LANGUAGES.map(l => (
                <li key={l.code}>
                  <button
                    type="button"
                    className={`st-lang-row${lang === l.code ? ' st-lang-row--active' : ''}`}
                    onClick={() => pickLanguage(l.code)}
                  >
                    <span>{l.label}</span>
                    {lang === l.code && <Check size={16} />}
                  </button>
                </li>
              ))}
            </ul>
            <button className="db-modal-close" onClick={() => setShowLangSheet(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
