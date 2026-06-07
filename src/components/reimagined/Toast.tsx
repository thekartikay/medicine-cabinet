// Reimagined · Phase 1 — Toast (transient message).
//
// A single message bar coloured by tone, with an optional dismiss button.
// Renders nothing when `open` is false. Announces itself politely to screen
// readers. Pure presentation — the parent owns visibility and dismissal.

import { X } from 'lucide-react'
import { Icon } from './Icon'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastProps {
  message: string
  tone?: ToastTone
  /** When false, nothing renders. Defaults to true. */
  open?: boolean
  onDismiss?: () => void
  className?: string
}

const TONE_BG: Record<ToastTone, string> = {
  info: 'var(--blueberry, #106470)',
  success: 'var(--success, #639922)',
  warning: 'var(--warning, #EF9F27)',
  danger: 'var(--danger, #E24B4A)',
}

export function Toast({ message, tone = 'info', open = true, onDismiss, className }: ToastProps) {
  if (!open) return null

  return (
    <div
      className={['rmg-toast', `rmg-toast--${tone}`, className].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 'var(--radius-card, 24px)',
        background: TONE_BG[tone],
        color: '#ffffff',
        boxShadow: 'var(--shadow-float, 0 8px 28px rgba(16,100,112,0.18))',
        maxWidth: 'var(--max-w-md, 28rem)',
      }}
    >
      <span className="rmg-toast-message" style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>
        {message}
      </span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rmg-toast-dismiss"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            color: '#ffffff',
            flexShrink: 0,
          }}
        >
          <Icon icon={X} size={18} />
        </button>
      )}
    </div>
  )
}
