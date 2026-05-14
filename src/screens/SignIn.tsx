import { useEffect, useRef, useState } from 'react'
import type { FirebaseError } from 'firebase/app'
import {
  signInWithPopup,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  type ConfirmationResult,
} from 'firebase/auth'
import { auth, googleProvider } from '../lib/firebase'
import { AuthErrorModal } from '../components/AuthErrorModal'

type View = 'options' | 'phone-input' | 'otp-input'

// AK-112 — OTP polish constants. Kept inline so the values are visible at the
// call sites that reference them (resend useEffect, lockout reset effect, etc.).
const RESEND_SECONDS = 60
const LOCKOUT_SECONDS = 5 * 60
const MAX_OTP_ATTEMPTS = 3

export function SignIn() {
  const [view, setView] = useState<View>('options')
  const [phone, setPhone] = useState('+91 ')
  const [otp, setOtp] = useState('')
  const [authError, setAuthError] = useState<FirebaseError | Error | null>(null)
  const [loading, setLoading] = useState(false)

  // AK-112 — resend timer, help-toggle, attempt counter, and lockout.
  // State is in-memory only. A page refresh resets the lockout because
  // CLAUDE.md rule #1 forbids localStorage; Firebase Auth's own
  // auth/too-many-requests still gates the server, so client-side lockout
  // is a UX nudge rather than a security boundary.
  const [resendCountdown, setResendCountdown] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [lockoutCountdown, setLockoutCountdown] = useState(0)

  const recaptchaRef = useRef<RecaptchaVerifier | null>(null)
  const confirmationRef = useRef<ConfirmationResult | null>(null)

  useEffect(() => {
    return () => {
      recaptchaRef.current?.clear()
    }
  }, [])

  // Resend-timer tick. Decrements once per second while > 0.
  useEffect(() => {
    if (resendCountdown <= 0) return
    const id = setTimeout(() => setResendCountdown(c => c - 1), 1000)
    return () => clearTimeout(id)
  }, [resendCountdown])

  // Lockout-timer tick. Mirrors the resend tick but is independent so the two
  // countdowns can run simultaneously (we still show the resend timer while
  // the lockout banner is up).
  useEffect(() => {
    if (lockoutCountdown <= 0) return
    const id = setTimeout(() => setLockoutCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearTimeout(id)
  }, [lockoutCountdown])

  // When the lockout clears, reset the attempt counter so the user starts
  // fresh on their next try.
  useEffect(() => {
    if (lockoutCountdown === 0 && failedAttempts >= MAX_OTP_ATTEMPTS) {
      setFailedAttempts(0)
    }
  }, [lockoutCountdown, failedAttempts])

  const canResend = resendCountdown === 0
  const isLockedOut = lockoutCountdown > 0

  function clearAuthError() {
    setAuthError(null)
  }

  function asAuthError(err: unknown): FirebaseError | Error {
    if (err instanceof Error) return err
    return new Error(typeof err === 'string' ? err : 'Something went wrong. Please try again.')
  }

  async function handleGoogleSignIn() {
    clearAuthError()
    setLoading(true)
    try {
      await signInWithPopup(auth, googleProvider)
      // onAuthStateChanged in App.tsx drives the transition to Welcome
    } catch (err) {
      setAuthError(asAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleSendOtp() {
    if (isLockedOut) return
    clearAuthError()
    setLoading(true)
    try {
      const normalizedPhone = phone.replace(/\s/g, '')
      // Always use a real RecaptchaVerifier. In DEV the
      // auth.settings.appVerificationDisabledForTesting flag set in
      // firebase.ts bypasses the verify() call and the reCAPTCHA Enterprise
      // enforcement-config fetch, so the emulator works. In production the
      // real verification runs.
      if (!recaptchaRef.current) {
        recaptchaRef.current = new RecaptchaVerifier(auth, 'recaptcha-container', {
          size: 'invisible',
        })
      }
      confirmationRef.current = await signInWithPhoneNumber(
        auth,
        normalizedPhone,
        recaptchaRef.current,
      )
      setView('otp-input')
      setOtp('')
      setShowHelp(false)
      setResendCountdown(RESEND_SECONDS)
      // Fresh send → fresh attempts counter. The lockout effect already
      // resets attempts when its countdown expires, so this is mostly a
      // safety net for the back-to-phone-input → resend path.
      setFailedAttempts(0)
    } catch (err) {
      recaptchaRef.current?.clear()
      recaptchaRef.current = null
      setAuthError(asAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleResendOtp() {
    if (!canResend || isLockedOut || loading) return
    // Each RecaptchaVerifier is bound to one signInWithPhoneNumber call.
    // Force a fresh one before re-sending.
    recaptchaRef.current?.clear()
    recaptchaRef.current = null
    await handleSendOtp()
  }

  async function handleVerifyOtp() {
    if (!confirmationRef.current || isLockedOut) return
    clearAuthError()
    setLoading(true)
    try {
      await confirmationRef.current.confirm(otp)
      // onAuthStateChanged fires; App.tsx transitions to Welcome
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code === 'auth/invalid-verification-code') {
        const nextAttempts = failedAttempts + 1
        setFailedAttempts(nextAttempts)
        setOtp('')
        if (nextAttempts >= MAX_OTP_ATTEMPTS) {
          setLockoutCountdown(LOCKOUT_SECONDS)
          setAuthError(null)
        } else {
          const remaining = MAX_OTP_ATTEMPTS - nextAttempts
          // Synthesized informational message — not a Firebase error, but the
          // modal accepts any Error and renders error.message verbatim.
          setAuthError(
            new Error(
              `Wrong code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`,
            ),
          )
        }
      } else {
        setAuthError(asAuthError(err))
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="si-root">

      {/* ── White hero ──────────────────────────────────────── */}
      <div className="si-hero">
        <div className="si-icon-circle" aria-hidden="true">
          <PillIcon />
        </div>
        <h1 className="si-app-name">MediCab</h1>
        <p className="si-app-sub">Household Medicine Manager</p>
      </div>

      {/* ── Dark teal panel ─────────────────────────────────── */}
      <div className="si-panel">

        {view === 'options' && (
          <>
            <h2 className="si-panel-title">Sign in to MediCab</h2>

            <button
              className="si-pill-btn"
              onClick={handleGoogleSignIn}
              disabled={loading}
            >
              <span className="si-pill-icon-wrap si-pill-icon--google">
                <GoogleIcon />
              </span>
              <span className="si-pill-label">Continue with Google</span>
              <span className="si-pill-chevron" aria-hidden="true">›</span>
            </button>

            <button
              className="si-pill-btn"
              onClick={() => { setView('phone-input'); clearAuthError() }}
              disabled={loading}
            >
              <span className="si-pill-icon-wrap si-pill-icon--phone">
                <PhoneIcon />
              </span>
              <span className="si-pill-label">Continue with phone</span>
              <span className="si-pill-chevron" aria-hidden="true">›</span>
            </button>

            <p className="si-caregiver-hint">
              Joining as a caregiver? Open your invite link from WhatsApp or email.
            </p>
          </>
        )}

        {view === 'phone-input' && (
          <>
            <h2 className="si-panel-title">Enter your phone number</h2>
            <label className="si-label" htmlFor="phone-input">Mobile number</label>
            <input
              id="phone-input"
              className="si-pill-input"
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              autoFocus
            />
            <button
              className="si-pill-btn si-pill-btn--action"
              onClick={handleSendOtp}
              disabled={loading || phone.replace(/\D/g, '').length < 10}
            >
              {loading ? 'Sending…' : 'Send code'}
            </button>
            <button
              className="si-back"
              onClick={() => { setView('options'); setPhone('+91 '); clearAuthError() }}
              disabled={loading}
            >
              ← Back
            </button>
          </>
        )}

        {view === 'otp-input' && (
          <>
            <h2 className="si-panel-title">Enter verification code</h2>
            <p className="si-hint">Code sent to {phone.trim()}</p>

            {isLockedOut ? (
              <div className="si-lockout" role="alert">
                <p className="si-lockout-title">Too many incorrect attempts</p>
                <p className="si-lockout-sub">
                  Try again in{' '}
                  <span className="si-mono">{formatMMSS(lockoutCountdown)}</span>
                </p>
              </div>
            ) : (
              <>
                <input
                  id="otp-input"
                  className="si-pill-input si-pill-input--otp"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                />
                <button
                  className="si-pill-btn si-pill-btn--action"
                  onClick={handleVerifyOtp}
                  disabled={loading || otp.length < 6}
                >
                  {loading ? 'Verifying…' : 'Verify'}
                </button>
              </>
            )}

            {!isLockedOut && (
              canResend ? (
                <button
                  type="button"
                  className="si-resend si-resend--active"
                  onClick={handleResendOtp}
                  disabled={loading}
                >
                  Didn't receive code? Resend
                </button>
              ) : (
                <p className="si-resend si-resend--countdown">
                  Resend code in{' '}
                  <span className="si-mono">0:{resendCountdown.toString().padStart(2, '0')}</span>
                </p>
              )
            )}

            {canResend && !isLockedOut && (
              <div className="si-help">
                <button
                  type="button"
                  className="si-help-toggle"
                  onClick={() => setShowHelp(v => !v)}
                  aria-expanded={showHelp}
                >
                  📱 Didn't get the code? {showHelp ? '▲' : '▼'}
                </button>
                {showHelp && (
                  <div className="si-help-body">
                    <p className="si-help-title">What to try:</p>
                    <ul className="si-help-list">
                      <li>Check your SMS inbox</li>
                      <li>Make sure you entered the correct number</li>
                      <li>Check if your phone has network signal</li>
                      <li>Wait a minute and try resending</li>
                      <li>Contact support if problem persists</li>
                    </ul>
                  </div>
                )}
              </div>
            )}

            <button
              className="si-back"
              onClick={() => { setView('phone-input'); setOtp(''); setShowHelp(false); clearAuthError() }}
              disabled={loading || isLockedOut}
            >
              ← Change number
            </button>
          </>
        )}

        <p className="si-footer">🔒 Secure Encrypted Access</p>
      </div>

      {/* Invisible reCAPTCHA anchor — must be in DOM before signInWithPhoneNumber */}
      <div id="recaptcha-container" />

      <AuthErrorModal error={authError} onClose={clearAuthError} />
    </div>
  )
}

function PillIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <g transform="rotate(-35 20 20)">
        {/* Left half — lighter teal */}
        <path d="M20 15H11a5 5 0 0 0 0 10h9V15z" fill="#5EEAD4"/>
        {/* Right half — brand teal */}
        <path d="M20 15h9a5 5 0 0 1 0 10h-9V15z" fill="#0D9488"/>
        <line x1="20" y1="14" x2="20" y2="26" stroke="white" strokeWidth="1.5" opacity="0.8"/>
      </g>
    </svg>
  )
}

function PhoneIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
        fill="currentColor"
      />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg className="si-google-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}

function formatMMSS(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

