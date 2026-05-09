import { MessageCircleQuestion } from 'lucide-react'

interface Props {
  onClick: () => void
}

// Floating action button that opens the Cabinet Query modal. Visibility is
// the parent's responsibility — this component is intentionally dumb: render
// it, and it shows. The parent gates on role + subscriptionTier + feature
// flag (see Dashboard.tsx).
export function CabinetQueryFAB({ onClick }: Props) {
  return (
    <button
      type="button"
      className="cb-query-fab"
      onClick={onClick}
      aria-label="Ask your cabinet"
    >
      <MessageCircleQuestion size={24} aria-hidden="true" />
    </button>
  )
}
