// AK-196 — PersonDetail.
//
// One person's tracked medicines as actionable dose cards. Each medicine uses
// MedicineCard for identity, a SupplyLine + label for days remaining, and a row
// per today-slot: pending slots get a "Take" button (markDose), resolved slots
// show their StatusPill. Consumes useReimagined(); no Firestore of its own.

import { useState } from 'react'
import { Avatar, Header, MedicineCard, StatusPill, SupplyLine } from '../../components/reimagined'
import { useReimagined } from '../../contexts/reimaginedContext'
import type { TrackedMedicine } from '../../lib/trackedMedicine'

// A Take button that owns its own in-flight + error state so a slow/failed
// markDose() is visible without blocking the rest of the screen.
function TakeButton({
  slotId,
  onTake,
}: {
  slotId: string
  onTake: (slotId: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        setFailed(false)
        try {
          await onTake(slotId)
        } catch {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }}
      style={{
        padding: '6px 16px',
        borderRadius: 'var(--radius-pill, 9999px)',
        background: 'var(--blueberry, #106470)',
        color: '#ffffff',
        fontSize: 13,
        fontWeight: 600,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? 'Taking…' : failed ? 'Retry' : 'Take'}
    </button>
  )
}

function supplyLabel(tm: TrackedMedicine): string {
  if (tm.supplyState === 'low') return 'Low stock'
  if (Number.isFinite(tm.supplyDays)) return `${tm.supplyDays} days left`
  return 'In stock'
}

function PersonMedicine({
  tm,
  onTake,
}: {
  tm: TrackedMedicine
  onTake: (slotId: string) => Promise<void>
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <MedicineCard name={tm.drug} strength={tm.strength} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 4px' }}>
        {Number.isFinite(tm.supplyDays) && <SupplyLine daysLeft={tm.supplyDays} />}
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: tm.supplyState === 'low' ? 'var(--danger, #E24B4A)' : 'var(--text-muted, #6B7280)',
          }}
        >
          {supplyLabel(tm)}
        </span>
      </div>

      {tm.todaySlots.length === 0 ? (
        <span style={{ fontSize: 13, color: 'var(--text-muted, #6B7280)', padding: '0 4px' }}>
          As needed — no scheduled doses today
        </span>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tm.todaySlots.map((slot) => (
            <li
              key={slot.slotId}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}
            >
              <span style={{ fontSize: 14, color: 'var(--text, #374151)' }}>{slot.time}</span>
              {slot.status === 'pending' ? (
                <TakeButton slotId={slot.slotId} onTake={onTake} />
              ) : (
                <StatusPill status={slot.status} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PersonDetail({ personId, onBack }: { personId: string; onBack: () => void }) {
  const { isLoading, members, trackedByPerson, markDose } = useReimagined()
  const member = members.find((m) => m.uid === personId)
  const name = member?.displayName ?? 'Member'
  const meds = trackedByPerson[personId] ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Header title={name} onBack={onBack} right={<Avatar name={name} size={32} />} />
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {isLoading ? (
          <div role="status" aria-label="Loading medicines" style={{ height: 120, borderRadius: 'var(--radius-card, 24px)', background: 'var(--gray-100, #F3F4F6)' }} />
        ) : meds.length === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--text-muted, #6B7280)', textAlign: 'center' }}>
            No medicines tracked for {name} yet.
          </p>
        ) : (
          meds.map((tm) => <PersonMedicine key={tm.id} tm={tm} onTake={markDose} />)
        )}
      </div>
    </div>
  )
}
