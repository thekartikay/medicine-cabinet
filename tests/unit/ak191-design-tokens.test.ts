// AK-191 — Reimagined design-system tokens.
//
// AK-191 is a pure design-token/config ticket (no component or runtime logic),
// so this guards the *source of truth* directly: it reads src/index.css and
// index.html as text and asserts the Reimagined palette is reconciled, the
// semantic aliases + layout invariants exist, and DM Sans is loaded at the
// weights the ticket calls for. jsdom's getComputedStyle doesn't resolve CSS
// custom properties reliably, so a text-level assertion is the deterministic
// way to lock these values in.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const css = readFileSync(resolve(root, 'src/index.css'), 'utf8')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')

// Matches `--name: VALUE;` allowing arbitrary inner whitespace, value captured
// up to the first `;` and trimmed. Returns null when the token is absent.
function tokenValue(name: string): string | null {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

describe('AK-191 Reimagined palette (reconciled token values)', () => {
  const expected: Record<string, string> = {
    robin: '#5DC1C8',     // Reimagined Robin (already on-spec)
    blueberry: '#106470', // Reimagined Blueberry (already on-spec)
    sprout: '#639922',    // Reimagined Success green (was #5AB648)
    sunshine: '#EF9F27',  // Reimagined Warning amber (was #FFB800)
    daybreak: '#E24B4A',  // Reimagined Danger red (was #FF8985)
  }

  for (const [name, hex] of Object.entries(expected)) {
    it(`--${name} resolves to ${hex}`, () => {
      const value = tokenValue(name)
      expect(value, `--${name} should be declared in src/index.css`).not.toBeNull()
      expect(value!.toUpperCase()).toBe(hex.toUpperCase())
    })
  }

  it('does not retain the pre-Reimagined hex values as active declarations', () => {
    // Strip /* ... */ comments first — the reconciled tokens keep a `(was
    // #XXXXXX)` provenance note, and that historical reference is intentional;
    // what must not survive is a stale value used as a live declaration.
    const active = css.replace(/\/\*[\s\S]*?\*\//g, '').toUpperCase()
    for (const stale of ['#5AB648', '#FFB800', '#FF8985']) {
      expect(active).not.toContain(stale.toUpperCase())
    }
  })
})

describe('AK-191 semantic aliases', () => {
  it.each([
    ['success', 'sprout'],
    ['warning', 'sunshine'],
    ['danger', 'daybreak'],
  ])('--%s aliases var(--%s)', (alias, base) => {
    expect(tokenValue(alias)).toBe(`var(--${base})`)
  })

  it('--error maps to the danger red (var(--daybreak))', () => {
    expect(tokenValue('error')).toBe('var(--daybreak)')
  })
})

describe('AK-191 layout invariants (kept)', () => {
  it('cards use a 24px radius token', () => {
    expect(tokenValue('radius-card')).toBe('24px')
  })

  it('inputs/buttons use a pill (9999px) radius token', () => {
    expect(tokenValue('radius-pill')).toBe('9999px')
  })

  it('exposes a mobile-first centered max-width token', () => {
    expect(tokenValue('max-w-md')).not.toBeNull()
  })
})

describe('AK-191 DM Sans', () => {
  it('--sans declares DM Sans as the primary family', () => {
    const sans = tokenValue('sans')
    expect(sans).not.toBeNull()
    expect(sans!).toMatch(/^'DM Sans'/)
  })

  it('index.html loads DM Sans at weights 400/500/600/700', () => {
    expect(html).toMatch(/fonts\.googleapis\.com[^"']*DM\+Sans/)
    for (const weight of ['400', '500', '600', '700']) {
      expect(html, `DM Sans should load weight ${weight}`).toContain(weight)
    }
  })
})
