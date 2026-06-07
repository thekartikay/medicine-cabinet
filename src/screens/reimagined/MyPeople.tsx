// AK-196 — MyPeople (the People tab default).
//
// Lists household members grouped by home, each with their avatar, name, a
// today dose summary, and a low-stock indicator. Tapping a person bubbles their
// uid up to PeopleScreen, which swaps in PersonDetail. Consumes useReimagined();
// no Firestore access of its own.

import { Avatar, Pill } from '../../components/reimagined'
import { useReimagined } from '../../contexts/reimaginedContext'
import { doseSummaryLabel, groupByHome, hasLowStock, summarizeToday } from './peopleSummary'

function PeopleSkeleton() {
  return (
    <div role="status" aria-label="Loading people" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 72,
            borderRadius: 'var(--radius-card, 24px)',
            background: 'var(--gray-100, #F3F4F6)',
          }}
        />
      ))}
    </div>
  )
}

function EmptyPeople() {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted, #6B7280)' }}>
      <p style={{ fontSize: 15 }}>No one here yet. Add a household member to get started.</p>
    </div>
  )
}

export function MyPeople({ onSelect }: { onSelect: (personId: string) => void }) {
  const { isLoading, members, trackedByPerson } = useReimagined()

  if (isLoading) return <PeopleSkeleton />
  if (members.length === 0) return <EmptyPeople />

  const groups = groupByHome(members)

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {groups.map((group) => (
        <section key={group.hId} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: 'var(--text-muted, #6B7280)',
            }}
          >
            Home
          </h2>
          {group.members.map((member) => {
            const tracked = trackedByPerson[member.uid] ?? []
            const summary = summarizeToday(tracked)
            const low = hasLowStock(tracked)
            const name = member.displayName ?? 'Member'
            return (
              <button
                key={member.uid}
                type="button"
                onClick={() => onSelect(member.uid)}
                className="rmg-person-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: 14,
                  borderRadius: 'var(--radius-card, 24px)',
                  background: 'var(--surface, #ffffff)',
                  border: '1px solid var(--border, #E5E7EB)',
                  boxShadow: 'var(--shadow, 0 4px 14px rgba(16,100,112,0.10))',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <Avatar name={name} size={44} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-h, #111827)', fontSize: 16 }}>
                    {name}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted, #6B7280)' }}>
                    {doseSummaryLabel(summary)}
                  </div>
                </div>
                {low && <Pill tone="danger">Low stock</Pill>}
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
}
