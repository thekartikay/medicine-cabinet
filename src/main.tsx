import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'   // needed when the caregiver tree mounts without <App>
import './lib/i18n'   // side-effect: registers en/hi/kn translation resources
import App from './App.tsx'

// AK-165 — Lazy-load the caregiver tree. Only /caregiver/* paths instantiate
// it, so the dominant (non-caregiver) entry bundle drops the CaregiverRouter
// + its dependencies. Caregiver visitors pay one extra fetch on first paint;
// regular visitors save the bytes entirely.
const CaregiverRouter = lazy(() =>
  import('./components/CaregiverRouter').then(m => ({ default: m.CaregiverRouter })),
)

// AK-58 sub-task 3 — top-level pathname guard. Magic-link visitors land on
// /caregiver/accept and must NOT pass through App's onAuthStateChanged →
// consent → household-routing pipeline. Splitting here means the caregiver
// tree never instantiates <App>, so a signInWithCustomToken inside
// CaregiverAccept cannot trigger any of App's auth-state effects.
const isCaregiverRoute = window.location.pathname.startsWith('/caregiver/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense
      fallback={
        <div className="app-loading" aria-label="Loading">
          <div className="loading-spinner" role="status" />
        </div>
      }
    >
      {isCaregiverRoute ? <CaregiverRouter /> : <App />}
    </Suspense>
  </StrictMode>,
)
