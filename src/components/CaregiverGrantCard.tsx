import { useEffect, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import {
  revokeCaregiverGrantFn,
  type CaregiverGrantSafe,
  type WireTimestamp,
} from '../services/caregiverGrantsCalls'

interface Props {
  memberId: string
  grant: CaregiverGrantSafe
  // Called on successful revoke so the parent can update the local list.
  onRevoked: (grantId: string, revokedAt: WireTimestamp) => void
  // Called on revoke failure — surfaces an inline toast at the parent.
  onError: (message: string) => void
}

type Status = 'active' | 'awaiting' | 'revoked'

function statusOf(grant: CaregiverGrantSafe): Status {
  if (grant.revokedAt !== null) return 'revoked'
  if (grant.acceptedAt === null) return 'awaiting'
  return 'active'
}

function formatRelative(ts: WireTimestamp | null): string {
  if (!ts) return ''
  const ms = ts._seconds * 1000
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function describeRevokeError(err: unknown): string {
  if (err instanceof FirebaseError) {
    if (err.code === 'functions/not-found') return 'Grant no longer exists.'
    if (err.code === 'functions/permission-denied') return "You don't have permission to revoke this."
    if (err.code === 'functions/unavailable' || err.code === 'functions/deadline-exceeded') {
      return "Couldn't reach the server. Try again."
    }
    return err.message || 'Could not revoke. Try again.'
  }
  return 'Could not revoke. Try again.'
}

// AK-58 sub-task 2 — single grant card with status badge and revoke flow.
// Status is derived from grant fields, not stored. Revoke goes through a
// confirmation sub-modal so the destructive action requires deliberate
// confirmation.
export function CaregiverGrantCard({ memberId, grant, onRevoked, onError }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const status = statusOf(grant)

  // Esc-to-close on the confirmation sub-modal.
  useEffect(() => {
    if (!confirmOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !revoking) {
        e.preventDefault()
        setConfirmOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmOpen, revoking])

  async function handleRevoke() {
    if (revoking) return
    setRevoking(true)
    try {
      await revokeCaregiverGrantFn({ memberId, grantId: grant.grantId })
      // Optimistic local update — server's revokedAt will overwrite on next
      // refresh; using client-side seconds in the meantime is fine for the
      // "just revoked" rendering.
      const now: WireTimestamp = {
        _seconds: Math.floor(Date.now() / 1000),
        _nanoseconds: 0,
      }
      onRevoked(grant.grantId, now)
      setConfirmOpen(false)
    } catch (err) {
      console.error('revokeCaregiverGrant failed:', err)
      onError(describeRevokeError(err))
    } finally {
      setRevoking(false)
    }
  }

  const statusLabel =
    status === 'active' ? 'Active'
    : status === 'awaiting' ? 'Awaiting first use'
    : 'Revoked'

  return (
    <div className={`cg-grant cg-grant--${status}`}>
      <div className="cg-grant-top">
        <span className="cg-grant-contact">{grant.contactEmailOrPhone}</span>
        <span className={`cg-grant-status cg-grant-status--${status}`}>{statusLabel}</span>
      </div>

      <div className="cg-grant-meta">
        <span>Created {formatRelative(grant.createdAt)}</span>
        {status === 'active' && (
          <span>
            {grant.lastUsedAt
              ? `Last viewed ${formatRelative(grant.lastUsedAt)}`
              : 'Not viewed yet'}
          </span>
        )}
      </div>

      {status !== 'revoked' && (
        <button
          type="button"
          className="cg-grant-revoke-btn"
          onClick={() => setConfirmOpen(true)}
        >
          Revoke
        </button>
      )}

      {confirmOpen && (
        <div
          className="db-modal-overlay"
          onClick={() => { if (!revoking) setConfirmOpen(false) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`cg-revoke-title-${grant.grantId}`}
        >
          <div className="db-modal cg-modal" onClick={e => e.stopPropagation()}>
            <h3 id={`cg-revoke-title-${grant.grantId}`} className="db-modal-title">
              Revoke access for {grant.contactEmailOrPhone}?
            </h3>
            <p className="cg-section-sub">
              They will lose access immediately. They will need a new link if
              you want to share again later.
            </p>
            <button
              type="button"
              className="cg-grant-revoke-btn cg-grant-revoke-btn--confirm"
              onClick={handleRevoke}
              disabled={revoking}
            >
              {revoking ? 'Revoking…' : 'Revoke access'}
            </button>
            <button
              type="button"
              className="cg-modal-cancel"
              onClick={() => setConfirmOpen(false)}
              disabled={revoking}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
