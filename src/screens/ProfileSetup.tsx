import { useState } from 'react'
import type { FirebaseError } from 'firebase/app'
import { updateProfile } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { updateUserProfile } from '../services/firestoreService'
import { AuthErrorModal } from '../components/AuthErrorModal'

// AK-117 — Collected after sign-in for any provider that does not surface a
// displayName (phone OTP, email/password). Google sign-in already supplies
// displayName, so App.tsx routes those users straight past this screen.
interface ProfileSetupProps {
  onComplete: () => void
}

export function ProfileSetup({ onComplete }: ProfileSetupProps) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  // Inline validation feedback for pre-submission rules (empty, too short,
  // too long). Kept separate from authError because instant inline feedback
  // is the right UX for typing-time rules.
  const [validationError, setValidationError] = useState<string | null>(null)
  // Surface backend / Firebase failures through the shared modal.
  const [authError, setAuthError] = useState<FirebaseError | Error | null>(null)

  async function handleSubmit() {
    const trimmedName = name.trim()

    if (!trimmedName) {
      setValidationError('Please enter your name')
      return
    }
    if (trimmedName.length < 2) {
      setValidationError('Name must be at least 2 characters')
      return
    }
    if (trimmedName.length > 50) {
      setValidationError('Name must be 50 characters or less')
      return
    }

    setLoading(true)
    setValidationError(null)
    setAuthError(null)

    try {
      const user = auth.currentUser
      if (!user) throw new Error('No authenticated user')

      await updateProfile(user, { displayName: trimmedName })
      await updateUserProfile(user.uid, { displayName: trimmedName })
      // Force ID token refresh so subsequent Cloud Function calls see fresh
      // state (matches CLAUDE.md guidance after any claims/profile change).
      await user.getIdToken(true)

      onComplete()
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err
          : new Error('Could not save your name. Please try again.'),
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="ps-container">
      <div className="ps-header">
        <h1 className="ps-title">What should we call you?</h1>
        <p className="ps-subtitle">
          This is how you'll appear to your household members.
        </p>
      </div>

      <div className="ps-form">
        <input
          type="text"
          className="ps-input"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit() }}
          autoFocus
          maxLength={50}
          disabled={loading}
        />

        {validationError && (
          <div className="ps-error" role="alert">{validationError}</div>
        )}

        <button
          className="ps-button"
          onClick={() => void handleSubmit()}
          disabled={loading || !name.trim()}
        >
          {loading ? 'Saving…' : 'Continue'}
        </button>
      </div>

      <AuthErrorModal error={authError} onClose={() => setAuthError(null)} />
    </div>
  )
}
