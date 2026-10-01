/**
 * src/__tests__/BottomNav.slotAdornment.test.jsx
 *
 * V5-NAVSLOTADORN-001 — a page's dot follows it onto the tab bar (Dave 2026-10-01: "the dot follows
 * the page — Release Notes or Critters on your bar shows its dot on the tab itself, and the More button
 * stops showing a dot for a page that is no longer inside More. Quiet and in place, same as today's
 * dots — no banner, sound or badge count.").
 *
 * Driven through the REAL chain, dots included: PrefsProvider → NavPrefsProvider → the rendered bar,
 * with the real WhatsNewDot (and its real useWhatsNew) and the real BottomNavDot. Only the network
 * edges are stubbed: the prefs read, the critter read, and the two static release files. Every sibling
 * file stubs one dot or both to a testid or to nothing, which is why none of them could see a dot
 * land on the wrong element.
 *
 * Every case names the mutation that reds it; they were run, not assumed.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'

const { prefsRef, crittersRef, fetchPrefsSpy, getToken } = vi.hoisted(() => {
  const prefsRef = { current: null }
  return {
    prefsRef,
    crittersRef: { current: [] },
    fetchPrefsSpy: vi.fn(async () => prefsRef.current),
    // One function for the whole file: both dots key their effects on getToken's identity.
    getToken: () => Promise.resolve('t'),
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
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: () => Promise.resolve(null), getToken }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: fetchPrefsSpy,
  saveMorePins: vi.fn(async () => ({ ok: true })),
  saveWhatsNewSeen: vi.fn(),
}))
vi.mock('../lib/critterClient.js', async (orig) => ({
  ...(await orig()),
  fetchActiveCritters: vi.fn(async () => crittersRef.current),
}))

import BottomNav from '../components/BottomNav.jsx'
import ReleaseNotes from '../pages/ReleaseNotes.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider } from '../context/NavPrefsContext.jsx'
import { MORE_ROWS, ADORNMENT_IN_MORE, rowEnabled } from '../lib/moreRegistry.js'
import { writeSeen, readSeen } from '../lib/whatsNew.js'

const LATEST = '9.9.9'
const visitor = (over = {}) => ({
  id: 'c1', species_id: 3, viewed_at: null,
  dot_visible_after: new Date(Date.now() - 3600_000).toISOString(), ...over,
})

const CRITTER_DOT = '[data-testid="bottom-nav-dot"]'
const WHATSNEW_DOT = '[data-whatsnew-dot]'
const ANY_DOT = `${CRITTER_DOT}, ${WHATSNEW_DOT}`

const nav = () => screen.getByLabelText('Main navigation')
const moreButton = () => screen.getByRole('button', { name: 'More navigation options' })
const slot = (href) => nav().querySelector(`a[href="${href}"]`)
const openMore = () => {
  fireEvent.click(moreButton())
  return screen.getByRole('dialog', { name: 'More navigation options' })
}
// Each nav child that holds a dot, by where it leads ('More' for the button): which dot, and whether
// it is showing. A What's-New dot is in the DOM only while unseen; the critter dot is always mounted
// and says so in data-visible.
const barDots = () => [...nav().children].flatMap(child => [...child.querySelectorAll(ANY_DOT)].map(dot => ({
  on: child.getAttribute('href') ?? 'More',
  dot: dot.matches(CRITTER_DOT) ? 'critter' : 'whatsNew',
  showing: dot.matches(CRITTER_DOT) ? dot.getAttribute('data-visible') === 'true' : true,
})))

// `order` undefined is the shipped bar (bar_layout NULL). Storage is cleared first so every render is
// a first launch and the stored layout applies at once. `unseen` leaves an older release marked seen
// on this device, which is the only state the What's-New dot shows in.
async function renderNav({ order, hidden = [], unseen = false, visitors = [] } = {}) {
  localStorage.clear()
  if (unseen) writeSeen('1.0.0')
  crittersRef.current = visitors
  prefsRef.current = { bar_layout: order ? { order, hidden } : null, more_pins: null, can_edit_bar: false }
  let view
  await act(async () => {
    view = render(<PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider>)
  })
  return view
}

beforeEach(() => {
  fetchPrefsSpy.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).startsWith('/releases-latest.json')
      ? { version: LATEST }
      : [{ version: LATEST, date: '2026-10-01', highlights: ['A thing'] }]),
  })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Release Notes — the What’s-New dot is wherever the page is', () => {
  // KILLING MUTATION: barSlotRow drops `adornment` (the shape shipped in v4.168.0), or the bar slot
  // does not draw it. RESULT: RED — Releases on the bar shows no dot anywhere.
  it('on the bar + an unseen release: the dot is on the Releases tab, and no row carries one', async () => {
    await renderNav({ order: ['today', 'garden', 'create', 'releases'], unseen: true })
    await waitFor(() => expect(slot('/releases').querySelector(WHATSNEW_DOT)).not.toBeNull())
    expect(barDots().filter(d => d.dot === 'whatsNew')).toEqual([{ on: '/releases', dot: 'whatsNew', showing: true }])
    // The row is gone from the sheet (one door per page), so no dot is left behind there.
    const sheet = openMore()
    expect(sheet.querySelector('[data-more-row="releases"]')).toBeNull()
    expect(sheet.querySelector(WHATSNEW_DOT)).toBeNull()
    expect(sheet.querySelector('[data-more-row="about"]')).not.toBeNull()   // the sheet is drawing
  })

  // AS TODAY — green before and after this change. KILLING MUTATION: RowContent stops drawing a
  // row's adornment. RESULT: RED.
  it('in More + an unseen release: the dot is on the Release Notes row, and nowhere on the bar', async () => {
    await renderNav({ unseen: true })
    const sheet = openMore()
    const row = sheet.querySelector('[data-more-row="releases"] a[href="/releases"]')
    await waitFor(() => expect(row.querySelector(WHATSNEW_DOT)).not.toBeNull())
    expect(sheet.querySelectorAll(WHATSNEW_DOT)).toHaveLength(1)
    expect(nav().querySelector(WHATSNEW_DOT)).toBeNull()
  })

  it('on the bar with nothing unseen: no dot', async () => {
    await renderNav({ order: ['today', 'garden', 'create', 'releases'], unseen: false })
    await waitFor(() => expect(readSeen()).toBe(LATEST))   // the hook's first-run write: it has settled
    expect(document.querySelector(WHATSNEW_DOT)).toBeNull()
  })

  // What clears it is unchanged: the Release Notes page marks the newest release seen when it loads
  // (writeSeen → SEEN_EVENT), whichever door opened it. The REAL page is rendered here.
  it('on the bar: opening Release Notes clears the tab’s dot', async () => {
    await renderNav({ order: ['today', 'garden', 'create', 'releases'], unseen: true })
    await waitFor(() => expect(slot('/releases').querySelector(WHATSNEW_DOT)).not.toBeNull())
    await act(async () => { render(<ReleaseNotes />) })
    await waitFor(() => expect(readSeen()).toBe(LATEST))
    await waitFor(() => expect(document.querySelector(WHATSNEW_DOT)).toBeNull())
  })
})

describe('Critters — the new-visitor dot is wherever the page is', () => {
  // KILLING MUTATION: the bar slot does not draw its row's adornment. RESULT: RED (no dot on the tab).
  // KILLING MUTATION — THE MORE-BUTTON EXCLUSION: moreButtonAdornments ignores `onBar` (or BottomNav
  // goes back to an unconditional <BottomNavDot /> on More). RESULT: RED — two dots, one on More for a
  // page that is not in More.
  it('on the bar + a new visitor: the dot is on the Critters tab and NOT on the More button', async () => {
    await renderNav({ order: ['today', 'garden', 'create', 'collection'], visitors: [visitor()] })
    await waitFor(() => expect(slot('/collection').querySelector(CRITTER_DOT)?.getAttribute('data-visible')).toBe('true'))
    expect(moreButton().querySelector(ANY_DOT)).toBeNull()
    expect(barDots()).toEqual([{ on: '/collection', dot: 'critter', showing: true }])
  })

  // AS TODAY — green before and after this change. KILLING MUTATION: the More button draws no dot.
  // RESULT: RED.
  it('in More + a new visitor: the dot is on the More button, and on no tab', async () => {
    await renderNav({ visitors: [visitor()] })
    await waitFor(() => expect(moreButton().querySelector(CRITTER_DOT)?.getAttribute('data-visible')).toBe('true'))
    expect(barDots()).toEqual([{ on: 'More', dot: 'critter', showing: true }])
    // And not on the Critters row either: in More this dot has only ever lived on the button.
    expect(openMore().querySelector(ANY_DOT)).toBeNull()
  })

  // A tab moved INTO More is drawn there too; it must not be mistaken for a reason to dot More.
  it('with a tab moved into More as well: still no dot on the More button', async () => {
    await renderNav({ order: ['today', 'create', 'garden', 'collection'], hidden: ['garden'], visitors: [visitor()] })
    await waitFor(() => expect(slot('/collection').querySelector(CRITTER_DOT)?.getAttribute('data-visible')).toBe('true'))
    expect(slot('/garden')).toBeNull()
    expect(moreButton().querySelector(ANY_DOT)).toBeNull()
  })

  // What clears it is unchanged, and it is NOT opening Critters: Garden marks visitors viewed when it
  // is left (Garden.jsx flushSeen), and the dot re-reads on mount, on return to the foreground and each
  // minute. Same component on the tab, so the same re-read clears it there.
  it('on the bar: the dot goes once the visitor has been viewed', async () => {
    await renderNav({ order: ['today', 'garden', 'create', 'collection'], visitors: [visitor()] })
    const dot = () => slot('/collection').querySelector(CRITTER_DOT)
    await waitFor(() => expect(dot().getAttribute('data-visible')).toBe('true'))
    crittersRef.current = [visitor({ viewed_at: new Date().toISOString() })]
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(dot().getAttribute('data-visible')).toBe('false'))
  })
})

describe('both on the bar', () => {
  it('each tab carries its own dot and the More button carries none', async () => {
    await renderNav({ order: ['today', 'create', 'collection', 'releases'], unseen: true, visitors: [visitor()] })
    await waitFor(() => expect(barDots().filter(d => d.showing)).toHaveLength(2))
    expect(barDots()).toEqual([
      { on: '/collection', dot: 'critter', showing: true },
      { on: '/releases', dot: 'whatsNew', showing: true },
    ])
  })

  // The generic half: EVERY row that declares a dot, not the two named above. A third adornment added
  // to the registry with no dot wired for it reds here.
  it('SWEEP: every More row that declares an adornment draws a dot on its slot', async () => {
    const adorned = MORE_ROWS.filter(r => rowEnabled(r) && r.adornment)
    expect(adorned.map(r => r.id).sort()).toEqual(['collection', 'releases'])
    for (const row of adorned) {
      expect(Object.keys(ADORNMENT_IN_MORE), row.id).toContain(row.adornment)
      const view = await renderNav({ order: ['today', 'create', row.id], unseen: true, visitors: [visitor()] })
      await waitFor(() => expect(barDots().filter(d => d.on === row.to && d.showing), row.id).toHaveLength(1))
      view.unmount()
    }
  })
})

describe('the dot is ambient and costs the slot nothing (Reward UX)', () => {
  // The bar is six 53px slots at 320px. A dot in the flow would widen its slot or push the label; the
  // More button's dot never did because it is absolutely positioned, and the slot's dot is the same.
  it('is out of the flow inside a positioned slot, hidden from assistive tech, and carries no text', async () => {
    await renderNav({ order: ['today', 'create', 'collection', 'releases'], unseen: true, visitors: [visitor()] })
    await waitFor(() => expect(barDots().filter(d => d.showing)).toHaveLength(2))
    const critter = slot('/collection').querySelector(CRITTER_DOT)
    const whatsNew = slot('/releases').querySelector(WHATSNEW_DOT)
    // The out-of-flow box: the critter dot is its own; the What's-New dot's is the span around it.
    for (const [name, box, host] of [['critter', critter, slot('/collection')], ['whatsNew', whatsNew.parentElement, slot('/releases')]]) {
      expect(box.style.position, name).toBe('absolute')
      expect(box.parentElement, name).toBe(host)
      expect(host.style.position, name).toBe('relative')
    }
    for (const dot of [critter, whatsNew]) {
      expect(dot.getAttribute('aria-hidden')).toBe('true')
      expect(dot.textContent).toBe('')            // never a count
    }
    // The tab is still named by its label alone, and nothing else was added to the slot.
    expect(screen.getByRole('link', { name: 'Releases' })).toBe(slot('/releases'))
    expect(screen.getByRole('link', { name: 'Critters' })).toBe(slot('/collection'))
    expect(document.querySelector('[role="status"], [role="alert"], [role="dialog"]')).toBeNull()
  })
})

// THE SHIPPED LAYOUT DRAWS THE SAME DOTS AS PROD. The literals below are the markup rendered at
// eee5d600 (v4.168.0), captured by running this case against that commit before the change — not this
// change's own render. Green before and after. KILLING MUTATION: restyle either dot in its More home,
// move the critter dot off the More button, or add a dot to any shipped tab. RESULT: RED.
describe('the shipped layout — the same dots as v4.168.0, byte for byte', () => {
  const MORE_BUTTON_DOT = '<span aria-hidden="true" data-testid="bottom-nav-dot" data-visible="true" style="position: absolute; top: 4px; right: calc(50% - 14px); width: 7px; height: 7px; border-radius: 50%; background-color: rgb(181, 160, 74); opacity: 1; transition: opacity 300ms ease-out; pointer-events: none;"></span>'
  const RELEASE_ROW_DOT = '<span style="display: inline-flex; align-items: center; margin-left: 8px;"><style>@keyframes whatsnew-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.6}}\n@media (prefers-reduced-motion: reduce){[data-whatsnew-dot]{animation:none!important}}</style><span data-whatsnew-dot="true" aria-hidden="true" style="display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: rgb(183, 83, 42); box-shadow: 0 0 0 2px rgba(255,255,255,0.92); animation: whatsnew-pulse 1.8s ease-in-out infinite;"></span></span>'

  it('one critter dot on More, one What’s-New dot on the Release Notes row, nothing else', async () => {
    await renderNav({ unseen: true, visitors: [visitor()] })
    await waitFor(() => expect(moreButton().querySelector(CRITTER_DOT)?.getAttribute('data-visible')).toBe('true'))
    expect(barDots()).toEqual([{ on: 'More', dot: 'critter', showing: true }])
    expect(moreButton().lastElementChild.outerHTML).toBe(MORE_BUTTON_DOT)

    const sheet = openMore()
    await waitFor(() => expect(sheet.querySelector(WHATSNEW_DOT)).not.toBeNull())
    const dots = [...sheet.querySelectorAll(ANY_DOT)]
    expect(dots).toHaveLength(1)
    expect(dots[0].closest('[data-more-row]').getAttribute('data-more-row')).toBe('releases')
    expect(dots[0].parentElement.outerHTML).toBe(RELEASE_ROW_DOT)
  })
})
