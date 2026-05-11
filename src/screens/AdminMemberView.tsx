import { useEffect, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import type { HouseholdMember } from '../types'
import { CaregiverShareModal } from '../components/CaregiverShareModal'
import { CaregiverGrantCard } from '../components/CaregiverGrantCard'
import {
  listCaregiverGrantsFn,
  type CaregiverGrantSafe,
  type WireTimestamp,
} from '../services/caregiverGrantsCalls'

interface Props {
  member: HouseholdMember
  hId: string
  householdName: string
  currentUserName: string
  onBack: () => void
}

const ROLE_LABEL: Record<HouseholdMember['role'], string> = {
  admin: 'Admin',
  member: 'Patient',
  caregiver: 'Caregiver',
}

// AK-58 sub-task 2 — admin-side per-member detail screen. Mounted from
// SettingsTab when the admin taps a member tile. Houses the "Caregivers"
// section that issues, lists, and revokes per-member grants.
//
// Reached via SettingsTab's local view-state machine (no react-router) — see
// the `view: 'list' | 'invite' | 'member'` union in Settings.tsx.
export function AdminMemberView({ member, currentUserName, onBack }: Props) {
  const [shareOpen, setShareOpen] = useState(false)
  // Bumped after a successful create; triggers the list refetch.
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [grants, setGrants] = useState<CaregiverGrantSafe[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [revokeToast, setRevokeToast] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadError('')
    listCaregiverGrantsFn({ memberId: member.uid })
      .then(result => {
        if (cancelled) return
        // Sort: active first, awaiting next, revoked last; within each,
        // newest first by createdAt.
        const sorted = [...result.data.grants].sort((a, b) => {
          const order = (g: CaregiverGrantSafe) =>
            g.revokedAt !== null ? 2 : g.acceptedAt === null ? 1 : 0
          const oa = order(a)
          const ob = order(b)
          if (oa !== ob) return oa - ob
          const ta = a.createdAt?._seconds ?? 0
          const tb = b.createdAt?._seconds ?? 0
          return tb - ta
        })
        setGrants(sorted)
      })
      .catch(err => {
        if (cancelled) return
        if (err instanceof FirebaseError && err.code === 'functions/permission-denied') {
          setLoadError("You don't have permission to view caregivers for this member.")
        } else {
          setLoadError('Could not load caregivers. Check your connection.')
        }
        setGrants([])
      })
    return () => { cancelled = true }
  }, [member.uid, refreshSeq])

  // Auto-dismiss revoke error toast.
  useEffect(() => {
    if (!revokeToast) return
    const t = setTimeout(() => setRevokeToast(null), 2400)
    return () => clearTimeout(t)
  }, [revokeToast])

  function handleRevoked(grantId: string, revokedAt: WireTimestamp) {
    setGrants(prev =>
      prev ? prev.map(g => g.grantId === grantId ? { ...g, revokedAt } : g) : prev,
    )
  }

  const memberName = member.displayName?.trim() || 'Member'
  const initial = memberName.charAt(0).toUpperCase()

  return (
    <div className="cb-view">
      <button
        type="button"
        className="cg-back"
        onClick={onBack}
        aria-label="Back to settings"
      >
        ← Settings
      </button>

      <h2 className="cb-page-title">{memberName}</h2>

      <section className="db-card cg-card">
        <div className="cg-member-header">
          <span className="st-avatar-circle" aria-hidden="true">{initial}</span>
          <div className="cg-member-meta">
            <span className="cg-member-name">{memberName}</span>
            <span className="cg-member-role">{ROLE_LABEL[member.role]}</span>
          </div>
        </div>
      </section>

      <section className="db-card cg-card">
        <h3 className="st-section-title">Caregivers</h3>
        <p className="cg-section-sub">
          Trusted family or friends who can see {memberName}'s daily doses in
          real time. They don't need a MediCab account.
        </p>

        {/* TODO(AK-80): gate this button on users/{uid}.subscriptionTier === 'family'
            when the paywall ships. Closed beta is intentionally ungated to validate
            whether caregiver dashboard is the conversion lever the PRD claims. */}
        <button
          type="button"
          className="cg-share-btn"
          onClick={() => setShareOpen(true)}
        >
          Share with caregiver
        </button>

        <div className="cg-grant-list">
          {loadError && (
            <p className="cb-form-error" role="alert">{loadError}</p>
          )}

          {!loadError && grants === null && (
            <div className="cg-grant-loading" role="status" aria-label="Loading caregivers">
              <span className="cb-spinner" aria-hidden="true" />
            </div>
          )}

          {!loadError && grants && grants.length === 0 && (
            <p className="cg-grant-empty">
              No caregivers yet. Tap <strong>Share with caregiver</strong> to
              invite someone trusted to check in remotely.
            </p>
          )}

          {!loadError && grants && grants.length > 0 && (
            grants.map(g => (
              <CaregiverGrantCard
                key={g.grantId}
                memberId={member.uid}
                grant={g}
                onRevoked={handleRevoked}
                onError={setRevokeToast}
              />
            ))
          )}
        </div>
      </section>

      {revokeToast && (
        <div className="db-toast" role="status" aria-live="polite">
          {revokeToast}
        </div>
      )}

      {shareOpen && (
        <CaregiverShareModal
          memberId={member.uid}
          memberName={memberName}
          adminName={currentUserName}
          onClose={() => setShareOpen(false)}
          onCreated={() => setRefreshSeq(s => s + 1)}
        />
      )}
    </div>
  )
}
