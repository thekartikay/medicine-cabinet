import { useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent } from 'react'
import type { User } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../lib/firebase'

interface Props {
  user: User
  onJoined: (household: { hId: string; name: string }) => void
  onBack: () => void
}

// joinHousehold callable. Takes the 6-digit code, returns { hId, householdName }.
const joinHouseholdFn = httpsCallable<
  { joinCode: string },
  { hId: string; householdName: string }
>(functions, 'joinHousehold')

export function JoinHousehold({ user, onJoined, onBack }: Props) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputs = useRef<(HTMLInputElement | null)[]>([null, null, null, null, null, null])

  const code = digits.join('')
  const isComplete = /^\d{6}$/.test(code)

  function setDigit(idx: number, raw: string) {
    const digit = raw.replace(/[^0-9]/g, '').slice(-1)
    setDigits(prev => {
      const next = [...prev]
      next[idx] = digit
      return next
    })
    if (digit && idx < 5) inputs.current[idx + 1]?.focus()
    if (error) setError('')
  }

  function handleKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      e.preventDefault()
      inputs.current[idx - 1]?.focus()
      setDigits(prev => {
        const next = [...prev]
        next[idx - 1] = ''
        return next
      })
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault()
      inputs.current[idx - 1]?.focus()
    } else if (e.key === 'ArrowRight' && idx < 5) {
      e.preventDefault()
      inputs.current[idx + 1]?.focus()
    } else if (e.key === 'Enter' && isComplete) {
      handleSubmit()
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6)
    if (!text) return
    e.preventDefault()
    const padded = text.padEnd(6, '').split('').slice(0, 6)
    while (padded.length < 6) padded.push('')
    setDigits(padded)
    inputs.current[Math.min(text.length, 5)]?.focus()
  }

  async function handleSubmit() {
    if (!isComplete || loading) return
    setLoading(true)
    setError('')
    try {
      const result = await joinHouseholdFn({ joinCode: code })
      // Refresh the auth token so the new hId/role:'member' claims appear.
      await user.getIdToken(true)
      onJoined({ hId: result.data.hId, name: result.data.householdName })
    } catch (err) {
      setError(parseJoinError(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="si-root">
      <div className="si-hero">
        <div className="si-icon-circle" aria-hidden="true">
          <KeyIcon />
        </div>
        <h1 className="si-app-name">MediCab</h1>
        <p className="si-app-sub">Join your family's medicine cabinet</p>
      </div>

      <div className="si-panel">
        <h2 className="si-panel-title">Join your family's medicine cabinet</h2>
        <p className="si-hint si-hint--left">
          Enter the 6-digit code from the person who invited you
        </p>

        <div className="jh-digit-row" role="group" aria-label="6-digit join code">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={el => { inputs.current[i] = el }}
              className={`jh-digit-input${d ? ' jh-digit-input--filled' : ''}`}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={1}
              value={d}
              onChange={e => setDigit(i, e.target.value)}
              onKeyDown={e => handleKeyDown(i, e)}
              onPaste={handlePaste}
              aria-label={`Digit ${i + 1} of 6`}
              autoFocus={i === 0}
              disabled={loading}
            />
          ))}
        </div>

        {error && <p className="si-error" role="alert">{error}</p>}

        <button
          type="button"
          className="si-pill-btn si-pill-btn--action"
          onClick={handleSubmit}
          disabled={!isComplete || loading}
        >
          {loading ? 'Joining…' : 'Join household'}
        </button>

        <p className="si-hint si-hint--small">
          Don't have a code? Ask your family admin to invite you.
        </p>

        <button
          type="button"
          className="si-back"
          onClick={onBack}
          disabled={loading}
        >
          ← Back
        </button>

        <p className="si-footer">🔒 Secure Encrypted Access</p>
      </div>
    </div>
  )
}

function parseJoinError(err: unknown): string {
  if (err != null && typeof err === 'object' && 'code' in err) {
    switch ((err as { code: string }).code) {
      case 'functions/not-found':
        return 'Invalid code. Check with the person who invited you.'
      case 'functions/already-exists':
        return 'You already belong to a household.'
      case 'functions/invalid-argument':
        return 'Please enter all 6 digits of the join code.'
    }
  }
  if (err instanceof Error) return err.message
  return 'Could not join. Please try again.'
}

function KeyIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}
