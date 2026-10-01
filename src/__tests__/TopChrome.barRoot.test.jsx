/**
 * src/__tests__/TopChrome.barRoot.test.jsx
 *
 * V5-NAVANYSLOT-001 — THE HEADER FOLLOWS THE PERSON'S BAR (Dave, 2026-10-01: "follow my bar").
 * A More page carries no Back arrow only while it is on your bar; opened from the More sheet it
 * keeps Back. routeClass.test.js pins the rule as a function; this file pins that it is WIRED, and
 * that the header and the bar read ONE value.
 *
 * Driven through the real chain — PrefsProvider → NavPrefsProvider → TopChrome and BottomNav, side by
 * side as App.jsx mounts them — with only the network edge stubbed. Stubbing useNavLayout would turn
 * every case into an assertion about the stub, and would hide the one failure this file exists for:
 * a header that learns the bar by a different road than the bar itself.
 *
 * THE WITNESS. Every commit in which the nav state or the shell changed is photographed after its DOM
 * is written: is this page's slot on the bar, and does the header carry Back? Signed in, those two
 * must be opposites in EVERY photograph — never a frame with the Season tab drawn and a Back arrow
 * above it. KILLING MUTATION: have TopChrome copy the bar into its own state from an effect.
 * RESULT: RED — one photograph shows the tab and the arrow together.
 */
import React, { useLayoutEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const { authRef, fetchPrefsSpy } = vi.hoisted(() => ({
  authRef: { current: { user: { id: 'dave' }, loading: false } },
  fetchPrefsSpy: vi.fn(),
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ ...authRef.current, profile: { display_name: 'Dave' }, signOut: vi.fn() }),
}))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: () => Promise.resolve(null), getToken: () => Promise.resolve('t') }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: fetchPrefsSpy,
  saveMorePins: vi.fn(async () => ({ ok: true })),
}))

import TopChrome from '../components/TopChrome.jsx'
import BottomNav from '../components/BottomNav.jsx'
import Settings from '../pages/Settings.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider, useNavLayout, BAR_LAYOUT_CACHE_KEY } from '../context/NavPrefsContext.jsx'
import { SLOT_LANDS_ON } from '../lib/routeClass.js'

const SEASON_BAR = { order: ['today', 'garden', 'create', 'put-up', 'season-end'], hidden: [] }
const prefs = (barLayout) => ({ bar_layout: barLayout, more_pins: null, can_edit_bar: true })
const cache = (layout, userId = 'dave') => localStorage.setItem(BAR_LAYOUT_CACHE_KEY, JSON.stringify({ userId, layout, canEdit: true }))

const back = () => screen.queryByTestId('topbar-back')
const nav = () => screen.queryByLabelText('Main navigation')
const tabTo = (path) => nav()?.querySelector(`a[href="${path}"]`) ?? null
const barLabels = () => [...nav().querySelectorAll('a[href]')].map(a => a.textContent)

// One photograph per commit (see the header). It consumes the nav context, so it re-renders — and its
// layout effect runs — in the very commit that re-lays the bar.
const photos = []
function Witness({ path }) {
  useNavLayout()
  const { user } = useAuth()
  useLayoutEffect(() => {
    photos.push({ signedIn: !!user, slot: !!tabTo(path), back: !!back() })
  })
  return null
}
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

// The shell as App.jsx mounts it: the header always, the bar only once somebody is signed in.
function Shell({ path }) {
  const { user } = useAuth()
  return (
    <>
      <TopChrome />
      <Routes>
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Where />} />
      </Routes>
      {user && <BottomNav />}
      <Witness path={path} />
    </>
  )
}
const tree = (path) => (
  <PrefsProvider><NavPrefsProvider>
    <MemoryRouter initialEntries={[path]}><Shell path={path} /></MemoryRouter>
  </NavPrefsProvider></PrefsProvider>
)
async function open(path) {
  let view
  await act(async () => { view = render(tree(path)) })
  return view
}
const agreed = () => photos.filter(p => p.signedIn).every(p => p.slot !== p.back)

beforeEach(() => {
  localStorage.clear()
  photos.length = 0
  authRef.current = { user: { id: 'dave' }, loading: false }
  fetchPrefsSpy.mockReset().mockResolvedValue(prefs(null))
})
afterEach(cleanup)

describe('TopChrome — a More page on the bar carries no Back; off the bar it keeps it', () => {
  // RED before this change: /season-end resolved to 'detail' whatever the bar held.
  it('Season on the bar → no Back button on /season-end', async () => {
    fetchPrefsSpy.mockResolvedValue(prefs(SEASON_BAR))
    await open('/season-end')
    expect(tabTo('/season-end').textContent).toBe('Season')
    expect(back()).toBeNull()
    expect(screen.queryByLabelText('Back')).toBeNull()
    // The rest of the header is untouched: the three actions are all still there.
    for (const id of ['topchrome-snap', 'topchrome-harvest', 'topchrome-search']) expect(screen.getByTestId(id)).toBeTruthy()
    expect(agreed()).toBe(true)
  })

  it('Season NOT on the bar → Back button present on /season-end', async () => {
    await open('/season-end')
    expect(tabTo('/season-end')).toBeNull()
    expect(back().getAttribute('aria-label')).toBe('Back')
    expect(agreed()).toBe(true)
  })

  // A slot makes its own page root, never the pages pushed from it.
  it('Inventory on the bar: /inventory has no Back, /inventory/abc keeps it', async () => {
    fetchPrefsSpy.mockResolvedValue(prefs({ order: ['today', 'create', 'inventory'], hidden: [] }))
    const first = await open('/inventory')
    expect(back()).toBeNull()
    first.unmount()
    localStorage.clear()
    await open('/inventory/abc')
    expect(tabTo('/inventory')).not.toBeNull()
    expect(back()).not.toBeNull()
  })

  // /settings only redirects, so a Settings slot OPENS /settings/notifications. The real redirect is
  // rendered here so SLOT_LANDS_ON cannot drift from the page it describes.
  it('Settings on the bar: the page its slot lands on has no Back; Controls keeps it', async () => {
    fetchPrefsSpy.mockResolvedValue(prefs({ order: ['today', 'create', 'settings'], hidden: [] }))
    const first = await open('/settings')
    expect(screen.getByTestId('where').textContent).toBe(SLOT_LANDS_ON['/settings'])
    expect(back()).toBeNull()
    first.unmount()
    localStorage.clear()
    await open('/settings/controls')
    expect(tabTo('/settings')).not.toBeNull()
    expect(back()).not.toBeNull()
  })
})

// What a person sees on a cold launch straight onto a More page that is on their bar.
describe('TopChrome — cold launch onto a slotted More page: the header moves only with the bar', () => {
  const signIn = (view, path) => act(async () => {
    authRef.current = { user: { id: 'dave' }, loading: false }
    view.rerender(tree(path))
  })

  // (a) WARM CACHE. The bar is drawn from the launch cache on the first signed-in frame, and the
  // header is root on that same frame. Nothing moves when prefs land — not even when the server now
  // holds a different bar, which waits for the next launch exactly as the bar itself does.
  it('(a) warm cache: no Back from the first signed-in frame, and none when prefs land', async () => {
    cache(SEASON_BAR)
    authRef.current = { user: null, loading: true }
    let land
    fetchPrefsSpy.mockReturnValue(new Promise(r => { land = r }))
    const view = await open('/season-end')
    // Identity unresolved: the pending header (no Back, no actions) and no bar at all.
    expect(document.querySelector('header').getAttribute('data-chrome-state')).toBe('pending')
    expect(back()).toBeNull()
    expect(nav()).toBeNull()

    await signIn(view, '/season-end')
    expect(barLabels()).toEqual(['Today', 'Garden', 'Put-Up', 'Season'])
    expect(back()).toBeNull()
    const beforeLanding = photos.filter(p => p.signedIn).length
    expect(beforeLanding).toBeGreaterThanOrEqual(1)
    expect(photos.filter(p => p.signedIn).every(p => p.slot && !p.back)).toBe(true)

    // Another device took Season off the bar. This session keeps the bar it launched with.
    await act(async () => { land(prefs(null)) })
    expect(barLabels()).toEqual(['Today', 'Garden', 'Put-Up', 'Season'])
    expect(back()).toBeNull()
    expect(photos.filter(p => p.signedIn).every(p => p.slot && !p.back)).toBe(true)
    expect(JSON.parse(localStorage.getItem(BAR_LAYOUT_CACHE_KEY)).layout).toBeNull()   // next launch
  })

  // (b) EMPTY CACHE. The first signed-in frame is the shipped bar, so /season-end is a page reached
  // from More and has Back. When prefs land the bar re-lays ONCE (the first-launch rule) and the arrow
  // leaves in that same commit.
  it('(b) empty cache: Back with the shipped bar, gone in the commit that draws the Season tab', async () => {
    authRef.current = { user: null, loading: true }
    let land
    fetchPrefsSpy.mockReturnValue(new Promise(r => { land = r }))
    const view = await open('/season-end')
    await signIn(view, '/season-end')
    expect(barLabels()).toEqual(['Today', 'Garden', 'Harvests', 'Put-Up'])
    expect(back()).not.toBeNull()

    await act(async () => { land(prefs(SEASON_BAR)) })
    expect(barLabels()).toEqual(['Today', 'Garden', 'Put-Up', 'Season'])
    expect(back()).toBeNull()

    const seen = photos.filter(p => p.signedIn)
    expect(agreed()).toBe(true)
    // Exactly one change, in one direction: Back-with-no-slot, then slot-with-no-Back.
    const states = seen.map(p => (p.slot ? 'slot' : 'back'))
    expect(states[0]).toBe('back')
    expect(states.at(-1)).toBe('slot')
    expect(states.filter((s, i) => i > 0 && s !== states[i - 1])).toHaveLength(1)
  })

  // (b), the read that never answers usefully: the bar stays shipped, so the header keeps Back.
  it('(b) empty cache and a failed prefs read: the shipped bar and Back both stand', async () => {
    fetchPrefsSpy.mockResolvedValue(null)
    await open('/season-end')
    expect(barLabels()).toEqual(['Today', 'Garden', 'Harvests', 'Put-Up'])
    expect(back()).not.toBeNull()
    expect(agreed()).toBe(true)
  })

  // Somebody else's cache is no cache — for the header exactly as for the bar.
  it('another person’s launch cache gives the header nothing', async () => {
    cache(SEASON_BAR, 'jen')
    fetchPrefsSpy.mockReturnValue(new Promise(() => {}))
    await open('/season-end')
    expect(tabTo('/season-end')).toBeNull()
    expect(back()).not.toBeNull()
    expect(agreed()).toBe(true)
  })
})
