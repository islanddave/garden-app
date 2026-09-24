/**
 * src/__tests__/BottomNav.navConfig.test.jsx
 *
 * V5-NAVCUSTOM-001 — the tab bar under a PERSON's layout (D4, Dave 2026-09-24: only his bar
 * changes). The layout is user_notification_prefs.bar_layout; the global app_config path this file
 * used to drive (V5-ADMINCENTER-001) is retired from the SPA.
 *
 * WHAT THIS FILE OWNS THAT ITS SIBLINGS CANNOT. BottomNav.test.jsx renders <BottomNav /> bare, so every
 * assertion there is about the SHIPPED bar. This file drives the REAL chain — PrefsProvider → stubbed
 * fetchNotificationPrefs → NavPrefsProvider → resolveBarLayout → the rendered bar — which is the only
 * place the provider, the resolver and the renderer are exercised together. Stubbing useNavLayout
 * instead would turn every case into an assertion about the stub.
 *
 * The unit-level guards live in navConfig.test.js with their killing mutations named. What is asserted
 * here is that they are WIRED: a resolver that refuses a bad layout is worth nothing if BottomNav reads
 * the raw column instead. Invariants covered: I2 (never an empty bar), I3 (＋ and the field mic under
 * every layout), I5 (a legacy/absent/malformed value draws today's bar), I9 (label, height, More last).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

const { prefsRef, fetchPrefsSpy, modeRef } = vi.hoisted(() => {
  const prefsRef = { current: null }
  return {
    prefsRef,
    fetchPrefsSpy: vi.fn(async () => prefsRef.current),
    modeRef: { isField: false },
  }
})

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useLocation: () => ({ pathname: '/dashboard' }),
  useNavigate: () => vi.fn(),
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: { display_name: 'Dave' }, signOut: vi.fn() }),
}))
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: () => Promise.resolve(null), getToken: () => Promise.resolve('t') }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: modeRef.isField ? 'field' : 'desk', isField: modeRef.isField, isDesk: !modeRef.isField, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

// The ONLY stub in the chain under test: the network edge. Everything from PrefsProvider inward is
// the real code.
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: fetchPrefsSpy,
  saveMorePins: vi.fn(async () => ({ ok: true })),
}))

import BottomNav, { BOTTOM_NAV_HEIGHT_PX } from '../components/BottomNav.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider } from '../context/NavPrefsContext.jsx'
import { DEFAULT_NAV_TABS, MOVABLE_TAB_KEYS } from '../lib/navConfig.js'
import { SHIPPED_MORE_HREFS } from './helpers/shippedDoors.js'

const SHIPPED = ['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More']

// The nav's own children, in render order. Text rather than testids because that is what the
// existing suite pins and what a human reads off the bar. The field mic reads as 'Mic'.
const labels = () => [...screen.getByLabelText('Main navigation').children]
  .map(c => c.getAttribute('aria-label') === 'Create' ? 'Create'
    : c.getAttribute('data-testid') === 'bottomnav-field-mic' ? 'Mic' : c.textContent)

// `undefined` stands for the live state today: no layout stored (bar_layout NULL). Storage is cleared
// first, so every render is a FIRST launch and the stored value applies at once — a loop's previous
// iteration would otherwise leave a launch cache and its layout would win until the "next launch".
async function renderWithLayout(barLayout, extra = {}) {
  localStorage.clear()
  prefsRef.current = { bar_layout: barLayout === undefined ? null : barLayout, more_pins: null, can_edit_bar: false, ...extra }
  let view
  await act(async () => {
    view = render(<PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider>)
  })
  return view
}
const layout = (order, hidden = []) => ({ order, hidden })

beforeEach(() => {
  fetchPrefsSpy.mockClear()
  modeRef.isField = false
})

describe('BottomNav — a person’s layout', () => {
  it('renders the shipped bar when no layout is stored', async () => {
    await renderWithLayout(undefined)
    expect(labels()).toEqual(SHIPPED)
  })

  it('applies a reorder', async () => {
    await renderWithLayout(layout(['harvests', 'put-up', 'create', 'today', 'garden']))
    expect(labels()).toEqual(['Harvests', 'Put-Up', 'Create', 'Today', 'Garden', 'More'])
  })

  it('applies a move: the moved tab leaves the bar and the rest keep their order', async () => {
    await renderWithLayout(layout([...DEFAULT_NAV_TABS], ['put-up']))
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'More'])
  })

  // The FAB is identified by `highlight`, not by index — moved off centre it is still the button that
  // opens the create sheet, not a link.
  it('a moved FAB is still the create button, not a link to /log', async () => {
    await renderWithLayout(layout(['create', 'today', 'garden', 'harvests', 'put-up']))
    expect(labels()[0]).toBe('Create')
    const fab = screen.getByLabelText('Create')
    expect(fab.tagName).toBe('BUTTON')
    expect(fab.getAttribute('aria-haspopup')).toBe('true')
  })

  it('reordering does not change where a tab points', async () => {
    await renderWithLayout(layout(['put-up', 'harvests', 'create', 'garden', 'today']))
    expect(screen.getByText('Put-Up').closest('a').getAttribute('href')).toBe('/put-up')
    expect(screen.getByText('Today').closest('a').getAttribute('href')).toBe('/today')
    expect(screen.getByText('Harvests').closest('a').getAttribute('href')).toBe('/harvests')
    expect(screen.getByText('Garden').closest('a').getAttribute('href')).toBe('/garden')
  })
})

describe('I2 — never an empty bar, never a bar with only More', () => {
  // The smallest bar the design allows: Today · ＋ · More.
  it('moving every movable tab leaves Today · ＋ · More', async () => {
    await renderWithLayout(layout([...DEFAULT_NAV_TABS], [...MOVABLE_TAB_KEYS]))
    expect(labels()).toEqual(['Today', 'Create', 'More'])
  })

  // KILLING MUTATION (navConfig.js): delete H2 — the movable-key guard. RESULT: RED here, through
  // the real render, not just in the resolver's own test.
  it('a stored hide of ＋ or Today is refused whole: the full bar renders', async () => {
    for (const hidden of [['create'], ['today'], ['today', 'create', 'garden', 'harvests', 'put-up']]) {
      await renderWithLayout(layout([...DEFAULT_NAV_TABS], hidden)).then(v => { expect(labels(), JSON.stringify(hidden)).toEqual(SHIPPED); v.unmount() })
    }
  })

  it('an empty or short order renders the full bar', async () => {
    for (const order of [[], ['today'], ['today', 'garden', 'create', 'harvests']]) {
      await renderWithLayout(layout(order)).then(v => { expect(labels(), JSON.stringify(order)).toEqual(SHIPPED); v.unmount() })
    }
  })

  // THE CAP, AS A CAP ON THE RENDERED BAR. A seven-key order does not get a seventh slot.
  it('a seven-key order does NOT grow the bar past six slots', async () => {
    await renderWithLayout(layout(['today', 'garden', 'create', 'harvests', 'put-up', 'today', 'garden']))
    expect(screen.getByLabelText('Main navigation').children.length).toBe(6)
    expect(labels()).toEqual(SHIPPED)
  })

  it('an unknown key renders the full bar rather than a blank slot', async () => {
    await renderWithLayout(layout(['today', 'garden', 'create', 'harvests', 'sprockets']))
    expect(labels()).toEqual(SHIPPED)
    expect(labels().some(l => l === '' || l == null)).toBe(false)
  })
})

describe('I3 — ＋ survives every layout, in both modes', () => {
  // Every hidden subset under three orders (the FAB first, centre and last), desk AND field: 48
  // renders. The resolver-level sweep over all 1,920 legal layouts lives in navConfig.test.js.
  const orders = [
    ['create', 'today', 'garden', 'harvests', 'put-up'],
    [...DEFAULT_NAV_TABS],
    ['today', 'garden', 'harvests', 'put-up', 'create'],
  ]
  const subsets = [[], ['garden'], ['harvests'], ['put-up'], ['garden', 'harvests'], ['garden', 'put-up'], ['harvests', 'put-up'], [...MOVABLE_TAB_KEYS]]

  it('desk: exactly one Create button; field: exactly one mic to /field — under every layout', async () => {
    for (const isField of [false, true]) {
      modeRef.isField = isField
      for (const order of orders) {
        for (const hidden of subsets) {
          const view = await renderWithLayout(layout(order, hidden))
          const label = JSON.stringify({ isField, order, hidden })
          if (isField) {
            const mics = screen.getAllByTestId('bottomnav-field-mic')
            expect(mics, label).toHaveLength(1)
            expect(mics[0].getAttribute('href'), label).toBe('/field')
            expect(screen.queryByLabelText('Create'), label).toBeNull()
          } else {
            expect(screen.getAllByLabelText('Create'), label).toHaveLength(1)
          }
          expect(labels().length, label).toBe(DEFAULT_NAV_TABS.length - hidden.length + 1)
          view.unmount()
        }
      }
    }
  })
})

describe('I9 — the bar’s label, height and More-last hold under every layout', () => {
  const cases = [
    undefined,
    layout(['today', 'garden', 'harvests', 'put-up', 'create']),
    layout(['put-up', 'harvests', 'create', 'garden', 'today'], ['garden', 'put-up']),
    layout([...DEFAULT_NAV_TABS], [...MOVABLE_TAB_KEYS]),
  ]
  // KILLING MUTATION: rename the nav's aria-label, or emit More inside the map. RESULT: RED.
  // useSuppressBottomNav and EventNew find the bar by this exact label.
  it('nav[aria-label="Main navigation"] at BOTTOM_NAV_HEIGHT_PX, with More last', async () => {
    for (const c of cases) {
      const view = await renderWithLayout(c)
      const nav = document.querySelector('nav[aria-label="Main navigation"]')
      expect(nav, JSON.stringify(c)).toBeTruthy()
      expect(nav.style.height).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
      expect(labels().at(-1)).toBe('More')
      expect(nav.lastElementChild.getAttribute('aria-label')).toBe('More navigation options')
      view.unmount()
    }
  })
})

describe('I5 — legacy, absent and malformed values draw today’s bar', () => {
  it('a malformed stored value renders the full bar', async () => {
    for (const bad of [['today', 'garden'], 'put-up', 42, { order: 'x' }, { hidden: 'put-up' }]) {
      await renderWithLayout(bad).then(v => { expect(labels(), JSON.stringify(bad)).toEqual(SHIPPED); v.unmount() })
    }
  })

  // An old Lambda (or a prefs row written before the column existed) sends no bar_layout at all.
  it('a prefs payload with no bar_layout key renders the shipped bar', async () => {
    prefsRef.current = { critter_visit: 'in_app_only' }
    await act(async () => { render(<PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider>) })
    expect(labels()).toEqual(SHIPPED)
  })

  // Not a decoration: a prefs read that fails must leave the app with its shipped nav, not no nav.
  it('a failed prefs read renders the shipped bar', async () => {
    fetchPrefsSpy.mockResolvedValueOnce(null)
    await act(async () => { render(<PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider>) })
    expect(labels()).toEqual(SHIPPED)
  })
})

// I5, the SHEET half: a value that moves nothing (null, a pure reorder in any of the 120 orders, a
// malformed value) draws today's More sheet — the shipped rows, in the shipped order, and no moved-tab
// rows. KILLING MUTATION: draw every tab in More regardless of `hidden`, or re-derive the sheet from
// `order`. RESULT: RED.
describe('I5 — a value that moves nothing draws today’s sheet, with no extra rows', () => {
  const permutations = (list) => list.length <= 1 ? [list]
    : list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(p => [x, ...p]))
  const sheetHrefs = () => [...screen.getByRole('dialog', { name: 'More navigation options' }).querySelectorAll('a[href]')]
    .map(a => a.getAttribute('href'))

  // The reference is the LITERAL sheet shipped at ff1e03ea (helpers/shippedDoors.js), in order — not
  // this change's own null-layout render, which would drift with any row the registry lost (QA MINOR-3).
  it('null, all 120 orders and malformed values: the shipped sheet, row for row', async () => {
    const shipped = SHIPPED_MORE_HREFS
    const values = [undefined, ...permutations(DEFAULT_NAV_TABS).map(order => layout(order)), ['today', 'garden'], { hidden: 'put-up' }]
    for (const value of values) {
      const view = await renderWithLayout(value)
      fireEvent.click(screen.getByRole('button', { name: 'More navigation options' }))
      expect(sheetHrefs(), JSON.stringify(value)).toEqual(shipped)
      view.unmount()
    }
  })
})

describe('the boot path — one read, not one per consumer', () => {
  // AppConfigProvider's GET /api/app-config is GONE; the layout rides the prefs read that was already
  // happening. KILLING MUTATION: have NavPrefsProvider fetch prefs itself. RESULT: RED (2 calls).
  it('reads prefs once for the whole tree', async () => {
    await renderWithLayout(undefined)
    expect(fetchPrefsSpy).toHaveBeenCalledTimes(1)
  })
})
