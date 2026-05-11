import { useEffect, useState } from 'react'
import { CaregiverAccept } from '../screens/CaregiverAccept'
import { CaregiverDashboard } from '../screens/CaregiverDashboard'

// AK-58 sub-task 3 — pathname-based switch for the caregiver tree. Mounted
// by main.tsx instead of <App /> when window.location.pathname starts with
// '/caregiver/'. The main app's onAuthStateChanged listener never runs, so
// the synthetic caregiver-{grantId} sign-in cannot collide with the normal
// consent / household routing.
//
// We don't use react-router here even though the package is installed —
// react-router-dom is unused by App.tsx and pulling it into this one tree
// would create a second routing convention. Keep it tiny: read pathname,
// listen for popstate, render the matching screen.

type Route = 'accept' | 'dashboard' | 'unknown'

function pathToRoute(): Route {
  const p = window.location.pathname
  if (p === '/caregiver/accept') return 'accept'
  if (p === '/caregiver/dashboard') return 'dashboard'
  return 'unknown'
}

export function CaregiverRouter() {
  const [route, setRoute] = useState<Route>(pathToRoute)

  useEffect(() => {
    function onPop() {
      setRoute(pathToRoute())
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  if (route === 'accept') {
    return <CaregiverAccept onAccepted={() => setRoute('dashboard')} />
  }

  if (route === 'dashboard') {
    return <CaregiverDashboard />
  }

  return (
    <div className="cc-root">
      <div className="cc-card cc-card--error">
        <h1 className="cc-title">Page not found</h1>
        <p className="cc-error-msg">This caregiver link doesn't match a known page.</p>
      </div>
    </div>
  )
}
