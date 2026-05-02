import { useState } from 'react'
import type { FormEvent } from 'react'
import type { User } from 'firebase/auth'
import { createHousehold } from '../services/firestoreService'

interface Props {
  user: User
  onCreated: (household: { hId: string; name: string }) => void
}

export function CreateHousehold({ user, onCreated }: Props) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setLoading(true)
    setError('')
    try {
      const household = await createHousehold(user, trimmed)
      onCreated(household)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create household. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="si-root">
      <div className="si-hero">
        <div className="si-icon-circle" aria-hidden="true">
          <HouseIcon />
        </div>
        <h1 className="si-app-name">MediCab</h1>
        <p className="si-app-sub">Set up your family cabinet</p>
      </div>

      <div className="si-panel">
        <h2 className="si-panel-title">Name your household</h2>
        <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
          <label className="si-label" htmlFor="household-name">Household name</label>
          <input
            id="household-name"
            className="si-pill-input"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Sharma Family"
            maxLength={60}
            autoFocus
          />
          <button
            type="submit"
            className="si-pill-btn si-pill-btn--action"
            disabled={loading || !name.trim()}
          >
            {loading ? 'Creating…' : 'Create Household'}
          </button>
        </form>

        {error && <p className="si-error" role="alert">{error}</p>}
        <p className="si-footer">🔒 Secure Encrypted Access</p>
      </div>
    </div>
  )
}

function HouseIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
      <polyline
        points="9,22 9,12 15,12 15,22"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}
