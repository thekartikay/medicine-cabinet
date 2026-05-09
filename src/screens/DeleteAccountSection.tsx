import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { Trash2 } from 'lucide-react'
import { functions } from '../lib/firebase'

interface Props {
  onDeleted: () => void
}

type Step = 'closed' | 'warn' | 'confirm'

// Shared "Delete my account" entry point used by both SettingsTab and
// MemberSettings. Two-step modal: a warning, then a typed-confirmation gate
// before the actual Cloud Function call goes out. Once the function returns,
// we hand off to the parent (Dashboard → App.tsx) so it can route to the
// "deletion scheduled" screen and sign the user out.
export function DeleteAccountSection({ onDeleted }: Props) {
  const [step, setStep] = useState<Step>('closed')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function close() {
    if (busy) return
    setStep('closed')
    setTyped('')
    setError('')
  }

  async function handleConfirm() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await httpsCallable(functions, 'deleteAccount')({
        confirmation: 'DELETE_MY_ACCOUNT',
      })
      onDeleted()
    } catch {
      setError('Could not delete your account. Please check your connection and try again.')
      setBusy(false)
    }
  }

  return (
    <section className="db-card st-card">
      <h3 className="st-section-title">Account &amp; Privacy</h3>
      <button
        type="button"
        className="st-danger-row"
        onClick={() => setStep('warn')}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Trash2 size={16} />
          <span>Delete my account</span>
        </span>
        <span className="st-row-chev" aria-hidden="true">›</span>
      </button>

      {step !== 'closed' && (
        <div
          className="db-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="st-delete-title"
          onClick={close}
        >
          <div className="db-modal st-danger-modal" onClick={e => e.stopPropagation()}>
            <h3 id="st-delete-title" className="db-modal-title">
              {step === 'warn' ? 'Delete your account?' : 'Last step'}
            </h3>

            {step === 'warn' ? (
              <p className="st-danger-warn">
                We will start a 30-day deletion of your MediCab account. During that time you can sign in to recover everything. After 30 days your medicines, dose history, and AI query logs will be permanently removed.
              </p>
            ) : (
              <>
                <p className="st-danger-warn">
                  Type <strong>DELETE</strong> below to confirm. This cannot be undone after the 30-day window.
                </p>
                <input
                  type="text"
                  className="st-danger-input"
                  value={typed}
                  onChange={e => setTyped(e.target.value)}
                  placeholder="DELETE"
                  autoComplete="off"
                  autoCapitalize="characters"
                  disabled={busy}
                />
                {error && <p className="cs-error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
              </>
            )}

            <div className="st-danger-actions">
              <button
                type="button"
                className="st-danger-btn-cancel"
                onClick={close}
                disabled={busy}
              >
                Cancel
              </button>
              {step === 'warn' ? (
                <button
                  type="button"
                  className="st-danger-btn-confirm"
                  onClick={() => setStep('confirm')}
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  className="st-danger-btn-confirm"
                  onClick={handleConfirm}
                  disabled={busy || typed !== 'DELETE'}
                >
                  {busy ? 'Deleting…' : 'Delete my account'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
