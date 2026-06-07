// Reimagined · Phase 1 — Sheet (bottom sheet).
//
// A modal panel that slides up from the bottom with a backdrop. Renders nothing
// when `open` is false. The backdrop and an optional close button both call
// onClose. Pure presentation — the parent owns the open state.
//
// (Distinct from the existing src/components/BottomSheet.tsx, which is wired to
// app-specific flows; this is the token-driven Reimagined primitive.)

import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Icon } from './Icon'

export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  className?: string
}

export function Sheet({ open, onClose, title, children, className }: SheetProps) {
  if (!open) return null

  return (
    <div
      className="rmg-sheet-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17, 24, 39, 0.45)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        className={['rmg-sheet', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Dialog'}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 'var(--max-w-md, 28rem)',
          background: 'var(--surface, #ffffff)',
          borderTopLeftRadius: 'var(--radius-card, 24px)',
          borderTopRightRadius: 'var(--radius-card, 24px)',
          padding: 16,
          boxShadow: 'var(--shadow-float, 0 8px 28px rgba(16,100,112,0.18))',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        {/* Grab handle */}
        <div
          aria-hidden
          style={{
            width: 36,
            height: 4,
            borderRadius: 'var(--radius-pill, 9999px)',
            background: 'var(--gray-300, #D1D5DB)',
            margin: '0 auto 12px',
          }}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: title ? 12 : 0,
          }}
        >
          {title && (
            <h2
              className="rmg-sheet-title"
              style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-h, #111827)' }}
            >
              {title}
            </h2>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rmg-sheet-close"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 'var(--radius-pill, 9999px)',
              background: 'var(--gray-100, #F3F4F6)',
              color: 'var(--text, #374151)',
            }}
          >
            <Icon icon={X} size={18} />
          </button>
        </div>

        <div className="rmg-sheet-body">{children}</div>
      </div>
    </div>
  )
}
