import { lazy, Suspense, useEffect, useState } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions, requestNotificationPermission } from './lib/firebase'
import { CURRENT_POLICY_VERSION } from './lib/paths'
import {
  createUserIfNew,
  getUserDoc,
  getHousehold,
  getConsentRecord,
  getMemberDisplayName,
  syncMemberDisplayName,
} from './services/firestoreService'
// AK-165 — SignIn stays eager because it's the first-paint screen for any
// unauthenticated visit. OfflineBanner is the chrome that always renders.
// Everything else is post-auth and goes lazy — Dashboard pulls Cabinet /
// Treatments / MemberDoseCard / Settings transitively, which is the bulk of
// the cut to the entry chunk.
import { SignIn } from './screens/SignIn'
import { OfflineBanner } from './components/OfflineBanner'
const ChoosePath = lazy(() => import('./screens/ChoosePath').then(m => ({ default: m.ChoosePath })))
const CreateHousehold = lazy(() => import('./screens/CreateHousehold').then(m => ({ default: m.CreateHousehold })))
const JoinHousehold = lazy(() => import('./screens/JoinHousehold').then(m => ({ default: m.JoinHousehold })))
const InviteMember = lazy(() => import('./screens/InviteMember').then(m => ({ default: m.InviteMember })))
const Dashboard = lazy(() => import('./screens/Dashboard').then(m => ({ default: m.Dashboard })))
const ConsentScreen = lazy(() => import('./screens/ConsentScreen').then(m => ({ default: m.ConsentScreen })))
const ProfileSetup = lazy(() => import('./screens/ProfileSetup').then(m => ({ default: m.ProfileSetup })))
import './App.css'

type AppState =
  | 'loading'
  | 'unauthenticated'
  | 'consent-required'
  | 'consent-required-bumped'
  | 'profile-setup-required'
  | 'restore-prompt'
  | 'deletion-scheduled'
  | 'choose-path'
  | 'creating-household'
  | 'joining-household'
  | 'inviting-member'
  | 'dashboard'

type Role = 'admin' | 'member' | 'caregiver'
type HouseholdSummary = { hId: string; name: string }

// Reads the role custom claim from the user's token. Returns the literal value
// or null if no role claim is set yet (e.g. claims haven't propagated after a
// Cloud Function call).
async function readRoleClaim(u: User, forceRefresh = false): Promise<Role | null> {
  const result = await u.getIdTokenResult(forceRefresh)
  const role = result.claims.role as Role | undefined
  return role ?? null
}

function App() {
  const [appState, setAppState] = useState<AppState>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [household, setHousehold] = useState<HouseholdSummary | null>(null)
  const [role, setRole] = useState<Role>('admin')
  // AK-172 — foreground dose reminder banner. firebase.ts rebroadcasts the
  // FCM onMessage payload as a CustomEvent; this state drives the banner UI.
  const [doseToast, setDoseToast] = useState<{ title: string; body: string } | null>(null)

  // Resumes the standard post-auth routing: householdless users go to
  // ChoosePath; everyone else gets a role claim + dashboard. Pulled out so
  // the consent-completion handler can re-enter the same flow without
  // duplicating it.
  async function resolvePostConsent(firebaseUser: User) {
    // AK-117 — displayName gate. Every path into post-auth routing converges
    // here (the auth listener after consent, the ConsentScreen onConsented
    // callback, the RestorePromptScreen onRestored callback, and the
    // ProfileSetup onComplete callback). Phone OTP and email sign-ins arrive
    // with displayName=null; Google supplies it. Without this gate the fresh
    // phone-OTP flow goes consent → choose-path and skips ProfileSetup, since
    // the listener-level check below only fires when consent is already
    // satisfied (which is never true on first sign-in).
    if (!firebaseUser.displayName || firebaseUser.displayName.trim() === '') {
      setUser(firebaseUser)
      setAppState('profile-setup-required')
      return
    }

    try {
      const appUser = await getUserDoc(firebaseUser.uid)

      if (!appUser?.householdId) {
        setUser(firebaseUser)
        setAppState('choose-path')
        return
      }

      let userRole = await readRoleClaim(firebaseUser)
      if (!userRole) {
        userRole = await readRoleClaim(firebaseUser, /* forceRefresh */ true)
      }

      if (!userRole) {
        setUser(firebaseUser)
        setAppState('joining-household')
        return
      }

      const hh = await getHousehold(appUser.householdId)
      setUser(firebaseUser)
      setHousehold(hh)
      setRole(userRole)
      setAppState(hh ? 'dashboard' : 'choose-path')

      if (hh) {
        void requestNotificationPermission(firebaseUser.uid)
        // AK-153 — One-time self-heal for member docs that pre-date AK-117
        // (their displayName was stamped from Auth before ProfileSetup ran).
        // Fire-and-forget: the picker fallback covers the brief window before
        // this completes, and a duplicate write is harmless if the backfill
        // script already fixed this row.
        void (async () => {
          try {
            const memberName = await getMemberDisplayName(hh.hId, firebaseUser.uid)
            const authName = firebaseUser.displayName?.trim()
            if ((!memberName || memberName.trim() === '') && authName) {
              await syncMemberDisplayName(hh.hId, firebaseUser.uid, authName)
            }
          } catch {
            // Self-heal is best-effort; nothing user-visible if it fails.
          }
        })()
      }
    } catch {
      setUser(firebaseUser)
      setAppState('choose-path')
    }
  }

  useEffect(() => {
    return onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setUser(null)
        setHousehold(null)
        setAppState('unauthenticated')
        return
      }

      try {
        await createUserIfNew(firebaseUser)
      } catch {
        // Auth succeeds even if the Firestore write fails; it retries on next sign-in
      }

      // MC-017a: legal gate. Check soft-delete state and consent before any
      // other routing. The deletion check has to come first because a user
      // whose account is in the recovery window can still sign in but should
      // see the restore prompt rather than the consent screen.
      try {
        const appUser = await getUserDoc(firebaseUser.uid)
        if (appUser?.deletedAt) {
          setUser(firebaseUser)
          setAppState('restore-prompt')
          return
        }
      } catch {
        // Profile read failed (offline / rules). Fall through to consent check;
        // a missing profile won't block consent, and a missing consent gates
        // everything anyway.
      }

      try {
        const consent = await getConsentRecord(firebaseUser.uid)
        if (!consent) {
          setUser(firebaseUser)
          setAppState('consent-required')
          return
        }
        if (consent.policyVersion !== CURRENT_POLICY_VERSION) {
          setUser(firebaseUser)
          setAppState('consent-required-bumped')
          return
        }
      } catch {
        // Couldn't read the consent doc — gate the user behind ConsentScreen
        // rather than risk leaking the dashboard before consent is confirmed.
        setUser(firebaseUser)
        setAppState('consent-required')
        return
      }

      // resolvePostConsent owns the AK-117 displayName gate (and all
      // subsequent household routing) so every entry point — this listener,
      // ConsentScreen.onConsented, RestorePromptScreen.onRestored, and
      // ProfileSetup.onComplete — flows through the same check.
      await resolvePostConsent(firebaseUser)
    })
  }, [])

  // AK-172 — listen for foreground dose reminders re-broadcast by firebase.ts
  // and show a 5-second auto-dismissing banner. Each fresh event resets the
  // dismiss timer so the latest reminder always gets its full visible window.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { notification?: { title?: string; body?: string } }
        | undefined
      const title = detail?.notification?.title ?? ''
      const body = detail?.notification?.body ?? ''
      if (!title && !body) return
      if (timer) clearTimeout(timer)
      setDoseToast({ title, body })
      timer = setTimeout(() => setDoseToast(null), 5000)
    }
    window.addEventListener('foreground-dose-reminder', handler)
    return () => {
      window.removeEventListener('foreground-dose-reminder', handler)
      if (timer) clearTimeout(timer)
    }
  }, [])

  async function onHouseholdCreated(hh: HouseholdSummary) {
    setHousehold(hh)
    if (user) {
      const r = await readRoleClaim(user, true)   // claims now include role:'admin'
      setRole(r ?? 'admin')
      void requestNotificationPermission(user.uid)   // MC-006
    }
    setAppState('inviting-member')
  }

  async function onHouseholdJoined(hh: HouseholdSummary) {
    setHousehold(hh)
    if (user) {
      const r = await readRoleClaim(user, true)   // claims now include role:'member'
      setRole(r ?? 'member')
      void requestNotificationPermission(user.uid)   // MC-006
    }
    setAppState('dashboard')                       // skip InviteMember; member can't invite
  }

  function onInviteDone() {
    setAppState('dashboard')
  }

  // Existing state-machine return logic, unchanged. Pulled into a helper so
  // the top-level return can wrap it alongside the global OfflineBanner.
  function renderScreen() {
    if (appState === 'loading') {
      return (
        <div className="app-loading" aria-label="Loading">
          <div className="loading-spinner" role="status" />
        </div>
      )
    }

    if (appState === 'unauthenticated') {
      return <SignIn />
    }

    if (appState === 'consent-required' || appState === 'consent-required-bumped') {
      return (
        <ConsentScreen
          user={user!}
          policyUpdated={appState === 'consent-required-bumped'}
          onConsented={() => resolvePostConsent(user!)}
        />
      )
    }

    if (appState === 'profile-setup-required') {
      return (
        <ProfileSetup
          onComplete={() => {
            // updateProfile resolved → auth.currentUser.displayName is now set.
            // Resume the same post-consent routing the listener would have run.
            setAppState('loading')
            void resolvePostConsent(user!)
          }}
        />
      )
    }

    if (appState === 'restore-prompt') {
      return <RestorePromptScreen user={user!} onRestored={() => resolvePostConsent(user!)} />
    }

    if (appState === 'deletion-scheduled') {
      return <DeletionScheduledScreen />
    }

    if (appState === 'choose-path') {
      return (
        <ChoosePath
          onCreate={() => setAppState('creating-household')}
          onJoin={() => setAppState('joining-household')}
        />
      )
    }

    if (appState === 'creating-household') {
      return (
        <CreateHousehold
          user={user!}
          onCreated={onHouseholdCreated}
          onBack={() => setAppState('choose-path')}
        />
      )
    }

    if (appState === 'joining-household') {
      return (
        <JoinHousehold
          user={user!}
          onJoined={onHouseholdJoined}
          onBack={() => setAppState('choose-path')}
        />
      )
    }

    if (appState === 'inviting-member') {
      return (
        <InviteMember
          household={household!}
          adminName={user?.displayName?.trim() || 'A family member'}
          onDone={onInviteDone}
        />
      )
    }

    return <Dashboard user={user!} household={household!} role={role} onAccountDeleted={() => setAppState('deletion-scheduled')} />
  }

  return (
    <>
      <OfflineBanner />
      {doseToast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            maxWidth: 'calc(100vw - 24px)',
            padding: '12px 16px',
            background: '#FFFFFF',
            border: '1px solid #5DC1C8',
            borderLeft: '4px solid #5DC1C8',
            borderRadius: 8,
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.12)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: '#0F172A', fontSize: 14 }}>{doseToast.title}</div>
            {doseToast.body && (
              <div style={{ color: '#475569', fontSize: 13, marginTop: 2 }}>{doseToast.body}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setDoseToast(null)}
            aria-label="Dismiss"
            style={{
              flex: 'none',
              border: 0,
              background: 'transparent',
              color: '#94A3B8',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: 4,
            }}
          >×</button>
        </div>
      )}
      {/* AK-165 — Single Suspense boundary for all lazy post-auth screens.
          Fallback mirrors the existing 'loading' state render so the spinner
          shape is consistent across initial app boot and inter-screen
          transitions. SignIn (eager) never triggers this fallback. */}
      <Suspense
        fallback={
          <div className="app-loading" aria-label="Loading">
            <div className="loading-spinner" role="status" />
          </div>
        }
      >
        {renderScreen()}
      </Suspense>
    </>
  )
}

// MC-017a — shown when a user signs back in inside the 30-day recovery window.
// Calls restoreAccount to clear deletedAt + re-attach claims, then resumes
// normal post-consent routing.
function RestorePromptScreen({ user, onRestored }: { user: User; onRestored: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleRestore() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await httpsCallable(functions, 'restoreAccount')({})
      // Force a token refresh so the re-issued claims (hId/role) are visible
      // to subsequent Firestore reads.
      await user.getIdToken(true)
      onRestored()
    } catch {
      setError('Could not restore your account. Try again, or sign out.')
      setBusy(false)
    }
  }

  return (
    <div className="cs-root">
      <header className="cs-header">
        <h1 className="cs-title">Welcome back</h1>
        <p className="cs-eyebrow">Your account is scheduled for deletion.</p>
      </header>
      <main className="cs-body">
        <p className="cs-lead">
          You asked to delete your MediCab account. We are still inside the 30-day window, so we can restore it now if you want to keep using MediCab.
        </p>
        <p className="cs-lead">
          If you do nothing, your account and dose history will be permanently removed at the end of the recovery window.
        </p>
        {error && <p className="cs-error" role="alert">{error}</p>}
        <button
          type="button"
          className="cs-agree-btn"
          onClick={handleRestore}
          disabled={busy}
        >
          {busy ? 'Restoring…' : 'Restore my account'}
        </button>
        <button
          type="button"
          className="cs-decline-link"
          onClick={() => signOut(auth)}
        >
          Not now → sign me out
        </button>
      </main>
    </div>
  )
}

// MC-017a — shown right after a user confirms account deletion from Settings.
// We sign them out from the deletion handler, so the SignIn screen is what
// they'll see on return — this screen is the explanatory pause in between.
function DeletionScheduledScreen() {
  return (
    <div className="cs-root">
      <header className="cs-header">
        <h1 className="cs-title">Account scheduled for deletion</h1>
      </header>
      <main className="cs-body">
        <p className="cs-lead">
          We have scheduled your MediCab account for deletion. You have <strong>30 days</strong> to recover by signing in again.
        </p>
        <p className="cs-lead">
          After that, your medicines, dose history, and AI query logs will be permanently removed from MediCab's servers.
        </p>
        <button
          type="button"
          className="cs-agree-btn"
          onClick={() => signOut(auth)}
        >
          Done
        </button>
      </main>
    </div>
  )
}

export default App
