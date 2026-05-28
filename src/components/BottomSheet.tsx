import type { ReactNode } from 'react'

// AK-154 — Reusable bottom sheet, extracted from the RetroLogSheet pattern.
// Reuses the existing .bs-overlay / .bs-sheet / .bs-handle / .bs-section-title
// classes and the bs-rise / bs-fade animations already defined in App.css —
// no new CSS. Rises from the bottom; tap-outside (overlay click) dismisses,
// while clicks inside the sheet are contained.

interface BottomSheetProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  title?: string
}

export default function BottomSheet({ isOpen, onClose, children, title }: BottomSheetProps) {
  if (!isOpen) return null
  return (
    <div
      className="bs-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="bs-sheet" onClick={e => e.stopPropagation()}>
        <div className="bs-handle" aria-hidden="true" />
        {title && <h3 className="bs-section-title">{title}</h3>}
        {children}
      </div>
    </div>
  )
}
