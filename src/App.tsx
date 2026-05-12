import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions, requestNotificationPermission } from './lib/firebase'
import { CURRENT_POLICY_VERSION } from './lib/paths'
import {
  createUserIfNew,
  getUserDoc,
  getHousehold,
  getConsentRecord,
} from './services/firestoreService'
import type { AppUser } from './types'
import { SignIn } from './screens/SignIn'
import { ChoosePath } from './screens/ChoosePath'
import { CreateHousehold } from './screens/CreateHousehold'
import { JoinHousehold } from './screens/JoinHousehold'
import { InviteMember } from './screens/InviteMember'
import { Dashboard } from './screens/Dashboard'
import { ConsentScreen } from './screens/ConsentScreen'
import { EmailLinkPrompt } from './screens/EmailLinkPrompt'
import './App.css'

type AppState =
  | 'loading'
  | 'unauthenticated'
  | 'email-link-required'
  | 'consent-required'
  | 'consent-required-bumped'
  | 'restore-prompt'
  | 'deletion-scheduled'
  | 'choose-path'
  | 'creating-household'
  | 'joining-household'
  | 'inviting-member'
  | 'dashboard'

// AK-104 — context for the EmailLinkPrompt screen.
type EmailLinkContext = { newUid: string; provider: 'phone' | 'google.com' }

type Role = 'admin' | 'member' | 'caregiver'
type HouseholdSummary = { hId: string; name: string }

// Reads the role custom claim from the user's token. Returns the literal value
// or null if no role claim is set yet (e.g. claims haven't propagated after a
// Cloud Function call).
async function readRoleClaim(u: User, forceRefresh = false): Promise<Role | null> {
  const result = await u.getIdTokenResult(forceRefresh)
  // eslint-disable-next-line no-console
  console.log('[crossdev debug] claims (forceRefresh=' + forceRefresh + '):', {
    uid: u.uid,
    hId: result.claims.hId,
    role: result.claims.role,
    issuedAt: result.issuedAtTime,
  })
  const role = result.claims.role as Role | undefined
  return role ?? null
}

function App() {
  const [appState, setAppState] = useState<AppState>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [household, setHousehold] = useState<HouseholdSummary | null>(null)
  const [role, setRole] = useState<Role>('admin')
  const [emailLinkContext, setEmailLinkContext] =
    useState<EmailLinkContext | null>(null)

  // Resumes the standard post-auth routing: householdless users go to
  // ChoosePath; everyone else gets a role claim + dashboard. Pulled out so
  // the consent-completion handler can re-enter the same flow without
  // duplicating it.
  async function resolvePostConsent(firebaseUser: User) {
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

      if (hh) void requestNotificationPermission(firebaseUser.uid)
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
      // eslint-disable-next-line no-console
      console.log('[crossdev debug] onAuthStateChanged user:', {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        providers: firebaseUser.providerData.map((p) => p.providerId),
      })

      // Temporary diagnostic — surfaces customClaims at sign-in. Force-refresh
      // so the values reflect the Auth backend (the same view server-side
      // functions see via auth.getUser(uid)), not a possibly-stale token.
      try {
        const tokenResult = await firebaseUser.getIdTokenResult(true)
        /* eslint-disable no-console */
        console.log('[DIAGNOSTIC] uid:', firebaseUser.uid)
        console.log('[DIAGNOSTIC] email:', firebaseUser.email)
        console.log('[DIAGNOSTIC] claims.hId:', tokenResult.claims.hId)
        console.log('[DIAGNOSTIC] claims.role:', tokenResult.claims.role)
        /* eslint-enable no-console */
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log('[DIAGNOSTIC] failed to read token:', err)
      }

      try {
        await createUserIfNew(firebaseUser)
      } catch {
        // Auth succeeds even if the Firestore write fails; it retries on next sign-in
      }

      // Profile read shared by the AK-104 phone gate and the MC-017a
      // deleted-account gate below. Tolerates failure (e.g. transient rules
      // error) by leaving appUser null; downstream branches are safe with
      // null and fall through to the consent screen.
      let appUser: AppUser | null = null
      try {
        appUser = await getUserDoc(firebaseUser.uid)
      } catch {
        // Leave appUser null.
      }

      // AK-104 (D1): phone users without a MediCab-recorded email get
      // prompted. users/{uid}.email is the source of truth — it is only
      // written by linkProviderToExistingAccount when MediCab has actually
      // seen an email. Trusting firebaseUser.email instead lets a previously
      // -linked canonical UID (phone+email already on the Auth record) slip
      // past the prompt on a fresh Phone OTP sign-in.
      if (firebaseUser.phoneNumber && !appUser?.email) {
        setUser(firebaseUser)
        setEmailLinkContext({ newUid: firebaseUser.uid, provider: 'phone' })
        setAppState('email-link-required')
        return
      }

      // MC-017a: legal gate. Check soft-delete state and consent before any
      // other routing. The deletion check has to come first because a user
      // whose account is in the recovery window can still sign in but should
      // see the restore prompt rather than the consent screen.
      if (appUser?.deletedAt) {
        setUser(firebaseUser)
        setAppState('restore-prompt')
        return
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

      await resolvePostConsent(firebaseUser)
    })
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

  if (appState === 'email-link-required' && emailLinkContext) {
    return (
      <EmailLinkPrompt
        newUid={emailLinkContext.newUid}
        provider={emailLinkContext.provider}
        onLinked={(canonicalUid) => {
          setEmailLinkContext(null)
          // no_op path: canonical UID is the current Firebase user. Continue
          // the pipeline manually since onAuthStateChanged won't fire again.
          // (The linked path swaps sessions via signInWithCustomToken inside
          // EmailLinkPrompt, which DOES fire onAuthStateChanged and re-runs
          // routing from scratch — so we don't need to handle that here.)
          if (user && canonicalUid === user.uid) {
            setAppState('loading')
            void resolvePostConsent(user)
          } else {
            setAppState('loading')
          }
        }}
        onError={(msg) => {
          // eslint-disable-next-line no-console
          console.error('[ak-104] EmailLinkPrompt error:', msg)
          // Keep the user on the screen so they can retry; inline error is
          // already shown by EmailLinkPrompt itself.
        }}
      />
    )
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
