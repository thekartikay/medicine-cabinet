import { useState } from 'react'
import type { FormEvent } from 'react'
import { signInWithCustomToken, signInWithPopup } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions, googleProvider, refreshClaimsAndWait } from '../lib/firebase'

// AK-104 — Email collection screen shown after Phone OTP success when the
// authed user has no email. We send the typed email to the
// linkProviderToExistingAccount callable, which decides whether to:
//   - no_op:   email not registered yet — current Firebase user proceeds
//   - linked:  merge happened server-side; we sign in with the returned
//              custom token and let onAuthStateChanged route us
//   - conflict: email belongs to another account that the caller cannot
//              prove ownership of (phone-OTP can't carry email). Show the
//              "Continue with Google" step-up path so the real email owner
//              re-authenticates and absorbs the orphan.

interface LinkResult {
  canonicalUid: string
  customToken: string
  claimsUpdated: boolean
  action: 'linked' | 'no_op' | 'conflict_requires_owner_proof'
}

const linkProviderFn = httpsCallable<
  { email: string; newProviderUid: string; newProvider: 'phone' | 'google.com' },
  LinkResult
>(functions, 'linkProviderToExistingAccount')

interface Props {
  newUid: string
  provider: 'phone' | 'google.com'
  onLinked: (canonicalUid: string) => void
  onError: (message: string) => void
}

type View = 'idle' | 'submitting' | 'linking' | 'conflict'

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.(com|org|net|in|co|io|dev|app|edu|gov|info|uk|us|me|ai)$/i

export function EmailLinkPrompt({ newUid, provider, onLinked, onError }: Props) {
  const [email, setEmail] = useState('')
  const [view, setView] = useState<View>('idle')
  const [error, setError] = useState('')

  const trimmed = email.trim()
  const emailValid = EMAIL_RE.test(trimmed)

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (!emailValid || view === 'submitting' || view === 'linking') return
    setError('')
    setView('submitting')
    try {
      const result = await linkProviderFn({
        email: trimmed,
        newProviderUid: newUid,
        newProvider: provider,
      })
      await handleResult(result.data)
    } catch (err) {
      setView('idle')
      const message = parseError(err)
      setError(message)
      onError(message)
    }
  }

  async function handleResult(result: LinkResult) {
    switch (result.action) {
      case 'no_op':
        // Email isn't registered yet. Keep the current Firebase user and
        // continue the App.tsx pipeline.
        onLinked(newUid)
        return
      case 'linked':
        // Server merged us into the canonical user. Swap sessions then wait
        // for the hId claim to land before letting onAuthStateChanged route.
        setView('linking')
        try {
          await signInWithCustomToken(auth, result.customToken)
          await refreshClaimsAndWait(auth.currentUser, 'hId')
        } catch (err) {
          const message = parseError(err)
          setError(message)
          setView('idle')
          onError(message)
        }
        // No onLinked() — onAuthStateChanged will fire with the canonical UID
        // and App.tsx will re-run the routing pipeline.
        return
      case 'conflict_requires_owner_proof':
        setView('conflict')
        return
    }
  }

  async function handleGoogleStepUp() {
    if (view === 'submitting' || view === 'linking') return
    setError('')
    setView('submitting')
    try {
      const userCred = await signInWithPopup(auth, googleProvider)
      const googleEmail = userCred.user.email
      const googleUid = userCred.user.uid
      if (!googleEmail) {
        const message = 'Google account did not return an email.'
        setError(message)
        setView('conflict')
        onError(message)
        return
      }
      const result = await linkProviderFn({
        email: googleEmail,
        newProviderUid: googleUid,
        newProvider: 'google.com',
      })
      await handleResult(result.data)
    } catch (err) {
      const message = parseError(err)
      setError(message)
      setView('conflict')
      onError(message)
    }
  }

  if (view === 'linking') {
    return (
      <div className="si-root">
        <div className="si-hero">
          <div className="si-icon-circle" aria-hidden="true">
            <MailIcon />
          </div>
          <h1 className="si-app-name">MediCab</h1>
          <p className="si-app-sub">Linking your account…</p>
        </div>
        <div className="si-panel">
          <div className="si-spinner" role="status" aria-label="Linking" />
          <p className="si-hint">Almost there. Loading your household.</p>
        </div>
      </div>
    )
  }

  if (view === 'conflict') {
    return (
      <div className="si-root">
        <div className="si-hero">
          <div className="si-icon-circle" aria-hidden="true">
            <MailIcon />
          </div>
          <h1 className="si-app-name">MediCab</h1>
          <p className="si-app-sub">Existing account found</p>
        </div>
        <div className="si-panel">
          <h2 className="si-panel-title">Verify it's you</h2>
          <p className="si-hint si-hint--left">
            An account with this email already exists. Sign in with Google to
            verify and link your phone.
          </p>
          <button
            type="button"
            className="si-pill-btn si-pill-btn--action"
            onClick={handleGoogleStepUp}
            disabled={false}
          >
            <span className="si-pill-icon-wrap si-pill-icon--google">
              <GoogleIcon />
            </span>
            <span className="si-pill-label">Continue with Google</span>
          </button>
          {error && <p className="si-error" role="alert">{error}</p>}
          <button
            type="button"
            className="si-back"
            onClick={() => { setView('idle'); setError('') }}
          >
            ← Try a different email
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="si-root">
      <div className="si-hero">
        <div className="si-icon-circle" aria-hidden="true">
          <MailIcon />
        </div>
        <h1 className="si-app-name">MediCab</h1>
        <p className="si-app-sub">One more step</p>
      </div>
      <div className="si-panel">
        <h2 className="si-panel-title">What's your email?</h2>
        <p className="si-hint si-hint--left">
          We use email to keep your account in sync across devices. If you
          already have a MediCab account, we'll link them automatically.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
          <label className="si-label" htmlFor="email-link-input">Email</label>
          <input
            id="email-link-input"
            className="si-pill-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (error) setError('') }}
            placeholder="your@email.com"
            autoFocus
            disabled={view === 'submitting'}
          />
          <button
            type="submit"
            className="si-pill-btn si-pill-btn--action"
            disabled={!emailValid || view === 'submitting'}
          >
            {view === 'submitting' ? 'Continuing…' : 'Continue'}
          </button>
        </form>
        {error && <p className="si-error" role="alert">{error}</p>}
        <p className="si-footer">🔒 Secure Encrypted Access</p>
      </div>
    </div>
  )
}

function parseError(err: unknown): string {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code
    switch (code) {
      case 'functions/permission-denied':
        return "We couldn't verify that account. Please try again."
      case 'functions/failed-precondition':
        return 'Both accounts are already in use. Contact support to merge.'
      case 'functions/invalid-argument':
        return 'Please enter a valid email address.'
      case 'functions/unavailable':
      case 'functions/deadline-exceeded':
        return "Couldn't reach the server. Check your connection and try again."
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request':
        return ''
    }
  }
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

function MailIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 8l9 6 9-6M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg className="si-google-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )
}
