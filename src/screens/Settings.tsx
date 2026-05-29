import { useEffect, useState } from 'react'
import { type User as FirebaseUser } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { Bell, MessageCircle, Globe, UserPlus, Check, User as UserIcon, MapPin } from 'lucide-react'
import i18n from '../lib/i18n'
import { auth, functions } from '../lib/firebase'
import {
  getHouseholdMembers,
  getUserDoc,
  updateUserPreferences,
} from '../services/firestoreService'
import type { AppUser, HouseholdMember } from '../types'
import { InviteMember, computeJoinCode } from './InviteMember'
import { AdminMemberView } from './AdminMemberView'
import { Profile } from './Profile'
import { Addresses } from './Addresses'

interface Props {
  user: FirebaseUser
  role: 'admin' | 'member' | 'caregiver'
  hId: string
  householdName: string
  currentUid: string
  currentUserName: string
  isAdmin: boolean
  onAccountDeleted: () => void
}

const ROLE_LABEL: Record<HouseholdMember['role'], string> = {
  admin:     'Admin',
  member:    'Patient',
  caregiver: 'Caregiver',
}

const LANGUAGES = [
  { code: 'en', label: 'English'           },
  { code: 'hi', label: 'हिन्दी (Hindi)'     },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)'   },
  { code: 'ta', label: 'தமிழ் (Tamil)'     },
  { code: 'te', label: 'తెలుగు (Telugu)'   },
] as const

export function SettingsTab({ user, role, hId, householdName, currentUid, currentUserName, isAdmin, onAccountDeleted }: Props) {
  const [view, setView]                 = useState<'list' | 'invite' | 'member' | 'profile' | 'addresses'>('list')
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [members, setMembers]           = useState<HouseholdMember[] | null>(null)
  const [appUser, setAppUser]           = useState<AppUser | null>(null)
  const [loadError, setLoadError]       = useState('')
  const [showLangSheet, setShowLangSheet] = useState(false)

  // Load members + the user's preference doc.
  useEffect(() => {
    if (view !== 'list') return
    let cancelled = false
    setLoadError('')
    Promise.all([
      getHouseholdMembers(hId),
      getUserDoc(currentUid),
    ])
      .then(([m, u]) => {
        if (cancelled) return
        m.sort((a, b) => {
          if (a.uid === currentUid) return -1
          if (b.uid === currentUid) return 1
          if (a.role !== b.role) return a.role === 'admin' ? -1 : 1
          return (a.displayName ?? '').localeCompare(b.displayName ?? '')
        })
        setMembers(m)
        setAppUser(u)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load settings. Check your connection.')
      })
    return () => { cancelled = true }
  }, [hId, currentUid, view])

  // Defaults: both toggles are ON unless the user has explicitly turned them off.
  const pushOn = appUser?.pushNotificationsEnabled ?? true
  const waOn   = appUser?.whatsappRemindersEnabled ?? true
  const lang   = appUser?.languagePref ?? 'en'

  async function togglePush() {
    const next = !pushOn
    setAppUser(prev => prev ? { ...prev, pushNotificationsEnabled: next } : prev)
    try {
      await updateUserPreferences(currentUid, { pushNotificationsEnabled: next })
    } catch {
      setAppUser(prev => prev ? { ...prev, pushNotificationsEnabled: !next } : prev)
    }
  }

  async function toggleWa() {
    const next = !waOn
    setAppUser(prev => prev ? { ...prev, whatsappRemindersEnabled: next } : prev)
    try {
      await updateUserPreferences(currentUid, { whatsappRemindersEnabled: next })
    } catch {
      setAppUser(prev => prev ? { ...prev, whatsappRemindersEnabled: !next } : prev)
    }
  }

  async function pickReminderMethod(m: 'whatsapp' | 'push' | 'both') {
    setAppUser(prev => prev ? { ...prev, reminderMethod: m } : prev)
    try { await updateUserPreferences(currentUid, { reminderMethod: m }) }
    catch { /* keep optimistic */ }
  }

  async function pickLanguage(code: string) {
    setShowLangSheet(false)
    setAppUser(prev => prev ? { ...prev, languagePref: code } : prev)
    await i18n.changeLanguage(code)
    try {
      await updateUserPreferences(currentUid, { languagePref: code })
    } catch {
      // Local language change still applies even if the write fails.
    }
  }

  if (view === 'profile') {
    return (
      <Profile
        user={user}
        hId={hId}
        role={role}
        onBack={() => setView('list')}
        onAccountDeleted={onAccountDeleted}
      />
    )
  }

  if (view === 'addresses') {
    return (
      <Addresses
        hId={hId}
        onBack={() => setView('list')}
      />
    )
  }

  if (view === 'invite') {
    return (
      <InviteMember
        household={{ hId, name: householdName }}
        adminName={currentUserName}
        onDone={() => setView('list')}
      />
    )
  }

  if (view === 'member' && selectedMemberId) {
    const selectedMember = members?.find(m => m.uid === selectedMemberId) ?? null
    if (selectedMember) {
      return (
        <AdminMemberView
          member={selectedMember}
          hId={hId}
          householdName={householdName}
          currentUserName={currentUserName}
          onBack={() => { setView('list'); setSelectedMemberId(null) }}
        />
      )
    }
    // Member roster hasn't loaded yet (or member was removed). Fall through
    // to the list, which will trigger its own load on render.
  }

  const langLabel = LANGUAGES.find(l => l.code === lang)?.label ?? 'English'
  const joinCode  = computeJoinCode(hId)

  return (
    <div className="cb-view">
      <h2 className="cb-page-title">Settings</h2>

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

      {/* ─── Delivery Addresses (AK-163) ────────────────────────── */}
      {isAdmin && (
        <section className="db-card st-card">
          <button
            type="button"
            className="st-row-button"
            onClick={() => setView('addresses')}
          >
            <span className="st-toggle-icon st-toggle-icon--robin"><MapPin size={16} /></span>
            <div className="st-toggle-text">
              <span className="st-toggle-label">Delivery Addresses</span>
              <span className="st-toggle-sub">Where to send your medicines</span>
            </div>
            <span className="st-row-chev" aria-hidden="true">›</span>
          </button>
        </section>
      )}

      {/* ─── Section 1 — Active member (admin only) ─────────────── */}
      {isAdmin && (
        <section className="db-card st-card">
          <h3 className="st-section-title">Active member</h3>
          {!members ? (
            <div className="st-loader"><div className="cb-spinner" role="status" aria-label="Loading" /></div>
          ) : (
            <div className="st-avatar-grid">
              {members.map(m => {
                const name = m.displayName?.trim() || (m.uid === currentUid ? 'You' : 'Member')
                const initial = (m.displayName ?? name).charAt(0).toUpperCase()
                return (
                  <button
                    key={m.uid}
                    type="button"
                    className="cg-avatar-button"
                    onClick={() => { setSelectedMemberId(m.uid); setView('member') }}
                    aria-label={`Manage caregivers for ${name}`}
                  >
                    <span className="st-avatar-tile">
                      <span className="st-avatar-circle" aria-hidden="true">{initial}</span>
                      <span className="st-avatar-name">{name}</span>
                      <span className="st-avatar-role">{ROLE_LABEL[m.role]}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* ─── Section 2 — Notifications ────────────────────────────── */}
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

        {/* Admin-only: reminder method that applies when nudging family members */}
        {isAdmin && (() => {
          const reminderMethod = appUser?.reminderMethod ?? 'both'
          const opts: Array<{ id: 'whatsapp' | 'push' | 'both'; label: string }> = [
            { id: 'whatsapp', label: 'WhatsApp' },
            { id: 'push',     label: 'Push notification' },
            { id: 'both',     label: 'Both' },
          ]
          return (
            <div className="st-toggle-row" style={{ display: 'block', paddingTop: 12 }}>
              <span className="st-toggle-label">Reminder method</span>
              <p className="st-section-sub">How to remind members about missed doses</p>
              <div className="st-radio-group">
                {opts.map(o => {
                  const active = reminderMethod === o.id
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`st-radio-row${active ? ' st-radio-row--active' : ''}`}
                      onClick={() => pickReminderMethod(o.id)}
                    >
                      <span className="st-radio-marker" aria-hidden="true" />
                      <span>{o.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })()}
      </section>

      {/* ─── Section 3 — Language ────────────────────────────────── */}
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

      {/* ─── Section 4 — Household ───────────────────────────────── */}
      <section className="db-card st-card">
        <h3 className="st-section-title">Household</h3>
        <div className="st-household-row">
          <span className="st-house-name">{householdName}</span>
          <span className="st-house-code" aria-label="Household join code">{joinCode}</span>
        </div>

        {isAdmin && (
          <button
            type="button"
            className="st-invite-btn"
            onClick={() => setView('invite')}
          >
            <UserPlus size={16} />
            <span>Invite member</span>
          </button>
        )}
      </section>

      {import.meta.env.DEV && (
        <div style={{
          padding: '16px',
          borderTop: '0.5px solid #E2E8F0',
          marginTop: '16px'
        }}>
          <p style={{
            fontSize: '11px',
            color: '#94A3B8',
            marginBottom: '8px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}>
            Dev tools
          </p>
          <button
            onClick={async () => {
              try {
                const currentUser = auth.currentUser
                if (!currentUser) {
                  alert('Not signed in')
                  return
                }
                // Calls the local Functions emulator (firebase.ts wires
                // connectFunctionsEmulator in DEV). The function accepts the
                // uid in data only when FUNCTIONS_EMULATOR=true, so this
                // path is safe to ship — prod requires real auth.
                const test = httpsCallable(functions, 'testSendNotification')
                await test({ uid: currentUser.uid })
                alert('Test notification sent — check top right of your Mac screen')
              } catch (err) {
                alert('Error: ' + (err as Error).message)
              }
            }}
            style={{
              padding: '8px 16px',
              fontSize: '12px',
              color: '#64748B',
              border: '0.5px solid #E2E8F0',
              borderRadius: '8px',
              background: 'transparent',
              cursor: 'pointer'
            }}
          >
            Test FCM notification
          </button>
        </div>
      )}

      {/* ─── Language bottom sheet ───────────────────────────────── */}
      {showLangSheet && (
        <div
          className="db-modal-overlay"
          onClick={() => setShowLangSheet(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="st-lang-title"
        >
          <div className="db-modal" onClick={e => e.stopPropagation()}>
            <h3 id="st-lang-title" className="db-modal-title">Choose language</h3>
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
