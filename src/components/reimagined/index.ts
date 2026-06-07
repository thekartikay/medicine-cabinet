// Reimagined · Phase 1 — shared component library (AK-192).
//
// Pure-presentation building blocks consumed by every Reimagined screen.
// Props in, UI out — no Firestore, no context, no data wiring. Styling is
// driven by the Phase-1 design tokens (AK-191) via CSS custom properties,
// each with a literal fallback so a component renders correctly in isolation.

// Pure helpers + shared types.
export {
  pillToneStyle,
  statusMeta,
  initials,
  supplyPct,
  supplyTone,
  type PillTone,
  type DoseStatus,
  type StatusMeta,
  type SupplyTone,
} from './helpers'

// Components.
export { Icon, type IconProps } from './Icon'
export { Pill, type PillProps } from './Pill'
export { StatusPill, type StatusPillProps } from './StatusPill'
export { Avatar, type AvatarProps } from './Avatar'
export { SupplyLine, type SupplyLineProps } from './SupplyLine'
export { MedicineCard, type MedicineCardProps } from './MedicineCard'
export { Header, type HeaderProps } from './Header'
export { BottomNav, type BottomNavItem, type BottomNavProps } from './BottomNav'
export { Sheet, type SheetProps } from './Sheet'
export { Toast, type ToastProps, type ToastTone } from './Toast'
