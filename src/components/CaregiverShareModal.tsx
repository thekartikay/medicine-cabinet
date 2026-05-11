import { useEffect, useRef, useState } from 'react'
import { FirebaseError } from 'firebase/app'
import { createCaregiverGrantFn } from '../services/caregiverGrantsCalls'

interface Props {
  memberId: string
  memberName: string
  adminName: string
  onClose: () => void
  // Called after a successful grant creation so the parent can refresh the
  // grant list. The modal stays open in success state until the user dismisses.
  onCreated: () => void
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.(com|org|net|in|co|io|dev|app|edu|gov|info|uk|us|me|ai)$/i
const E164_RE = /^\+[1-9]\d{1,14}$/

function buildWhatsAppMessage(adminName: string, memberName: string, magicLink: string): string {
  return (
`Hi! ${adminName} has invited you to view ${memberName}'s medications on MediCab.

Tap this link to see today's doses (the link works once):
${magicLink}

Please don't forward this link — it's just for you.`
  )
}

// Builds a wa.me URL. If the contact looks like a phone (E.164), include the
// phone parameter so WhatsApp opens directly to that contact; otherwise omit
// it so the user picks the recipient from their contact list.
function buildWhatsAppUrl(contact: string, message: string): string {
  const encoded = encodeURIComponent(message)
  if (E164_RE.test(contact)) {
    const digits = contact.replace(/[^0-9]/g, '')
    return `https://wa.me/${digits}?text=${encoded}`
  }
  return `https://wa.me/?text=${encoded}`
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path (some webviews reject writeText
      // even though the API exists).
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

type ModalState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; magicLink: string; contact: string }
  | { kind: 'error'; message: string; canRetry: boolean }

// Maps HttpsError codes to user-facing copy. Anything not listed falls
// through to the verbatim message from the Cloud Function (which itself
// defaults to a generic string for `internal`).
function errorFor(err: unknown): { message: string; canRetry: boolean } {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'functions/permission-denied':
        return { message: "You don't have permission to share this member.", canRetry: false }
      case 'functions/not-found':
        return { message: 'This member no longer exists. Refresh the page and try again.', canRetry: false }
      case 'functions/invalid-argument':
        return { message: 'Please enter a valid email or phone number.', canRetry: true }
      case 'functions/unauthenticated':
        return { message: 'Please sign in again to continue.', canRetry: false }
      case 'functions/unavailable':
      case 'functions/deadline-exceeded':
        return { message: "Couldn't reach the server. Check your connection and try again.", canRetry: true }
      default:
        return { message: err.message || 'Something went wrong. Please try again.', canRetry: true }
    }
  }
  return { message: "Couldn't reach the server. Check your connection and try again.", canRetry: true }
}

// AK-58 sub-task 2 — bottom-sheet modal that issues a per-member caregiver
// grant. State machine: idle → loading → (success | error). Esc closes when
// not loading. WhatsApp + clipboard wiring lands in Step 4.
export function CaregiverShareModal({ memberId, memberName, adminName, onClose, onCreated }: Props) {
  const [contact, setContact] = useState('')
  const [touched, setTouched] = useState(false)
  const [state, setState] = useState<ModalState>({ kind: 'idle' })
  const [copyLabel, setCopyLabel] = useState<'idle' | 'copied' | 'failed'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = contact.trim()
  const isValid = EMAIL_RE.test(trimmed) || E164_RE.test(trimmed)
  const showInputError = touched && trimmed.length > 0 && !isValid

  // Focus the input on mount (idle state). Esc closes the modal at any time
  // unless we're mid-call.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && state.kind !== 'loading') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, state.kind])

  async function handleGenerate() {
    if (!isValid || state.kind === 'loading') return
    setState({ kind: 'loading' })
    try {
      const result = await createCaregiverGrantFn({
        memberId,
        contactEmailOrPhone: trimmed,
      })
      const { magicLink } = result.data
      setState({ kind: 'success', magicLink, contact: trimmed })
      onCreated()
    } catch (err) {
      // Never log the magicLink or grantSecret. Only surface the error itself.
      // eslint-disable-next-line no-console
      console.error('createCaregiverGrant failed:', err)
      const { message, canRetry } = errorFor(err)
      setState({ kind: 'error', message, canRetry })
    }
  }

  function handleTryAgain() {
    setState({ kind: 'idle' })
  }

  function handleShareWhatsApp(magicLink: string, contact: string) {
    const message = buildWhatsAppMessage(adminName, memberName, magicLink)
    const url = buildWhatsAppUrl(contact, message)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function handleCopy(magicLink: string) {
    const ok = await copyToClipboard(magicLink)
    setCopyLabel(ok ? 'copied' : 'failed')
    setTimeout(() => setCopyLabel('idle'), 2000)
  }

  return (
    <div
      className="db-modal-overlay"
      onClick={() => { if (state.kind !== 'loading') onClose() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cg-share-title"
    >
      <div
        className="db-modal cg-modal"
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          className="cg-modal-x"
          aria-label="Close"
          disabled={state.kind === 'loading'}
          onClick={() => { if (state.kind !== 'loading') onClose() }}
        >
          ×
        </button>
        {state.kind === 'idle' && (
          <>
            <h3 id="cg-share-title" className="db-modal-title">Share with a caregiver</h3>
            <p className="db-modal-sub">
              They'll see today's doses for {memberName}, in real time.
            </p>

            <label className="cg-modal-label" htmlFor="cg-share-contact">
              Email or phone number
            </label>
            <input
              ref={inputRef}
              id="cg-share-contact"
              className={`cg-modal-input${showInputError ? ' cg-modal-input--error' : ''}`}
              type="text"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="caregiver@example.com or +91 98765 43210"
              value={contact}
              onChange={e => setContact(e.target.value)}
              onBlur={() => setTouched(true)}
            />
            {showInputError && (
              <p className="cg-modal-error" role="alert">
                Enter a valid email or phone number in international format
                (e.g. +91 98765 43210).
              </p>
            )}
            <p className="cg-modal-help">
              Their email or phone in international format. They don't need a
              MediCab account.
            </p>

            <button
              type="button"
              className="cg-modal-primary"
              disabled={!isValid}
              onClick={handleGenerate}
            >
              Generate link
            </button>
            <button
              type="button"
              className="cg-modal-cancel"
              onClick={onClose}
            >
              Cancel
            </button>
          </>
        )}

        {state.kind === 'loading' && (
          <>
            <h3 id="cg-share-title" className="db-modal-title">Generating secure link…</h3>
            <div className="cg-modal-loading" role="status" aria-live="polite">
              <span className="cb-spinner" aria-hidden="true" />
            </div>
          </>
        )}

        {state.kind === 'success' && (
          <>
            <h3 id="cg-share-title" className="db-modal-title">
              Share with {state.contact}
            </h3>
            <input
              className="cg-modal-link-field"
              type="text"
              readOnly
              value={state.magicLink}
              onFocus={e => e.currentTarget.select()}
              aria-label="Magic link"
            />

            <button
              type="button"
              className="cg-modal-primary"
              onClick={() => handleShareWhatsApp(state.magicLink, state.contact)}
            >
              Share via WhatsApp
            </button>
            <button
              type="button"
              className="cg-modal-secondary"
              onClick={() => handleCopy(state.magicLink)}
            >
              {copyLabel === 'copied' ? '✓ Copied' :
               copyLabel === 'failed' ? 'Copy failed — long-press the link' :
               'Copy link'}
            </button>

            <p className="cg-modal-help">
              This link works <strong>once</strong>. If they lose it, revoke
              this grant and create a new one.
            </p>
            <button
              type="button"
              className="cg-modal-cancel"
              onClick={onClose}
            >
              Done
            </button>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <h3 id="cg-share-title" className="db-modal-title">
              Couldn't generate the link
            </h3>
            <p className="cg-modal-error" role="alert">{state.message}</p>
            {state.canRetry && (
              <button
                type="button"
                className="cg-modal-primary"
                onClick={handleTryAgain}
              >
                Try again
              </button>
            )}
            <button
              type="button"
              className="cg-modal-cancel"
              onClick={onClose}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  )
}
