import { useEffect } from 'react'
import type { FirebaseError } from 'firebase/app'

interface AuthErrorModalProps {
  error: FirebaseError | Error | string | null
  onClose: () => void
}

// Plain-English mapping for Firebase Auth error codes. Anything not listed
// here falls through to error.message (per the spec).
const FIREBASE_ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/user-not-found': 'No account found with that email.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/too-many-requests':
    'Too many attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed':
    'No internet connection. Please check your network.',
  // Phone-OTP codes preserved from the prior parseAuthError mapping.
  'auth/invalid-phone-number':
    'Invalid phone number. Use the format: +91 XXXXX XXXXX',
  'auth/code-expired': 'OTP expired. Please request a new one.',
  'auth/invalid-verification-code': 'Wrong code. Try again.',
  'auth/captcha-check-failed': 'Verification failed. Refresh and try again.',
}

// Codes we deliberately swallow — usually user-initiated cancellations.
const SUPPRESSED_ERROR_CODES = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
])

export function AuthErrorModal({ error, onClose }: AuthErrorModalProps) {
  useEffect(() => {
    if (error == null) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [error, onClose])

  if (error == null) return null

  let message: string
  if (typeof error === 'string') {
    message = error
  } else {
    const code =
      typeof (error as FirebaseError).code === 'string'
        ? (error as FirebaseError).code
        : undefined
    if (code && SUPPRESSED_ERROR_CODES.has(code)) return null
    message =
      (code && FIREBASE_ERROR_MESSAGES[code]) ||
      error.message ||
      'Something went wrong. Please try again.'
  }

  return (
    <div
      className="ae-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ae-title"
    >
      <div className="ae-card" onClick={(e) => e.stopPropagation()}>
        <h2 id="ae-title" className="ae-title">Something went wrong</h2>
        <p className="ae-message">{message}</p>
        <button
          type="button"
          className="ae-button"
          onClick={onClose}
          autoFocus
        >
          OK
        </button>
      </div>
    </div>
  )
}
