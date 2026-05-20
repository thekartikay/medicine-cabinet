import { useState } from 'react'

// AK-39 sub-task 3 — Hard-block drug-interaction modal shown at the
// step 2 → step 3 boundary of the treatment-create wizard. Replaces the
// sub-task 2 soft-warn that previously offered "Add anyway".
//
// The default view exposes only two paths: a primary "Go back" (closes
// the modal, keeps the user on step 2 to pick a different medicine) and
// a secondary "Override (admin logged)" that reveals an inline
// justification field. Confirming the override invokes onOverride with
// the trimmed justification string; the parent is responsible for
// buffering that text and writing the audit row via
// recordInteractionAcknowledgement once the treatment doc exists.

interface InteractionWarningModalProps {
  warning: {
    description: string
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
  }
  onGoBack: () => void
  onOverride: (justification: string) => void
}

const MIN_JUSTIFICATION_LENGTH = 10

export function InteractionWarningModal({
  warning,
  onGoBack,
  onOverride,
}: InteractionWarningModalProps) {
  const [showJustification, setShowJustification] = useState(false)
  const [justification, setJustification] = useState('')
  const trimmed = justification.trim()
  const canConfirm = trimmed.length >= MIN_JUSTIFICATION_LENGTH

  return (
    <div className="iw-overlay" role="dialog" aria-modal="true" aria-labelledby="iw-title">
      <div className="iw-card">
        <div className="iw-icon-circle" aria-hidden="true">⚠︎</div>
        <h2 id="iw-title" className="iw-title">Drug Interaction Warning</h2>
        <p className="iw-description">{warning.description}</p>
        {warning.withMedicineNames.length > 0 && (
          <p className="iw-with">
            Interacts with: {warning.withMedicineNames.join(', ')}
          </p>
        )}

        {!showJustification ? (
          <>
            <button
              type="button"
              className="iw-button iw-button--primary"
              onClick={onGoBack}
              autoFocus
            >
              Go back
            </button>
            <button
              type="button"
              className="iw-button iw-button--secondary"
              onClick={() => setShowJustification(true)}
            >
              Override (admin logged)
            </button>
          </>
        ) : (
          <>
            <label
              className="iw-just-label"
              htmlFor="iw-justification"
            >
              Why is this override safe? (required — logged for audit)
            </label>
            <textarea
              id="iw-justification"
              className="iw-just-input"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="e.g. Doctor confirmed this combination is safe"
              rows={3}
              autoFocus
              aria-describedby="iw-just-hint"
            />
            <p id="iw-just-hint" className="iw-just-hint">
              {trimmed.length}/{MIN_JUSTIFICATION_LENGTH} minimum characters
            </p>
            <button
              type="button"
              className="iw-button iw-button--primary"
              onClick={() => onOverride(trimmed)}
              disabled={!canConfirm}
            >
              Confirm override
            </button>
            <button
              type="button"
              className="iw-button iw-button--secondary"
              onClick={() => {
                setShowJustification(false)
                setJustification('')
              }}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}
