// iconWire2.test.jsx — V4-ICON-001, the wiring pass over the two largest emoji surfaces
// (pages/EventNew.jsx, components/BottomNav.jsx) plus lib/todayBand.js.
//
// THREE THINGS THIS FILE EXISTS TO PIN, and why each needs pinning separately:
//
//   1. THE EMOJI ARE GONE, AND STAY GONE. eslint.config.js scopes designsys/no-raw-design-tokens
//      to nine files, none of them these; and even inside that scope the rule visits JSXText and
//      literal JSX attributes only, so a `glyph:` field in a plain object — exactly the shape
//      BottomNav's TABS used — was never reachable by it. Nothing in CI could fail on a
//      re-introduced emoji here. This scan can.
//
//   2. EVERY KEY RESOLVES. getIcon() returns NEUTRAL_ICON rather than throwing (a deliberate §15
//      contract), so a typo'd name renders a small grey dot and ships looking plausible. A static
//      "the key exists" check is the only thing between that and prod, and the render assertions
//      below refuse the fallback markup explicitly rather than counting <svg>s — counting would
//      pass on six neutral dots.
//
//   3. THE SEVERITY LADDER IS NOT COLOR. It was a map of three coloured-circle emoji — one circle
//      in three hues, which is a WCAG 1.4.1 failure outright. The registry rungs differ by SHAPE
//      (filled dot -> open triangle -> triangle with an alert inside), so the assertion here is
//      that the three rendered shapes are pairwise different and each rung carries its own text.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { GLYPHS, NEUTRAL_ICON, getIcon } from '../lib/iconRegistry.js'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

// cwd-relative, not import.meta.url: under vitest the module URL is an http: one and
// fileURLToPath rejects it. Same convention as weighInSessionBaseBytes.test.jsx.
const src = (rel) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8')

const WIRED = ['pages/EventNew.jsx', 'components/BottomNav.jsx', 'lib/todayBand.js']

// The pictographic ranges, both as literal characters and in escaped form — todayBand.js carried
// its two glyphs ESCAPED, which is precisely the shape a naive emoji grep misses.
const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/gu
const ESCAPED_PICTOGRAPHIC = /\\u\{1F[0-9A-Fa-f]{3}\}|\\u2[6-7][0-9A-Fa-f]{2}/g

// The three characters left in EventNew on purpose, named by codepoint so this file contains no
// raw emoji either. All three live in SuccessScreen — dead code (unreferenced, eslint-disabled) —
// and all three are reward ORNAMENT: flame beside a streak count, bolt beside an XP count,
// party-popper inside "Level up". The adjacent text already carries the meaning, the icon grammar
// has no celebration family, and minting registry keys for confetti is out of scope.
// If a future edit deletes SuccessScreen these counts go to zero and the test says so.
const DECORATIVE = {
  '\u{1F525}': 1, // flame — streak card
  '\u26A1': 1,   // high voltage — XP card
  '\u{1F389}': 1, // party popper — level-up line
}

describe('V4-ICON-001 — the wired files carry no pictographic characters', () => {
  it.each(WIRED)('%s has no emoji outside the declared decorative allowance', (rel) => {
    const found = src(rel).match(PICTOGRAPHIC) ?? []
    const counts = {}
    for (const ch of found) counts[ch] = (counts[ch] ?? 0) + 1
    const allowance = rel === 'pages/EventNew.jsx' ? DECORATIVE : {}
    expect(counts, `${rel}: unexpected pictographic characters`).toEqual(allowance)
  })

  it.each(WIRED)('%s has no escaped emoji either', (rel) => {
    expect(src(rel).match(ESCAPED_PICTOGRAPHIC) ?? []).toEqual([])
  })

  it('the scanner actually matches emoji (this file is not passing on a dead regex)', () => {
    // Without this, every assertion above would pass forever the day the ranges are mistyped.
    expect('\u{1F4A7}'.match(PICTOGRAPHIC)).toHaveLength(1)
    expect("emoji: '\\u{1F440}'".match(ESCAPED_PICTOGRAPHIC)).toHaveLength(1)
    expect('plain text'.match(PICTOGRAPHIC)).toBeNull()
  })

  it('the old surfaces are gone by name, not just by character', () => {
    const nav = src('components/BottomNav.jsx')
    // TABS carried `glyph:` for Harvests/Put-Up; every row is `iconName:` now and the
    // glyph-or-iconName fork that read them is retired with them.
    expect(nav).not.toMatch(/\bglyph\s*:/)
    expect(nav).not.toMatch(/tab\.glyph|action\.glyph/)
    const band = src('lib/todayBand.js')
    expect(band).not.toMatch(/\bemoji\s*:/)
    expect(band).toContain("iconName: 'care.drop'")
    expect(band).toContain("iconName: 'status.unseen'")
    const evt = src('pages/EventNew.jsx')
    expect(evt).not.toMatch(/const EMOJI\s*=/)
    expect(evt).toContain('SEVERITY_ICON')
  })
})

describe('V4-ICON-001 — every registry key named in the wired files resolves', () => {
  // Registry-key-shaped literals: <category>.<name>, restricted to the ten live categories so a
  // module path or an unrelated dotted string cannot be mistaken for one.
  // BOTH quote styles, and that is not incidental: the first draft matched only `'…'` and a
  // deliberately typo'd `name="facet.locatoin"` — a JSX attribute, which is where most of these
  // actually live — sailed straight through it. The mutation run is what found that.
  const KEY_RE = /['"]((?:action|care|event|facet|lifecycle|media|mode|nav|severity|status)\.[A-Za-z][A-Za-z0-9_]*)['"]/g
  const keysIn = (rel) => [...new Set([...src(rel).matchAll(KEY_RE)].map(m => m[1]))]
  // TodayBand.jsx is the one consumer of todayBand.js's renamed field and moved with it.
  const SCANNED = [...WIRED, 'components/TodayBand.jsx']

  it('the scan found keys at all (guards the whole describe from going vacuous)', () => {
    expect(SCANNED.flatMap(keysIn).length).toBeGreaterThanOrEqual(12)
  })

  it.each(SCANNED)('%s names only real registry entries', (rel) => {
    const missing = keysIn(rel).filter(k => getIcon(k) === NEUTRAL_ICON)
    expect(missing, `${rel} would render the silent neutral dot for these`).toEqual([])
  })

  it('the keys this lane introduced are present by name', () => {
    for (const k of ['nav.harvests', 'nav.putup', 'nav.space', 'nav.achievements', 'facet.location',
      'care.drop', 'status.unseen', 'severity.low', 'severity.med', 'severity.high',
      'media.mic', 'media.stop', 'action.flag', 'action.close', 'action.remove', 'action.check',
      'media.camera', 'event.harvest']) {
      expect(GLYPHS[k], `${k} missing from the registry`).toBeTruthy()
    }
  })
})

// ── Render harness. BottomNav and EventNew share one set of module mocks here on purpose: the
//    point of this file is that ONE icon language now covers both surfaces. ─────────────────────
const { signOutSpy, navigateSpy, locationRef, apiFetchSpy, searchParamsRef, dataRef } = vi.hoisted(() => ({
  signOutSpy: vi.fn(() => Promise.resolve()),
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/dashboard' },
  apiFetchSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  dataRef: { projects: [], locations: [], plants: [] },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => locationRef,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))
// PARTIAL mock: EventNew reaches AuthContext a second way (useCachedFetch -> useAuthOptional),
// and a wholesale replacement drops that export and throws at mount instead of failing an
// assertion — which reads as a broken test rather than the broken thing it would be.
vi.mock('../context/AuthContext.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => ({ user: { id: 'u1' }, profile: { display_name: 'Dave' }, signOut: signOutSpy }),
}))
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: () => Promise.resolve(null) }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null,
    stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

import BottomNav from '../components/BottomNav.jsx'
import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { SEVERITY_LEVELS } from '../lib/dropdownRegistry.js'

// The registry authors self-closing markup (`<path …/>`); the DOM serializes the same nodes as
// open/close pairs. Round-tripping the registry string through the parser makes both sides
// comparable without hand-rolling a serializer that could normalize away a real difference.
const parsed = (markup) => {
  const host = document.createElement('div')
  host.innerHTML = `<svg>${markup}</svg>`
  return host.firstChild.innerHTML
}
const isNeutral = (svg) =>
  svg.innerHTML === parsed(NEUTRAL_ICON.svg24) || svg.innerHTML === parsed(NEUTRAL_ICON.svg18)

describe('V4-ICON-001 — BottomNav draws a real glyph in every slot', () => {
  beforeEach(() => { locationRef.pathname = '/dashboard' })
  afterEach(cleanup)

  it('all six nav slots render an svg, and none of them is the neutral fallback', () => {
    render(<BottomNav />)
    const nav = screen.getByRole('navigation')
    expect(nav.children).toHaveLength(6)
    for (const slot of nav.children) {
      const svgs = slot.querySelectorAll('svg')
      expect(svgs.length, `slot "${slot.textContent}" renders no icon`).toBeGreaterThan(0)
      for (const s of svgs) {
        expect(isNeutral(s), `slot "${slot.textContent}" fell back to the neutral dot`).toBe(false)
      }
    }
  })

  // V4-ICONCOLOR-001 (Dave 2026-08-28): the tab bar now asks for the `filled` colour variant, so the
  // rendered markup is deliberately no longer byte-identical to the base master — Icon.jsx swaps a
  // resolved hex in for `currentColor` on each [data-region]. UPDATED, NOT WEAKENED: the property
  // this test exists for is still that each tab draws ITS OWN authored shape rather than the neutral
  // dot or its neighbour's, and it is still asserted over the whole markup. Only the baseline moved,
  // from the base master to the variant the bar actually requests.
  const decolour = (html) => html.replace(/#[0-9a-f]{6}/gi, 'currentColor')
  it('the two newly-wired tabs draw their own authored shape', () => {
    render(<BottomNav />)
    const nav = screen.getByRole('navigation')
    const svgOf = (label) => within(nav).getByText(label).closest('a').querySelector('svg')
    expect(decolour(svgOf('Harvests').innerHTML)).toBe(parsed(GLYPHS['nav.harvests'].variants.filled.svg24))
    expect(decolour(svgOf('Put-Up').innerHTML)).toBe(parsed(GLYPHS['nav.putup'].variants.filled.svg24))
    // Distinct shapes, not one glyph reused across two adjacent tabs.
    expect(svgOf('Harvests').innerHTML).not.toBe(svgOf('Put-Up').innerHTML)
    // And the colour actually landed. Without this the assertions above pass just as happily on a
    // silent mono fallback — which is the whole thing Dave asked to have fixed.
    expect(svgOf('Harvests').innerHTML).toMatch(/#[0-9a-f]{6}/i)
    expect(svgOf('Put-Up').innerHTML).toMatch(/#[0-9a-f]{6}/i)
  })

  it('the three newly-wired More rows draw their own authored shape', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const rowSvg = (label) => screen.getByText(label).closest('a').querySelector('svg')
    expect(rowSvg('Space').innerHTML).toBe(parsed(GLYPHS['nav.space'].svg24))
    expect(rowSvg('Zones').innerHTML).toBe(parsed(GLYPHS['facet.location'].svg24))
    expect(rowSvg('Achievements').innerHTML).toBe(parsed(GLYPHS['nav.achievements'].svg24))
  })

  it('nothing in the open More sheet falls back to the neutral dot', () => {
    const { container } = render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect([...container.querySelectorAll('svg')].filter(isNeutral)).toHaveLength(0)
    // Non-vacuity: the sheet really did open and really does render icons.
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(15)
  })

  it('the rendered nav contains no pictographic character at all', () => {
    const { container } = render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(container.textContent.match(PICTOGRAPHIC)).toBeNull()
  })
})

describe('V4-ICON-001 — the flag severity ladder reads by shape, not by hue', () => {
  beforeEach(() => {
    apiFetchSpy.mockReset()
    localStorage.clear()
    sessionStorage.clear()
    apiFetchSpy.mockImplementation((path) => {
      if (path === '/api/projects') return Promise.resolve(dataRef.projects)
      if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
      if (String(path).startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
      return Promise.resolve(null)
    })
  })
  afterEach(cleanup)

  async function renderFlagMode() {
    searchParamsRef.current = new URLSearchParams('event_type=flag_issue')
    let view
    await act(async () => { view = render(<ToastProvider><EventNew /></ToastProvider>) })
    await act(async () => { await Promise.resolve() })
    return view
  }

  const rungs = () => screen.getAllByRole('radio')

  it('renders one rung per severity level (guards the rest of this describe)', async () => {
    await renderFlagMode()
    expect(rungs()).toHaveLength(SEVERITY_LEVELS.length)
    expect(SEVERITY_LEVELS.length).toBe(3)
  })

  it('each rung carries its own text, so severity survives with no glyph at all', async () => {
    await renderFlagMode()
    const labels = rungs().map(r => r.textContent.trim())
    expect(labels).toEqual(SEVERITY_LEVELS.map(s => s.label))
    expect(new Set(labels).size).toBe(3)
  })

  it('the three rungs are three DIFFERENT shapes, not one shape in three colors', async () => {
    await renderFlagMode()
    const shapes = rungs().map(r => {
      const svg = r.querySelector('svg')
      expect(svg, 'a severity rung renders no glyph').toBeTruthy()
      expect(isNeutral(svg), 'a severity rung fell back to the neutral dot').toBe(false)
      return svg.innerHTML
    })
    // The whole point: strip color and the ladder is still three distinguishable marks.
    expect(new Set(shapes).size).toBe(3)
    expect(shapes[0]).toBe(parsed(GLYPHS['severity.low'].svg18))
    expect(shapes[1]).toBe(parsed(GLYPHS['severity.med'].svg18))
    expect(shapes[2]).toBe(parsed(GLYPHS['severity.high'].svg18))
  })

  it('no rung renders a pictographic character', async () => {
    await renderFlagMode()
    const group = screen.getByRole('radiogroup')
    expect(group.textContent.match(PICTOGRAPHIC)).toBeNull()
  })

  it('the ladder takes its color from the shared tone tokens, never a baked one', async () => {
    // The old map hardcoded its own hues, so the swatch and the button tone could drift apart with
    // nothing to catch it. Now one `tone` drives border, fill AND glyph.
    await renderFlagMode()
    for (const [i, r] of rungs().entries()) {
      const svg = r.querySelector('svg')
      expect(svg.style.color, `rung ${i} has no explicit tone`).not.toBe('')
      expect(svg.getAttribute('fill')).toBe('none')
      expect(svg.getAttribute('stroke')).toBe('currentColor')
    }
  })
})
