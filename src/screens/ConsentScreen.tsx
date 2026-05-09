import { useEffect, useState } from 'react'
import { signOut } from 'firebase/auth'
import { ShieldCheck } from 'lucide-react'
import type { User } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { recordConsent } from '../services/firestoreService'
import { detectPlatform } from '../lib/platform'

interface Props {
  user: User
  policyUpdated?: boolean
  onConsented: () => void
}

export function ConsentScreen({ user, policyUpdated, onConsented }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState('')
  const [showPolicy, setShowPolicy] = useState(false)
  const [policyText, setPolicyText] = useState<string | null>(null)
  const [policyError, setPolicyError] = useState('')

  // Lazy-load the policy markdown the first time the user opens the modal.
  useEffect(() => {
    if (!showPolicy || policyText !== null) return
    let cancelled = false
    fetch('/privacy-policy.md')
      .then(r => {
        if (!r.ok) throw new Error('fetch failed')
        return r.text()
      })
      .then(text => { if (!cancelled) setPolicyText(text) })
      .catch(() => { if (!cancelled) setPolicyError('Could not load the policy. Try again.') })
    return () => { cancelled = true }
  }, [showPolicy, policyText])

  async function handleAgree() {
    if (submitting) return
    setError('')
    setSubmitting(true)
    try {
      await recordConsent(user.uid, detectPlatform())
      onConsented()
    } catch {
      setError('We could not save your consent. Check your connection and try again.')
      setSubmitting(false)
    }
  }

  return (
    <div className="cs-root">
      <header className="cs-header">
        <h1 className="cs-title">
          {policyUpdated ? 'Policy updated' : 'Before we start'}
        </h1>
        {policyUpdated && (
          <p className="cs-eyebrow">We updated our Privacy Policy. Please review and agree to continue.</p>
        )}
      </header>

      <main className="cs-body">
        <div className="cs-icon-wrap" aria-hidden="true">
          <ShieldCheck size={28} />
        </div>

        <p className="cs-lead">
          MediCab helps your household stay on top of medicines. Before you set up your account, here is what you should know.
        </p>

        <ul className="cs-list">
          <li>
            <strong>What we collect.</strong> Your medicines, dose history, and household membership — only what is needed to remind you and your family to take medicine on time.
          </li>
          <li>
            <strong>This is health data.</strong> Under India's Digital Personal Data Protection Act (DPDP), this is treated as sensitive personal information.
          </li>
          <li>
            <strong>Stored in India.</strong> Your data lives on Google Cloud servers in the Mumbai region (asia-south1).
          </li>
          <li>
            <strong>You stay in control.</strong> You can delete your account any time from Settings → Account &amp; Privacy. We give you a 30-day window to change your mind.
          </li>
        </ul>

        <button
          type="button"
          className="cs-policy-link"
          onClick={() => setShowPolicy(true)}
        >
          Read full Privacy Policy
        </button>

        {error && <p className="cs-error" role="alert">{error}</p>}

        <button
          type="button"
          className="cs-agree-btn"
          onClick={handleAgree}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'I agree and continue'}
        </button>

        <button
          type="button"
          className="cs-decline-link"
          onClick={() => signOut(auth)}
        >
          I do not agree → sign me out
        </button>
      </main>

      {showPolicy && (
        <div
          className="db-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cs-policy-title"
          onClick={() => setShowPolicy(false)}
        >
          <div className="db-modal cs-policy-modal" onClick={e => e.stopPropagation()}>
            <h3 id="cs-policy-title" className="db-modal-title">Privacy Policy</h3>
            <div className="cs-policy-body">
              {policyError
                ? <p className="cs-error" role="alert">{policyError}</p>
                : policyText === null
                  ? <div className="cb-spinner" role="status" aria-label="Loading" />
                  : <pre className="cs-policy-pre">{policyText}</pre>}
            </div>
            <button className="db-modal-close" onClick={() => setShowPolicy(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
