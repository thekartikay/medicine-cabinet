// AK-193 — Reimagined navigation shell.
//
// Pure navigation structure (no data, no providers), so it's verified by
// rendering to static HTML and asserting the shell scaffolding: brand, the four
// tabs, the default screen, and the top-bar controls. renderToStaticMarkup runs
// in the repo's node test env. Interactive behaviour (tab switching, opening the
// notification sheet) is event-driven and not covered by static rendering.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ReimaginedApp } from '../../src/screens/reimagined/ReimaginedApp'
import { CabinetScreen } from '../../src/screens/reimagined/CabinetScreen'
import { DigestScreen } from '../../src/screens/reimagined/DigestScreen'
import { RestockScreen } from '../../src/screens/reimagined/RestockScreen'

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('ReimaginedApp shell', () => {
  const out = html(<ReimaginedApp />)

  it('renders the MediCab brand in the top bar', () => {
    expect(out).toContain('MediCab')
  })

  it('renders all four tab labels in the bottom nav', () => {
    for (const label of ['People', 'Cabinet', 'Digest', 'Restock']) {
      expect(out).toContain(label)
    }
  })

  it('defaults to the People tab (active + its screen)', () => {
    expect(out).toContain('aria-current="page"')
    // AK-196 — the People tab now renders MyPeople. Under the provider's initial
    // (pre-auth) state it shows the loading skeleton rather than a placeholder.
    expect(out).toContain('aria-label="Loading people"')
  })

  it('exposes the notification bell and a profile avatar', () => {
    expect(out).toContain('aria-label="Notifications"')
    expect(out).toContain('aria-label="Priya"') // Avatar accessible name
  })

  it('keeps the notification sheet closed initially', () => {
    // Sheet renders null when closed, so its body copy must be absent.
    expect(out).not.toContain("You're all caught up")
    expect(out).not.toContain('role="dialog"')
  })
})

describe('placeholder screens (Cabinet/Digest/Restock)', () => {
  it.each([
    [CabinetScreen, 'Cabinet', 'Every medicine in one place.'],
    [DigestScreen, 'Digest', 'Today at a glance.'],
    [RestockScreen, 'Restock', 'What to reorder.'],
  ])('%o renders its title and subtitle', (Screen, title, subtitle) => {
    const out = html(<Screen />)
    expect(out).toContain(title)
    expect(out).toContain(subtitle)
    expect(out).toContain('Coming soon')
  })
})
