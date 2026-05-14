// AK-39 sub-task 2 — Soft-block modal shown at treatment-create time when
// the newly selected medicine has a known interaction with one already in the
// member's active treatments. Per the rescope, this informs but does not
// hard-stop: "Add anyway" lets the user proceed, "Go back" dismisses the
// warning and keeps them on the medicine step.

interface InteractionWarningModalProps {
  warning: {
    description: string
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
  }
  onProceed: () => void
  onGoBack: () => void
}

export function InteractionWarningModal({
  warning,
  onProceed,
  onGoBack,
}: InteractionWarningModalProps) {
  return (
    <div className="iw-overlay" role="dialog" aria-modal="true" aria-labelledby="iw-title">
      <div className="iw-card">
        <div className="iw-icon-circle" aria-hidden="true">⚠︎</div>
        <h2 id="iw-title" className="iw-title">Potential interaction detected</h2>
        <p className="iw-description">{warning.description}</p>
        {warning.withMedicineNames.length > 0 && (
          <p className="iw-with">
            Interacts with: {warning.withMedicineNames.join(', ')}
          </p>
        )}
        <button
          type="button"
          className="iw-button iw-button--primary"
          onClick={onProceed}
        >
          Add anyway
        </button>
        <button
          type="button"
          className="iw-button iw-button--secondary"
          onClick={onGoBack}
        >
          Go back
        </button>
      </div>
    </div>
  )
}
