import { useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from './lib/firebase'
import { createUserIfNew, getUserDoc, getHousehold } from './services/firestoreService'
import { SignIn } from './screens/SignIn'
import { CreateHousehold } from './screens/CreateHousehold'
import { InviteMember } from './screens/InviteMember'
import { Dashboard } from './screens/Dashboard'
import './App.css'

type AppState =
  | 'loading'
  | 'unauthenticated'
  | 'creating-household'
  | 'inviting-member'
  | 'dashboard'

type HouseholdSummary = { hId: string; name: string }

function App() {
  const [appState, setAppState] = useState<AppState>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [household, setHousehold] = useState<HouseholdSummary | null>(null)

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
        if (appUser?.householdId) {
          const hh = await getHousehold(appUser.householdId)
          setUser(firebaseUser)
          setHousehold(hh)
          setAppState(hh ? 'dashboard' : 'creating-household')
        } else {
          setUser(firebaseUser)
          setAppState('creating-household')
        }
      } catch {
        // If the Firestore read fails (e.g. offline), land on household creation so
        // the user isn't stuck at the loading spinner indefinitely
        setUser(firebaseUser)
        setAppState('creating-household')
      }
    })
  }, [])

  function onHouseholdCreated(hh: HouseholdSummary) {
    setHousehold(hh)
    setAppState('inviting-member')
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

  if (appState === 'creating-household') {
    return <CreateHousehold user={user!} onCreated={onHouseholdCreated} />
  }

  if (appState === 'inviting-member') {
    return <InviteMember household={household!} onDone={onInviteDone} />
  }

  return <Dashboard user={user!} household={household!} />
}

export default App
