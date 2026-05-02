import { useEffect, useRef, useState } from 'react'
import {
  signInWithPopup,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  type ConfirmationResult,
} from 'firebase/auth'
import { auth, googleProvider } from '../lib/firebase'

type View = 'options' | 'phone-input' | 'otp-input'
type Tab = 'login' | 'signup'

export function SignIn() {
  const [view, setView] = useState<View>('options')
  const [tab, setTab] = useState<Tab>('login')
  const [phone, setPhone] = useState('+91 ')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const recaptchaRef = useRef<RecaptchaVerifier | null>(null)
  const confirmationRef = useRef<ConfirmationResult | null>(null)

  useEffect(() => {
    return () => {
      recaptchaRef.current?.clear()
    }
  }, [])

  function clearError() {
    setError('')
  }

  async function handleGoogleSignIn() {
    clearError()
    setLoading(true)
    try {
      await signInWithPopup(auth, googleProvider)
      // onAuthStateChanged in App.tsx drives the transition to Welcome
    } catch (err) {
      setError(parseAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleSendOtp() {
    clearError()
    setLoading(true)
    try {
      const normalizedPhone = phone.replace(/\s/g, '')
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
    } catch (err) {
      recaptchaRef.current?.clear()
      recaptchaRef.current = null
      setError(parseAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOtp() {
    if (!confirmationRef.current) return
    clearError()
    setLoading(true)
    try {
      await confirmationRef.current.confirm(otp)
      // onAuthStateChanged fires; App.tsx transitions to Welcome
    } catch (err) {
      setError(parseAuthError(err))
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
            <div className="si-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === 'login'}
                className={`si-tab${tab === 'login' ? ' si-tab--active' : ''}`}
                onClick={() => setTab('login')}
              >
                LOGIN
              </button>
              <button
                role="tab"
                aria-selected={tab === 'signup'}
                className={`si-tab${tab === 'signup' ? ' si-tab--active' : ''}`}
                onClick={() => setTab('signup')}
              >
                SIGN UP
              </button>
            </div>

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
              onClick={() => { setView('phone-input'); clearError() }}
              disabled={loading}
            >
              <span className="si-pill-icon-wrap si-pill-icon--phone">
                <PhoneIcon />
              </span>
              <span className="si-pill-label">Continue with Phone</span>
              <span className="si-pill-chevron" aria-hidden="true">›</span>
            </button>
          </>
        )}

        {view === 'phone-input' && (
          <>
            <h2 className="si-panel-title">Enter your number</h2>
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
              {loading ? 'Sending…' : 'Send OTP'}
            </button>
            <button
              className="si-back"
              onClick={() => { setView('options'); setPhone('+91 '); clearError() }}
              disabled={loading}
            >
              ← Back
            </button>
          </>
        )}

        {view === 'otp-input' && (
          <>
            <h2 className="si-panel-title">Verify OTP</h2>
            <p className="si-hint">Code sent to {phone.trim()}</p>
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
              {loading ? 'Verifying…' : 'Verify OTP'}
            </button>
            <button
              className="si-back"
              onClick={() => { setView('phone-input'); setOtp(''); clearError() }}
              disabled={loading}
            >
              ← Change number
            </button>
          </>
        )}

        {error && <p className="si-error" role="alert">{error}</p>}

        <p className="si-footer">🔒 Secure Encrypted Access</p>
      </div>

      {/* Invisible reCAPTCHA anchor — must be in DOM before signInWithPhoneNumber */}
      <div id="recaptcha-container" />
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

function parseAuthError(err: unknown): string {
  if (err != null && typeof err === 'object' && 'code' in err) {
    switch ((err as { code: string }).code) {
      case 'auth/invalid-phone-number':
        return 'Invalid phone number. Use the format: +91 XXXXX XXXXX'
      case 'auth/too-many-requests':
        return 'Too many attempts. Please try again later.'
      case 'auth/code-expired':
        return 'OTP expired. Please request a new one.'
      case 'auth/invalid-verification-code':
        return 'Incorrect OTP. Please try again.'
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request':
        return ''
    }
  }
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}
