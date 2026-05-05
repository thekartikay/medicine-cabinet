import { useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth, requestNotificationPermission } from './lib/firebase'
import { createUserIfNew, getUserDoc, getHousehold } from './services/firestoreService'
import { SignIn } from './screens/SignIn'
import { ChoosePath } from './screens/ChoosePath'
import { CreateHousehold } from './screens/CreateHousehold'
import { JoinHousehold } from './screens/JoinHousehold'
import { InviteMember } from './screens/InviteMember'
import { Dashboard } from './screens/Dashboard'
import './App.css'

type AppState =
  | 'loading'
  | 'unauthenticated'
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

      try {
        const appUser = await getUserDoc(firebaseUser.uid)

        // Branch A: no household yet → ChoosePath (the user picks Create or Join)
        if (!appUser?.householdId) {
          setUser(firebaseUser)
          setAppState('choose-path')
          return
        }

        // Branch B: has household. Resolve role and route accordingly.
        let userRole = await readRoleClaim(firebaseUser)

        // Edge case: Firestore says they're in a household but the role claim
        // hasn't propagated to the token yet. Force a token refresh and re-read.
        if (!userRole) {
          userRole = await readRoleClaim(firebaseUser, /* forceRefresh */ true)
        }

        if (!userRole) {
          // Even after refresh there's no role — claims setup never completed
          // (e.g. Cloud Function partial failure). Send the user back through
          // the join flow so claims can be re-issued.
          setUser(firebaseUser)
          setAppState('joining-household')
          return
        }

        const hh = await getHousehold(appUser.householdId)
        setUser(firebaseUser)
        setHousehold(hh)
        setRole(userRole)
        setAppState(hh ? 'dashboard' : 'choose-path')

        // MC-006: register for FCM push once we have a confirmed household.
        // Fire-and-forget — failures must not block the dashboard render.
        if (hh) void requestNotificationPermission(firebaseUser.uid)
      } catch {
        // If the Firestore read fails (e.g. offline), land on the choose-path
        // screen so the user isn't stuck at the loading spinner indefinitely.
        setUser(firebaseUser)
        setAppState('choose-path')
      }
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

  return <Dashboard user={user!} household={household!} role={role} />
}

export default App
