import { useEffect, useRef, useState } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { askCabinet } from '../services/geminiService'
import type {
  GeminiProxyResponse,
  RefusalType,
} from '../types/geminiProxy'

interface Props {
  open: boolean
  onClose: () => void
  hId: string
  cId: string
}

// Maps proxy error codes to user-friendly copy. Anything not listed falls
// through to the generic message at the end.
function errorMessageFor(code: string): string {
  switch (code) {
    case 'functions/unauthenticated':
      return 'Please sign in again to continue.'
    case 'functions/permission-denied':
      return "You don't have access to this cabinet."
    case 'functions/invalid-argument':
      return 'Something went wrong with that question. Please try rephrasing it.'
    case 'network_error':
      return "Couldn't reach MediCab. Check your connection."
    case 'gemini_api_error':
      return 'The assistant is temporarily unavailable. Please try again in a moment.'
    case 'parse_failure':
      return 'The assistant gave an unclear response. Please try rephrasing your question.'
    default:
      // hallucination_detected and any other code fall here. cabinet_query
      // soft-checks make this reachable in theory; the user shouldn't see
      // the technical reason.
      return 'Something unexpected happened. Please try a different question.'
  }
}

const REFUSAL_HEADLINE: Record<RefusalType, string> = {
  EMERGENCY_REFUSAL:    'Call 112 immediately. Do not wait.',
  DIAGNOSTIC_REFUSAL:   "MediCab can't recommend what to take. Please consult your doctor or pharmacist.",
  LOW_CONFIDENCE_REFUSAL: "We don't have enough information to answer this safely. Please ask your doctor or pharmacist.",
}

export function CabinetQueryModal({ open, onClose, hId, cId }: Props) {
  const [input, setInput] = useState('')
  // The actual question that produced the current result. Kept separate from
  // `input` so the typed query stays visible above the response and the
  // retry button can re-submit the exact same string.
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GeminiProxyResponse | null>(null)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset everything when the modal closes so the next open is fresh.
  useEffect(() => {
    if (!open) {
      setInput('')
      setSubmittedQuery('')
      setResult(null)
      setLoading(false)
    }
  }, [open])

  // Focus management: on open, move focus into the dialog (the close button
  // is a safe initial target since it's always present). Trap focus while
  // the modal is open. Esc closes.
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeBtnRef.current?.focus()

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previouslyFocused?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  async function runQuery(q: string) {
    setLoading(true)
    setResult(null)
    setSubmittedQuery(q)
    const r = await askCabinet(q, hId, cId)
    setResult(r)
    setLoading(false)
  }

  function handleSend() {
    const q = input.trim()
    if (!q || loading) return
    void runQuery(q)
  }

  function handleRetry() {
    if (!submittedQuery || loading) return
    void runQuery(submittedQuery)
  }

  function handleNewQuestion() {
    setInput('')
    setSubmittedQuery('')
    setResult(null)
    inputRef.current?.focus()
  }

  return (
    <div
      className="cb-query-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="cb-query-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cb-query-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header */}
        <div className="cb-query-header">
          <h2 id="cb-query-title" className="cb-query-title">Ask your cabinet</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="cb-query-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="cb-query-body">
          {/* Submitted-question echo, only after a question has been asked */}
          {submittedQuery && (
            <p className="cb-query-asked">
              <span className="cb-query-asked-label">You asked:</span> {submittedQuery}
            </p>
          )}

          {/* Result area — aria-live so screen readers announce updates */}
          <div className="cb-query-result" aria-live="polite">
            {loading && (
              <div className="cb-query-loading" role="status">
                <span className="cb-spinner" aria-hidden="true" />
                <span>Looking through your cabinet…</span>
              </div>
            )}

            {!loading && result && renderResult(result, handleRetry)}
          </div>

          {/* New-question button only shown after a result */}
          {!loading && result && (
            <button
              type="button"
              className="cb-query-new"
              onClick={handleNewQuestion}
            >
              Ask another question
            </button>
          )}
        </div>

        {/* Input row (always present, disabled while loading) */}
        <form
          className="cb-query-input-row"
          onSubmit={(e) => { e.preventDefault(); handleSend() }}
        >
          <input
            ref={inputRef}
            type="text"
            className="cb-query-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about a medicine in your cabinet"
            disabled={loading}
            autoComplete="off"
          />
          <button
            type="submit"
            className="cb-query-send"
            aria-label="Send question"
            disabled={loading || input.trim().length === 0}
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </form>

        {/* Always-on disclaimer */}
        <p className="cb-query-disclaimer">
          This is information about medicines, not medical advice. Consult your doctor or pharmacist before making any treatment decision.
        </p>
      </div>
    </div>
  )
}

// Renders the result card based on the discriminated `kind`. Pulled out as a
// helper to keep the main component tree readable.
function renderResult(result: GeminiProxyResponse, onRetry: () => void) {
  if (result.kind === 'answer') {
    const isMedium = result.confidence === 'medium'
    return (
      <div className={`cb-query-card${isMedium ? ' cb-query-card--medium' : ''}`}>
        <span className="cb-query-card-label">
          {isMedium ? 'Check with pharmacist' : 'Cabinet info'}
        </span>
        <p className="cb-query-card-text">{result.text}</p>
      </div>
    )
  }

  if (result.kind === 'refusal') {
    if (result.refusalType === 'EMERGENCY_REFUSAL') {
      return (
        <div className="cb-query-card cb-query-card--emergency">
          <p className="cb-query-card-text cb-query-card-text--emergency">
            {REFUSAL_HEADLINE.EMERGENCY_REFUSAL}
          </p>
          <a
            className="cb-query-emergency-call"
            href="tel:112"
            aria-label="Call 112 emergency number"
          >
            Call 112 now
          </a>
        </div>
      )
    }
    return (
      <div className="cb-query-card">
        <p className="cb-query-card-text">{REFUSAL_HEADLINE[result.refusalType]}</p>
      </div>
    )
  }

  if (result.kind === 'rate_limited') {
    return (
      <div className="cb-query-card">
        <p className="cb-query-card-text">
          You've used today's 3 free queries. Upgrade to Family for unlimited.
        </p>
      </div>
    )
  }

  // result.kind === 'error'
  return (
    <div className="cb-query-card">
      <p className="cb-query-card-text">{errorMessageFor(result.message)}</p>
      <button
        type="button"
        className="cb-query-retry"
        onClick={onRetry}
      >
        Try again
      </button>
    </div>
  )
}
