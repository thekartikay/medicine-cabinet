import { useEffect, useRef, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import {
  signInWithCustomToken,
  setPersistence,
  browserSessionPersistence,
} from 'firebase/auth'
import { auth } from '../lib/firebase'
import { acceptCaregiverGrantFn } from '../services/caregiverGrantsCalls'
import { storeCaregiverSession } from '../services/caregiverSession'

// AK-58 sub-task 3 Step 1 — magic link landing page.
//
// URL: /caregiver/accept?gid={grantId}&hId={hId}&mId={memberId}&s={grantSecret}
//
// Flow:
//   1. Parse the four URL params; bail to error state if any missing.
//   2. setPersistence(browserSessionPersistence) so the synthetic caregiver
//      session is per-tab and dies on tab close. Must happen BEFORE the
//      custom-token exchange so the resulting ID token lands in sessionStorage,
//      not the default IndexedDB persistence that the main app uses.
//   3. Call acceptCaregiverGrantFn → returns {customToken, expiresAt, visibleMemberId}.
//   4. signInWithCustomToken to exchange the Custom Token for an ID Token
//      that carries the caregiver claims (role, hId, memberId, grantId) the
//      Firestore Rules check. This is the SOLE auth surface for caregivers
//      — no email/Google/phone sign-in exists for them.
//   5. Persist a tiny metadata record (expiresAt + ids) to sessionStorage so
//      the dashboard can enforce conceptual expiry without re-decoding the
//      ID token.
//   6. Hand control back to CaregiverRouter via onAccepted() and replace the
//      URL so a back-button press doesn't re-trigger accept (which would now
//      fail with "already used").

type State =
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }

interface Params {
  gid: string
  hId: string
  mId: string
  s: string
}

function readParams(): Params | null {
  const p = new URLSearchParams(window.location.search)
  const gid = p.get('gid')
  const hId = p.get('hId')
  const mId = p.get('mId')
  const s = p.get('s')
  if (!gid || !hId || !mId || !s) return null
  return { gid, hId, mId, s }
}

function messageFor(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'functions/not-found':
        return 'This link is invalid. Ask your family member for a fresh link.'
      case 'functions/failed-precondition':
        return err.message || "This link can't be used. Ask your family member for a fresh link."
      case 'functions/invalid-argument':
        return 'This link is missing information. Ask your family member for a fresh link.'
      case 'functions/unavailable':
      case 'functions/deadline-exceeded':
        return "Couldn't reach the server. Check your connection and try again."
      default:
        return err.message || 'Something went wrong. Please try again.'
    }
  }
  return "Couldn't reach the server. Check your connection and try again."
}

interface Props {
  onAccepted: () => void
}

export function CaregiverAccept({ onAccepted }: Props) {
  const [state, setState] = useState<State>({ kind: 'verifying' })
  // StrictMode double-mounts effects in dev. The grant is one-time-use so the
  // second call would always fail. Guard with a module-scoped ref that
  // survives the simulated remount.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    async function run() {
      const params = readParams()
      if (!params) {
        setState({
          kind: 'error',
          message: 'This link is missing information. Ask your family member for a fresh link.',
        })
        return
      }

      try {
        await setPersistence(auth, browserSessionPersistence)
        const result = await acceptCaregiverGrantFn({
          hId: params.hId,
          mId: params.mId,
          grantId: params.gid,
          grantSecret: params.s,
        })
        const { customToken, expiresAt, visibleMemberId } = result.data
        await signInWithCustomToken(auth, customToken)
        storeCaregiverSession({
          hId: params.hId,
          grantId: params.gid,
          visibleMemberId,
          expiresAt,
        })
        setState({ kind: 'success' })
        // Brief pause so the success state is perceivable before the route flips.
        setTimeout(() => {
          window.history.replaceState(null, '', '/caregiver/dashboard')
          onAccepted()
        }, 800)
      } catch (err) {
        setState({ kind: 'error', message: messageFor(err) })
      }
    }

    void run()
  }, [onAccepted])

  if (state.kind === 'verifying') {
    return (
      <div className="cc-root">
        <div className="cc-card">
          <div className="cc-spinner" role="status" aria-label="Verifying your access" />
          <h1 className="cc-title">Verifying your access…</h1>
          <p className="cc-help">This will just take a moment.</p>
        </div>
      </div>
    )
  }

  if (state.kind === 'success') {
    return (
      <div className="cc-root">
        <div className="cc-card">
          <div className="cc-checkmark" aria-hidden="true">✓</div>
          <h1 className="cc-title">Access granted</h1>
          <p className="cc-help">Loading today's view…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cc-root">
      <div className="cc-card cc-card--error">
        <div className="cc-error-icon" aria-hidden="true">!</div>
        <h1 className="cc-title">Couldn't open this link</h1>
        <p className="cc-error-msg" role="alert">{state.message}</p>
        <button
          type="button"
          className="cc-back-btn"
          onClick={() => window.history.back()}
        >
          Go back
        </button>
      </div>
    </div>
  )
}
