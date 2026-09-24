/**
 * src/__tests__/BottomNav.morePins.test.jsx
 *
 * V5-NAVCUSTOM-001 — the More sheet drawn from the registry: this person's Pinned block (D1), the pin
 * button on every row (D2), the "Edit tab bar" door only the server lets them see (D3), and the tabs
 * they moved off their bar (D4), drawn at the top of "Your garden".
 *
 * Driven through the REAL chain — PrefsProvider → stubbed fetchNotificationPrefs → NavPrefsProvider →
 * layoutMoreSheet → the rendered sheet — with only the network edge stubbed. Invariants: I1 (exactly
 * one door per destination), I11 (no re-sort while open, render half; the history half is in
 * BottomNav.backNav.test.jsx), I12 (row extras survive, pinned or not). Every case names the mutation
 * that reds it.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

const { prefsRef, saveSpy, navigateSpy } = vi.hoisted(() => ({
  prefsRef: { current: null },
  saveSpy: vi.fn(),
  navigateSpy: vi.fn(),
}))

// Link serialises state.background (the BottomNav.test.jsx convention) so "opens as a page, not an
// overlay" is observable.
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} data-overlay-bg={state?.background ? String(state.background.pathname) : undefined} {...rest}>{children}</a>
  ),
  useLocation: () => ({ pathname: '/dashboard' }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: { display_name: 'Dave' }, signOut: vi.fn() }),
}))
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
// I12: the What's-New dot, stubbed to a testid so "it is still on Release Notes" is observable.
vi.mock('../components/WhatsNewDot.jsx', () => ({ default: () => <span data-testid="whats-new-dot" /> }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: () => Promise.resolve(null), getToken: () => Promise.resolve('t') }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => prefsRef.current),
  saveMorePins: saveSpy,
}))

import BottomNav from '../components/BottomNav.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider } from '../context/NavPrefsContext.jsx'
import { DEFAULT_NAV_TABS, MOVABLE_TAB_KEYS, TAB_REGISTRY } from '../lib/navConfig.js'
import { MORE_ROWS, MOVED_SUB } from '../lib/moreRegistry.js'

async function renderNav({ bar_layout = null, more_pins = null, can_edit_bar = false } = {}) {
  localStorage.clear()
  prefsRef.current = { bar_layout, more_pins, can_edit_bar }
  let view
  await act(async () => {
    view = render(<PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider>)
  })
  return view
}
// By role: with the sheet open, the dialog carries the same accessible name as the button.
const moreButton = () => screen.getByRole('button', { name: 'More navigation options' })
const openMore = () => fireEvent.click(moreButton())
const closeMore = () => fireEvent.click(moreButton())
const sheet = () => screen.getByRole('dialog', { name: 'More navigation options' })
const rowLinks = () => within(sheet()).getAllByRole('link')
const linkTo = (href) => rowLinks().find(a => a.getAttribute('href') === href)
const pinOf = (id) => sheet().querySelector(`[data-pin-id="${id}"]`)
const pinnedIds = () => [...(screen.queryByTestId('more-pinned')?.querySelectorAll('[data-more-row]') ?? [])].map(r => r.getAttribute('data-more-row'))
const homeOrder = () => [...sheet().querySelectorAll('[data-more-row]')].map(r => r.getAttribute('data-more-row'))
  .filter(id => !pinnedIds().includes(id))

beforeEach(() => {
  saveSpy.mockReset().mockResolvedValue({ ok: true })
  navigateSpy.mockClear()
})

describe('I1 — exactly one door per destination, bar ∪ sheet, for every move × pin state', () => {
  const tabDoors = DEFAULT_NAV_TABS.filter(k => !TAB_REGISTRY[k].highlight).map(k => TAB_REGISTRY[k].to)
  const rowDoors = MORE_ROWS.filter(r => r.enabled !== false && !r.component).map(r => r.to)
  const subsets = [[], ['garden'], ['harvests'], ['put-up'], ['garden', 'harvests'], ['garden', 'put-up'], ['harvests', 'put-up'], [...MOVABLE_TAB_KEYS]]
  const pinSets = [null, ['seeds', 'photos'], ['put-up', 'seeds'], ['future-row', 'sow', 'catch-up'], ['admin', 'releases', 'garden', 'seeds', 'photos']]

  // KILLING MUTATIONS: draw a moved tab nowhere (a door lost); keep it on the bar AND add its row (a
  // duplicate); draw a pinned row in Pinned AND at home (a duplicate). RESULT: RED for each.
  it('every destination has one door and only one', async () => {
    for (const hidden of subsets) {
      for (const more_pins of pinSets) {
        const view = await renderNav({ bar_layout: { order: [...DEFAULT_NAV_TABS], hidden }, more_pins })
        openMore()
        const bar = [...screen.getByLabelText('Main navigation').querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
        const doors = [...bar, ...rowLinks().map(a => a.getAttribute('href'))]
        const label = JSON.stringify({ hidden, more_pins })
        expect([...doors].sort(), label).toEqual([...tabDoors, ...rowDoors].sort())
        view.unmount()
      }
    }
  })
})

describe('moved tabs — they land at the top of “Your garden”, never nowhere', () => {
  it('in bar order, first in the section, subtitled with where they came from', async () => {
    await renderNav({ bar_layout: { order: ['put-up', 'today', 'create', 'garden', 'harvests'], hidden: ['harvests', 'put-up'] } })
    openMore()
    expect(homeOrder().slice(0, 3)).toEqual(['put-up', 'harvests', 'dashboard'])
    const putUp = linkTo('/put-up')
    expect(within(putUp).getByText('Put-Up')).toBeTruthy()
    expect(within(putUp).getByText(MOVED_SUB)).toBeTruthy()
  })

  // Put-Up is a landing page wherever it renders (V4-PUTUPENGINE-001); /put-up is `overlayable` in
  // App.jsx, so an OverlayLink here would bring back the flyover that ruling retired.
  // KILLING MUTATION: render moved rows with `overlay`. RESULT: RED.
  it('a moved Put-Up opens as a page, not an overlay', async () => {
    await renderNav({ bar_layout: { order: [...DEFAULT_NAV_TABS], hidden: ['put-up'] } })
    openMore()
    expect(linkTo('/put-up').getAttribute('data-overlay-bg')).toBeNull()
    // CONTROL: the create sheet's /log row IS an overlay under the same mock.
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Log an event').closest('a').getAttribute('data-overlay-bg')).toBe('/dashboard')
  })

  it('a moved tab can be pinned like any row, and then sits in Pinned', async () => {
    await renderNav({ bar_layout: { order: [...DEFAULT_NAV_TABS], hidden: ['put-up'] }, more_pins: ['put-up'] })
    openMore()
    expect(pinnedIds()).toEqual(['put-up'])
    expect(within(screen.getByTestId('more-pinned')).getByText(MOVED_SUB)).toBeTruthy()
  })
})

describe('the Pinned block (D1)', () => {
  // Jen's sheet is unchanged until she pins: no label, no block — the name line then View mode.
  // KILLING MUTATION: always render the block. RESULT: RED.
  it('is absent with no pins, so the sheet opens exactly as before', async () => {
    await renderNav()
    openMore()
    expect(screen.queryByTestId('more-pinned')).toBeNull()
    expect(within(sheet()).queryByText('Pinned')).toBeNull()
  })

  // KILLING MUTATION: order Pinned by registry order. RESULT: RED.
  it('lists pins in pin order, and a pinned row is drawn ONCE — in Pinned, not at home', async () => {
    await renderNav({ more_pins: ['seeds', 'photos'] })
    openMore()
    expect(pinnedIds()).toEqual(['seeds', 'photos'])
    expect(rowLinks().filter(a => a.getAttribute('href') === '/seeds')).toHaveLength(1)
    expect(homeOrder()).not.toContain('seeds')
    // Pinned sits above View mode.
    const block = screen.getByTestId('more-pinned')
    const viewMode = screen.getByText('View mode')
    expect(block.compareDocumentPosition(viewMode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows at most four; a stale or sleeping pin takes no slot', async () => {
    await renderNav({ more_pins: ['future-row', 'seeds', 'photos', 'admin', 'about', 'helper'] })
    openMore()
    expect(pinnedIds()).toEqual(['seeds', 'photos', 'admin', 'about'])
    expect(homeOrder()).toContain('helper')
  })
})

describe('the pin button (D2)', () => {
  // A SIBLING after the link, never inside it (nested interactive content; its tap would bubble into
  // the link's navigate). KILLING MUTATION: render the button inside the SheetRowLink. RESULT: RED.
  it('sits beside every pinnable row’s link, after it in DOM order, 48px wide', async () => {
    await renderNav()
    openMore()
    const links = rowLinks()
    const pins = within(sheet()).getAllByTestId('more-pin')
    expect(pins).toHaveLength(links.length)   // every drawn row here is pinnable
    for (const a of links) {
      const btn = a.nextElementSibling
      expect(btn?.getAttribute('data-testid'), a.getAttribute('href')).toBe('more-pin')
      expect(a.contains(btn)).toBe(false)
      expect(btn.style.width).toBe('48px')
    }
  })

  it('View mode and Sign out carry no pin button', async () => {
    await renderNav()
    openMore()
    for (const text of ['View mode', 'Sign out']) {
      const control = screen.getByText(text).closest('button')
      expect(control.nextElementSibling?.getAttribute('data-testid')).not.toBe('more-pin')
      expect(control.querySelector('[data-testid="more-pin"]')).toBeNull()
    }
  })

  it('names itself for its row and state, with aria-pressed; the pinned glyph is the colour one', async () => {
    await renderNav({ more_pins: ['seeds'] })
    openMore()
    const seeds = pinOf('seeds')
    expect(seeds.getAttribute('aria-label')).toBe('Unpin Seeds')
    expect(seeds.getAttribute('aria-pressed')).toBe('true')
    expect(seeds.querySelector('svg').innerHTML).toMatch(/#[0-9a-f]{6}/i)
    const photos = pinOf('photos')
    expect(photos.getAttribute('aria-label')).toBe('Pin Photos to the top')
    expect(photos.getAttribute('aria-pressed')).toBe('false')
    expect(photos.querySelector('svg').innerHTML).not.toMatch(/#[0-9a-f]{6}/i)
  })

  // I11 (render half) + "never navigates, never closes the sheet".
  // KILLING MUTATIONS: re-sort live (compute rows from live pins); drop stopPropagation and put the
  // button inside the link. RESULT: RED.
  it('a tap flips the button at once, saves, keeps the sheet open, and moves NOTHING until the next open', async () => {
    await renderNav()
    openMore()
    const before = homeOrder()
    await act(async () => { fireEvent.click(pinOf('photos')) })
    expect(pinOf('photos').getAttribute('aria-pressed')).toBe('true')
    expect(pinOf('photos').getAttribute('aria-label')).toBe('Unpin Photos')
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][0].ids).toEqual(['photos'])
    expect(screen.getByText('Sign out')).toBeTruthy()       // still open
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(homeOrder()).toEqual(before)                       // frozen
    expect(screen.queryByTestId('more-pinned')).toBeNull()
    closeMore(); openMore()
    expect(pinnedIds()).toEqual(['photos'])                   // re-sorted at the next open
  })

  // stopPropagation, made observable: the Sheet renders in place, so a React click handler on ANY
  // ancestor (a row-level tap target a future edit adds, the link it once sat inside) hears every tap
  // that is not stopped. KILLING MUTATION: drop e.stopPropagation(). RESULT: RED.
  it('a pin tap stops at the button — an ancestor’s click handler never hears it', async () => {
    const outer = vi.fn()
    localStorage.clear()
    prefsRef.current = { bar_layout: null, more_pins: null, can_edit_bar: false }
    await act(async () => {
      render(<div onClick={outer}><PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider></div>)
    })
    openMore()
    outer.mockClear()
    await act(async () => { fireEvent.click(pinOf('photos')) })
    expect(outer).not.toHaveBeenCalled()
    // CONTROL: the same ancestor does hear an ordinary tap inside the sheet.
    fireEvent.click(screen.getByText('View mode'))
    expect(outer).toHaveBeenCalled()
  })

  // "A 5th pin shows 'Unpin one first' INLINE at that row (no toast), and pins nothing."
  // KILLING MUTATION: drop the 'full' note, or the cap. RESULT: RED.
  it('a fifth pin says "Unpin one first" at that row, and pins nothing', async () => {
    await renderNav({ more_pins: ['seeds', 'photos', 'admin', 'about'] })
    openMore()
    await act(async () => { fireEvent.click(pinOf('helper')) })
    const row = sheet().querySelector('[data-more-row="helper"]')
    expect(within(row).getByRole('status').textContent).toBe('Unpin one first')
    expect(pinOf('helper').getAttribute('aria-pressed')).toBe('false')
    expect(saveSpy).not.toHaveBeenCalled()
    // Exactly one note on the sheet, and it is not a toast/alert.
    expect(within(sheet()).getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a refused save puts the button back and says so at the row', async () => {
    saveSpy.mockResolvedValue({ ok: false, status: 400 })
    await renderNav()
    openMore()
    await act(async () => { fireEvent.click(pinOf('photos')) })
    expect(pinOf('photos').getAttribute('aria-pressed')).toBe('false')
    expect(within(sheet().querySelector('[data-more-row="photos"]')).getByRole('status').textContent).toBe('Not saved. Try again.')
  })

  it('an unpin of a pinned row from the Pinned block keeps it there until the next open', async () => {
    await renderNav({ more_pins: ['seeds'] })
    openMore()
    await act(async () => { fireEvent.click(pinOf('seeds')) })
    expect(saveSpy.mock.calls[0][0].ids).toEqual([])
    expect(pinnedIds()).toEqual(['seeds'])
    expect(pinOf('seeds').getAttribute('aria-pressed')).toBe('false')
    closeMore(); openMore()
    expect(screen.queryByTestId('more-pinned')).toBeNull()
    expect(homeOrder()).toContain('seeds')
  })
})

describe('"Edit tab bar" (D3) — the server’s can_edit_bar decides who sees it', () => {
  // KILLING MUTATION: drop the canEditBar check. RESULT: RED — Jen would see the door.
  it('is absent unless can_edit_bar is true', async () => {
    await renderNav({ can_edit_bar: false })
    openMore()
    expect(screen.queryByTestId('more-edit-tab-bar')).toBeNull()
  })

  it('opens /admin/config from the header’s left slot, and closes the sheet like any row', async () => {
    await renderNav({ can_edit_bar: true })
    openMore()
    const door = screen.getByTestId('more-edit-tab-bar')
    expect(door.getAttribute('href')).toBe('/admin/config')
    expect(door.textContent).toBe('Edit tab bar')
    // In the header row, before the Close control.
    const close = screen.getByRole('button', { name: /^close$/i })
    expect(door.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(door)
    expect(screen.queryByText('Sign out')).toBeNull()
  })
})

describe('I12 — row extras survive, at home AND pinned', () => {
  // KILLING MUTATION: a renderer that drops `testId`, `sub` or `adornment`. RESULT: RED.
  it('at home: the Seeds testid and subtitle, the Critters subtitle, the What’s-New dot on Release Notes', async () => {
    await renderNav()
    openMore()
    const seeds = screen.getByTestId('more-seeds')
    expect(seeds.getAttribute('href')).toBe('/seeds')
    expect(within(seeds).getByText('My seeds · Saved seeds · Sow now')).toBeTruthy()
    expect(within(linkTo('/collection')).getByText("Who's been visiting")).toBeTruthy()
    expect(within(linkTo('/releases')).getByTestId('whats-new-dot')).toBeTruthy()
  })

  it('pinned: the same extras move with the row, and Critters still carries no count', async () => {
    await renderNav({ more_pins: ['seeds', 'collection', 'releases'] })
    openMore()
    const block = screen.getByTestId('more-pinned')
    const seeds = within(block).getByTestId('more-seeds')
    expect(within(seeds).getByText('My seeds · Saved seeds · Sow now')).toBeTruthy()
    const critters = within(block).getByText('Critters').closest('a')
    expect(within(critters).getByText("Who's been visiting")).toBeTruthy()
    expect(critters.textContent).not.toMatch(/\d/)             // Reward UX: never a count
    expect(within(within(block).getByText('Release Notes').closest('a')).getByTestId('whats-new-dot')).toBeTruthy()
    expect(screen.getAllByTestId('whats-new-dot')).toHaveLength(1)
  })
})
