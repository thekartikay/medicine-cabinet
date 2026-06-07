// AK-192 — Reimagined Phase-1 shared component library.
//
// These are pure-presentation components (props in, UI out), so they're tested
// by rendering to static HTML and asserting on structure/text/aria, plus direct
// unit tests of the exported pure helpers. renderToStaticMarkup runs in the
// repo's existing node test environment — no jsdom/RTL setup required, which
// keeps the emulator-oriented vitest config untouched.

import { renderToStaticMarkup } from 'react-dom/server'
import { Home, Pill as PillIcon, Settings } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import {
  Avatar,
  BottomNav,
  Header,
  Icon,
  MedicineCard,
  Pill,
  Sheet,
  StatusPill,
  SupplyLine,
  Toast,
  initials,
  pillToneStyle,
  statusMeta,
  supplyPct,
  supplyTone,
} from '../../src/components/reimagined'

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('Icon', () => {
  it('is decorative (aria-hidden) without a label', () => {
    const out = html(<Icon icon={PillIcon} />)
    expect(out).toContain('aria-hidden="true"')
    expect(out).toContain('<svg')
  })

  it('exposes an accessible name when labelled', () => {
    const out = html(<Icon icon={PillIcon} label="medicine" />)
    expect(out).toContain('role="img"')
    expect(out).toContain('aria-label="medicine"')
    expect(out).not.toContain('aria-hidden')
  })
})

describe('Pill', () => {
  it('renders its children and the base class', () => {
    const out = html(<Pill>Beta</Pill>)
    expect(out).toContain('Beta')
    expect(out).toContain('rmg-pill')
  })

  it('pillToneStyle maps tones to token-backed colours', () => {
    expect(pillToneStyle('success').background).toContain('--success')
    expect(pillToneStyle('warning').background).toContain('--warning')
    expect(pillToneStyle('danger').background).toContain('--danger')
    expect(pillToneStyle('brand').background).toContain('--robin')
    expect(pillToneStyle('neutral').color).toContain('--gray-700')
  })
})

describe('StatusPill', () => {
  it('statusMeta maps every status to a label + tone', () => {
    expect(statusMeta('taken')).toEqual({ label: 'Taken', tone: 'success' })
    expect(statusMeta('missed')).toEqual({ label: 'Missed', tone: 'danger' })
    expect(statusMeta('skipped')).toEqual({ label: 'Skipped', tone: 'warning' })
    expect(statusMeta('pending')).toEqual({ label: 'Pending', tone: 'neutral' })
  })

  it('renders the status label', () => {
    expect(html(<StatusPill status="missed" />)).toContain('Missed')
  })
})

describe('Avatar', () => {
  it('initials uses first + last word, single names, and empty input', () => {
    expect(initials('Rajan Kumar')).toBe('RK')
    expect(initials('Priya')).toBe('P')
    expect(initials('  amma  appa ')).toBe('AA')
    expect(initials('')).toBe('')
  })

  it('renders initials with an accessible name when no image', () => {
    const out = html(<Avatar name="Rajan Kumar" />)
    expect(out).toContain('RK')
    expect(out).toContain('role="img"')
    expect(out).toContain('aria-label="Rajan Kumar"')
  })

  it('renders an <img> with alt when src is given', () => {
    const out = html(<Avatar name="Rajan" src="https://example.com/a.png" />)
    expect(out).toContain('<img')
    expect(out).toContain('alt="Rajan"')
  })
})

describe('SupplyLine', () => {
  it('supplyPct is proportional and clamped to [0,100]', () => {
    expect(supplyPct(15, 30)).toBe(50)
    expect(supplyPct(60, 30)).toBe(100)
    expect(supplyPct(-5, 30)).toBe(0)
    expect(supplyPct(10, 0)).toBe(0)
  })

  it('supplyTone escalates danger → warning → success', () => {
    expect(supplyTone(2)).toBe('danger')
    expect(supplyTone(5)).toBe('warning')
    expect(supplyTone(20)).toBe('success')
  })

  it('renders an accessible progressbar', () => {
    const out = html(<SupplyLine daysLeft={15} fullDays={30} />)
    expect(out).toContain('role="progressbar"')
    expect(out).toContain('aria-valuenow="50"')
  })
})

describe('MedicineCard', () => {
  it('renders name, descriptor, status and supply bar', () => {
    const out = html(
      <MedicineCard name="Crocin" strength="500 mg" form="Tablet" status="taken" daysLeft={10} />,
    )
    expect(out).toContain('Crocin')
    expect(out).toContain('500 mg · Tablet')
    expect(out).toContain('Taken')
    expect(out).toContain('role="progressbar"')
  })

  it('renders a <button> when interactive', () => {
    const out = html(<MedicineCard name="Crocin" onClick={() => {}} />)
    expect(out).toContain('<button')
  })

  it('renders a non-button container when not interactive', () => {
    const out = html(<MedicineCard name="Crocin" />)
    expect(out).not.toContain('<button')
  })
})

describe('Header', () => {
  it('renders the title', () => {
    expect(html(<Header title="Cabinet" />)).toContain('Cabinet')
  })

  it('shows a back button only when onBack is given', () => {
    expect(html(<Header title="Cabinet" onBack={() => {}} />)).toContain('aria-label="Back"')
    expect(html(<Header title="Cabinet" />)).not.toContain('aria-label="Back"')
  })
})

describe('BottomNav', () => {
  const items = [
    { key: 'home', label: 'Home', icon: Home },
    { key: 'settings', label: 'Settings', icon: Settings },
  ]

  it('marks the active item with aria-current', () => {
    const out = html(<BottomNav items={items} activeKey="home" onNavigate={() => {}} />)
    expect(out).toContain('Home')
    expect(out).toContain('Settings')
    expect(out).toContain('aria-current="page"')
  })
})

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    expect(html(<Sheet open={false} onClose={() => {}}>body</Sheet>)).toBe('')
  })

  it('renders a dialog with title, body and close button when open', () => {
    const out = html(
      <Sheet open onClose={() => {}} title="Add medicine">
        sheet body
      </Sheet>,
    )
    expect(out).toContain('role="dialog"')
    expect(out).toContain('aria-modal="true"')
    expect(out).toContain('Add medicine')
    expect(out).toContain('sheet body')
    expect(out).toContain('aria-label="Close"')
  })

  it('always exposes an accessible name, falling back when title is omitted', () => {
    const out = html(
      <Sheet open onClose={() => {}}>
        body
      </Sheet>,
    )
    expect(out).toContain('role="dialog"')
    expect(out).toContain('aria-label="Dialog"')
  })
})

describe('Toast', () => {
  it('renders nothing when closed', () => {
    expect(html(<Toast message="hi" open={false} />)).toBe('')
  })

  it('renders the message with a polite live region', () => {
    const out = html(<Toast message="Dose logged" tone="success" />)
    expect(out).toContain('Dose logged')
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-live="polite"')
    expect(out).toContain('rmg-toast--success')
  })

  it('shows a dismiss button only with onDismiss', () => {
    expect(html(<Toast message="x" onDismiss={() => {}} />)).toContain('aria-label="Dismiss"')
    expect(html(<Toast message="x" />)).not.toContain('aria-label="Dismiss"')
  })
})
