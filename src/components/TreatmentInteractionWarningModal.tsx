// AK-124 — Surfaces when the just-added cabinet item interacts with a
// medicine currently powering an active treatment for any household member.
// More prominent than the passive cabinet-sibling interaction badge (which
// only shows on the item card) because the patient is actively taking the
// other medicine and the conflict is clinically immediate.
//
// Less blocking than TreatmentConflictModal — the user already committed
// the add; this is informational + offers an undo path ("Remove from
// cabinet") for the case where they reconsider after seeing the warning.

interface TreatmentInteractionWarningModalProps {
  warning: {
    description: string
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
  }
  onDismiss: () => void
  onRemove: () => void
}

export function TreatmentInteractionWarningModal({
  warning,
  onDismiss,
  onRemove,
}: TreatmentInteractionWarningModalProps) {
  return (
    <div
      className="tiw-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tiw-title"
    >
      <div className="tiw-card">
        <div className="tiw-icon-circle" aria-hidden="true">⚠︎</div>
        <h2 id="tiw-title" className="tiw-title">Active treatment interaction</h2>
        <p className="tiw-description">{warning.description}</p>
        {warning.withMedicineNames.length > 0 && (
          <p className="tiw-with">
            Interacts with: {warning.withMedicineNames.join(', ')}
          </p>
        )}
        <p className="tiw-advisory">
          This medicine may interact with one currently being taken by a household
          member. Consult their doctor before use.
        </p>
        <button
          type="button"
          className="tiw-button tiw-button--primary"
          onClick={onDismiss}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="tiw-button tiw-button--secondary"
          onClick={onRemove}
        >
          Remove from cabinet
        </button>
      </div>
    </div>
  )
}
