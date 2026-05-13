import { useState } from 'react'
import { updateProfile } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { updateUserProfile } from '../services/firestoreService'

// AK-117 — Collected after sign-in for any provider that does not surface a
// displayName (phone OTP, email/password). Google sign-in already supplies
// displayName, so App.tsx routes those users straight past this screen.
interface ProfileSetupProps {
  onComplete: () => void
}

export function ProfileSetup({ onComplete }: ProfileSetupProps) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    const trimmedName = name.trim()

    if (!trimmedName) {
      setError('Please enter your name')
      return
    }
    if (trimmedName.length < 2) {
      setError('Name must be at least 2 characters')
      return
    }
    if (trimmedName.length > 50) {
      setError('Name must be 50 characters or less')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const user = auth.currentUser
      if (!user) throw new Error('No authenticated user')

      await updateProfile(user, { displayName: trimmedName })
      await updateUserProfile(user.uid, { displayName: trimmedName })
      // Force ID token refresh so subsequent Cloud Function calls see fresh
      // state (matches CLAUDE.md guidance after any claims/profile change).
      await user.getIdToken(true)

      onComplete()
    } catch {
      setError('Could not save your name. Please try again.')
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

        {error && <div className="ps-error" role="alert">{error}</div>}

        <button
          className="ps-button"
          onClick={() => void handleSubmit()}
          disabled={loading || !name.trim()}
        >
          {loading ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
