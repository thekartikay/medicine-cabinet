// AK-123 — Conflict modal shown at the step 3 → step 4 boundary of the
// treatment-create wizard when the member already has an active treatment
// for the same medicine whose date range collides with the new one.
//
// Two modes driven by the conflictType prop:
//   • 'duplicate' / 'subset' → hard block. No proceed button. The user must
//     go back to step 3 and change the dates (or cancel the wizard).
//   • 'overlap'              → soft warn. Two buttons; the proceed path
//     stamps an append-only acknowledgement doc on the new treatment so the
//     deliberate-override decision is auditable.

export type ConflictType = 'duplicate' | 'subset' | 'overlap'

interface TreatmentConflictModalProps {
  conflictType: ConflictType
  existingTreatmentName: string
  medicineName: string
  onGoBack: () => void
  // Present only for soft warns. Hard blocks omit this prop entirely.
  onProceed?: () => void
}

function bodyText(
  conflictType: ConflictType,
  existingTreatmentName: string,
  medicineName: string,
): string {
  const intro = `There is already an active ${medicineName} treatment called "${existingTreatmentName}"`
  if (conflictType === 'duplicate') {
    return `${intro}. This would create a duplicate.`
  }
  if (conflictType === 'subset') {
    return `${intro} that covers this entire time period.`
  }
  return `${intro} that overlaps with these dates. Please confirm you want to proceed.`
}

export function TreatmentConflictModal({
  conflictType,
  existingTreatmentName,
  medicineName,
  onGoBack,
  onProceed,
}: TreatmentConflictModalProps) {
  const isHardBlock = conflictType === 'duplicate' || conflictType === 'subset'
  const title = isHardBlock ? 'Cannot create this treatment' : 'Overlapping treatment detected'
  const iconVariant = isHardBlock ? 'danger' : 'warn'
  const iconGlyph = isHardBlock ? '✕' : '⚠︎'

  return (
    <div
      className="tcm-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tcm-title"
    >
      <div className="tcm-card">
        <div className={`tcm-icon-circle tcm-icon-circle--${iconVariant}`} aria-hidden="true">
          {iconGlyph}
        </div>
        <h2 id="tcm-title" className="tcm-title">{title}</h2>
        <p className="tcm-body">
          {bodyText(conflictType, existingTreatmentName, medicineName)}
        </p>
        {/* Hard blocks render only the Go-back button. Soft warns render
            both, primary action first. */}
        {!isHardBlock && onProceed && (
          <button
            type="button"
            className="tcm-button tcm-button--primary"
            onClick={onProceed}
          >
            I understand, proceed anyway
          </button>
        )}
        <button
          type="button"
          className={`tcm-button ${isHardBlock ? 'tcm-button--primary' : 'tcm-button--secondary'}`}
          onClick={onGoBack}
        >
          Go back
        </button>
      </div>
    </div>
  )
}
