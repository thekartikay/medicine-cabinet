// Reimagined · Phase 1 — navigation shell (AK-193).
//
// The four-tab structure Priya's app hangs off: People (who she cares for),
// Cabinet (every medicine), Digest (today at a glance), Restock (what to
// reorder). Top bar carries the MediCab brand + a notification bell + the
// profile avatar; the bell opens a slide-up notification Sheet.
//
// This is a self-contained navigation structure: tab switching is local state
// (no router/Context provider), and there is NO data fetching, NO Firestore,
// NO context — placeholder screens only. It is mounted as its own tree at
// /reimagined (see main.tsx), so the existing app at / is untouched and this
// shell never enters App's auth/consent pipeline.

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bell, ClipboardList, Package, ShoppingCart, Users } from 'lucide-react'
import { Avatar, BottomNav, Header, Icon, Sheet, type BottomNavItem } from '../../components/reimagined'
import { ReimaginedProvider } from '../../contexts/ReimaginedCtx'
import { PeopleScreen } from './PeopleScreen'
import { CabinetScreen } from './CabinetScreen'
import { DigestScreen } from './DigestScreen'
import { RestockScreen } from './RestockScreen'

type TabKey = 'people' | 'cabinet' | 'digest' | 'restock'

const NAV_ITEMS: (BottomNavItem & { key: TabKey })[] = [
  { key: 'people', label: 'People', icon: Users },
  { key: 'cabinet', label: 'Cabinet', icon: Package },
  { key: 'digest', label: 'Digest', icon: ClipboardList },
  { key: 'restock', label: 'Restock', icon: ShoppingCart },
]

const SCREENS: Record<TabKey, () => ReactElement> = {
  people: PeopleScreen,
  cabinet: CabinetScreen,
  digest: DigestScreen,
  restock: RestockScreen,
}

const TAB_KEYS = NAV_ITEMS.map((t) => t.key)

function isTabKey(value: string): value is TabKey {
  return (TAB_KEYS as string[]).includes(value)
}

// Small round icon button for the top-bar bell. Inline so the shell stays
// self-contained; styling references the Phase-1 tokens.
function IconButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 36,
        borderRadius: 'var(--radius-pill, 9999px)',
        background: 'var(--gray-100, #F3F4F6)',
        color: 'var(--text, #374151)',
      }}
    >
      <Icon icon={icon} size={20} />
    </button>
  )
}

export function ReimaginedApp() {
  const [tab, setTab] = useState<TabKey>('people')
  const [notifOpen, setNotifOpen] = useState(false)

  const ActiveScreen = SCREENS[tab]

  return (
    <ReimaginedProvider>
    <div
      className="rmg-app"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100svh',
        maxWidth: 'var(--max-w-md, 28rem)',
        margin: '0 auto',
        background: 'var(--bg, #F9FAFB)',
      }}
    >
      <Header
        title="MediCab"
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconButton icon={Bell} label="Notifications" onClick={() => setNotifOpen(true)} />
            <Avatar name="Priya" size={32} />
          </div>
        }
      />

      <main style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <ActiveScreen />
      </main>

      <BottomNav
        items={NAV_ITEMS}
        activeKey={tab}
        onNavigate={(key) => {
          if (isTabKey(key)) setTab(key)
        }}
      />

      <Sheet open={notifOpen} onClose={() => setNotifOpen(false)} title="Notifications">
        <p style={{ fontSize: 14, color: 'var(--text-muted, #6B7280)' }}>
          You're all caught up — no notifications yet.
        </p>
      </Sheet>
    </div>
    </ReimaginedProvider>
  )
}
