/**
 * src/__tests__/NavPrefsContext.test.jsx
 *
 * V5-NAVCUSTOM-001 — the per-person bar and pins, their launch caches, and the pin save's
 * keep / retry / roll-back rules. Driven through the REAL PrefsProvider with only the network edge
 * stubbed (fetchNotificationPrefs, saveMorePins), so what is asserted is what BottomNav and the
 * editor will actually read.
 *
 * Each case names the mutation (to src/context/NavPrefsContext.jsx) that turns it red.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { userRef, fetchPrefsSpy, saveSpy } = vi.hoisted(() => ({
  userRef: { current: { id: 'dave' } },
  fetchPrefsSpy: vi.fn(),
  saveSpy: vi.fn(),
}))

vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: userRef.current }) }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(), getToken: () => Promise.resolve('t') }),
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: fetchPrefsSpy,
  saveMorePins: saveSpy,
}))

import { PrefsProvider, usePrefs } from '../context/PrefsContext.jsx'
import {
  NavPrefsProvider, useNavLayout, useMorePins,
  BAR_LAYOUT_CACHE_KEY, MORE_PINS_CACHE_KEY, MORE_PINS_PENDING_KEY,
} from '../context/NavPrefsContext.jsx'

const DEFAULT_BAR = 'today,garden,create,harvests,put-up'
const read = (k) => JSON.parse(localStorage.getItem(k) ?? 'null')
const seed = (k, v) => localStorage.setItem(k, JSON.stringify(v))
// The launch caches' stamped shapes (NavPrefsContext.jsx header). Every entry carries its owner.
const ME = 'dave'
const barCache = (layout, canEdit = false, userId = ME) => ({ userId, layout, canEdit })
const pinsCache = (pins, userId = ME) => ({ userId, pins })

// A probe that exposes the hooks' state as text and their functions through a ref.
const api = { current: null }
function Probe() {
  const nav = useNavLayout()
  const pins = useMorePins()
  const { refreshPrefs } = usePrefs()
  api.current = { ...nav, ...pins, refreshPrefs }
  return (
    <div>
      <span data-testid="bar">{nav.bar.map(t => t.key).join(',')}</span>
      <span data-testid="moved">{nav.moved.join(',')}</span>
      <span data-testid="edit">{String(nav.canEditBar)}</span>
      <span data-testid="pins">{pins.pins.join(',')}</span>
      <span data-testid="pending">{String(pins.pending)}</span>
    </div>
  )
}
const text = (id) => screen.getByTestId(id).textContent

function tree() {
  return <PrefsProvider><NavPrefsProvider><Probe /></NavPrefsProvider></PrefsProvider>
}
// Render and let the boot read land.
async function boot() {
  let view
  await act(async () => { view = render(tree()) })
  return view
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  userRef.current = { id: 'dave' }
  fetchPrefsSpy.mockReset().mockResolvedValue({ bar_layout: null, more_pins: null, can_edit_bar: false })
  saveSpy.mockReset().mockResolvedValue({ ok: true })
})

describe('the bar — first paint, landing, and the next launch', () => {
  // KILLING MUTATION: seed barRaw from null instead of the cache. RESULT: RED — the first frame is the
  // shipped bar and the saved one arrives later: the re-layout under a thumb this cache exists to stop.
  it('the FIRST paint draws the cached bar, before prefs have answered', () => {
    seed(BAR_LAYOUT_CACHE_KEY, barCache({ order: ['harvests', 'today', 'create', 'garden', 'put-up'], hidden: ['put-up'] }, true))
    fetchPrefsSpy.mockReturnValue(new Promise(() => {}))   // prefs never land
    render(tree())
    expect(text('bar')).toBe('harvests,today,create,garden')
    expect(text('moved')).toBe('put-up')
    expect(text('edit')).toBe('true')
  })

  // KILLING MUTATION: apply every landing at once (drop the hadBarCache check). RESULT: RED.
  it('with a cache at launch, a NEW server value waits for the next launch — but is cached now', async () => {
    seed(BAR_LAYOUT_CACHE_KEY, barCache(null, false))
    fetchPrefsSpy.mockResolvedValue({ bar_layout: { order: ['today', 'create', 'garden', 'harvests', 'put-up'], hidden: ['garden'] }, more_pins: null, can_edit_bar: true })
    await boot()
    expect(text('bar')).toBe(DEFAULT_BAR)                       // unchanged this session
    expect(read(BAR_LAYOUT_CACHE_KEY)).toEqual(barCache({ order: ['today', 'create', 'garden', 'harvests', 'put-up'], hidden: ['garden'] }, true))
    expect(text('edit')).toBe('true')                           // the editor flag is live, not a layout
  })

  // KILLING MUTATION: never apply a landing (drop the first-launch branch). RESULT: RED.
  it('with NO cache at launch (first launch after sign-in), the server value applies at once', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: { order: [...DEFAULT_BAR.split(',')], hidden: ['harvests'] }, more_pins: null, can_edit_bar: false })
    await boot()
    expect(text('bar')).toBe('today,garden,create,put-up')
    expect(text('moved')).toBe('harvests')
    expect(read(BAR_LAYOUT_CACHE_KEY).layout.hidden).toEqual(['harvests'])
  })

  // KILLING MUTATION: drop `!cur.barAdopted`. RESULT: RED — a later refresh from any surface would
  // re-lay the bar out mid-session.
  it('applies at once only ONCE: a later refresh from another surface does not re-lay the bar', async () => {
    fetchPrefsSpy.mockResolvedValueOnce({ bar_layout: null, more_pins: null, can_edit_bar: false })
    await boot()
    fetchPrefsSpy.mockResolvedValueOnce({ bar_layout: { order: [...DEFAULT_BAR.split(',')], hidden: ['put-up'] }, more_pins: null, can_edit_bar: false })
    await act(async () => { await api.current.refreshPrefs() })
    expect(text('bar')).toBe(DEFAULT_BAR)
    expect(read(BAR_LAYOUT_CACHE_KEY).layout.hidden).toEqual(['put-up'])   // the next launch gets it
  })

  // KILLING MUTATION: make applyLayout write the cache but not commit. RESULT: RED.
  it('applyLayout — the editor’s own Save — applies at once and becomes the cache', async () => {
    seed(BAR_LAYOUT_CACHE_KEY, barCache(null, true))
    await boot()
    const layout = { order: ['garden', 'today', 'create', 'harvests', 'put-up'], hidden: ['put-up'] }
    act(() => { api.current.applyLayout(layout) })
    expect(text('bar')).toBe('garden,today,create,harvests')
    expect(read(BAR_LAYOUT_CACHE_KEY).layout).toEqual(layout)
  })

  it('a malformed cache is no cache: shipped first paint, then the server value applies at once', async () => {
    localStorage.setItem(BAR_LAYOUT_CACHE_KEY, '{not json')
    fetchPrefsSpy.mockResolvedValue({ bar_layout: { order: [...DEFAULT_BAR.split(',')], hidden: ['garden'] }, more_pins: null, can_edit_bar: false })
    await boot()
    expect(text('bar')).toBe('today,create,harvests,put-up')
  })

  it('a failed prefs read changes nothing: the cached bar stands and the cache is not overwritten', async () => {
    const cached = barCache({ order: [...DEFAULT_BAR.split(',')], hidden: ['put-up'] }, true)
    seed(BAR_LAYOUT_CACHE_KEY, cached)
    fetchPrefsSpy.mockResolvedValue(null)
    await boot()
    expect(text('bar')).toBe('today,garden,create,harvests')
    expect(read(BAR_LAYOUT_CACHE_KEY)).toEqual(cached)
    expect(text('edit')).toBe('true')
  })

  // KILLING MUTATION: canEditBar = cachedCanEdit only (ignore the server). RESULT: RED — Dave's
  // editor door would stay open after the server withdrew it (or closed after it granted it).
  it('can_edit_bar comes from the server once it answers, and is false by default', async () => {
    seed(BAR_LAYOUT_CACHE_KEY, barCache(null, true))
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: null, can_edit_bar: false })
    await boot()
    expect(text('edit')).toBe('false')
  })

  it('an old Lambda that sends no bar_layout or can_edit_bar reads as the shipped bar and no editor', async () => {
    fetchPrefsSpy.mockResolvedValue({ critter_visit: 'in_app_only' })
    await boot()
    expect(text('bar')).toBe(DEFAULT_BAR)
    expect(text('edit')).toBe('false')
  })

  it('reads prefs ONCE for the tree — the provider adds no request of its own', async () => {
    await boot()
    expect(fetchPrefsSpy).toHaveBeenCalledTimes(1)
  })
})

describe('pins — optimistic, durable, and rolled back only on a refusal', () => {
  it('first paint draws the cached pins; a landing with nothing local adopts the server list', async () => {
    seed(MORE_PINS_CACHE_KEY, pinsCache(['photos']))
    fetchPrefsSpy.mockReturnValue(new Promise(() => {}))
    const view = render(tree())
    expect(text('pins')).toBe('photos')
    view.unmount()
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['seeds', 'sow', 'future-row'], can_edit_bar: false })
    await boot()
    // resolvePins ran: 'sow' collapsed into 'seeds', the unknown id was KEPT.
    expect(text('pins')).toBe('seeds,future-row')
    expect(read(MORE_PINS_CACHE_KEY)).toEqual(pinsCache(['seeds', 'future-row']))
  })

  // KILLING MUTATION: await the save before committing the new list. RESULT: RED — the button would
  // wait on the network.
  it('a tap pins at once, before the save answers, and sends the WHOLE list including unknown ids', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['future-row'], can_edit_bar: false })
    await boot()
    let release
    saveSpy.mockReturnValue(new Promise(r => { release = r }))
    let outcome
    act(() => { api.current.togglePin('seeds').then(o => { outcome = o }) })
    expect(text('pins')).toBe('future-row,seeds')
    expect(api.current.isPinned('seeds')).toBe(true)
    expect(saveSpy.mock.calls[0][0].ids).toEqual(['future-row', 'seeds'])
    await act(async () => { release({ ok: true }) })
    expect(outcome).toBe('pinned')
    expect(text('pending')).toBe('false')
    expect(localStorage.getItem(MORE_PINS_PENDING_KEY)).toBeNull()
  })

  // U4 at the hook: the last unpin sends []. KILLING MUTATION: skip the save when the list empties.
  it('unpinning the last pin sends an empty list', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['seeds'], can_edit_bar: false })
    await boot()
    let outcome
    await act(async () => { outcome = await api.current.togglePin('seeds') })
    expect(outcome).toBe('unpinned')
    expect(saveSpy.mock.calls[0][0].ids).toEqual([])
    expect(text('pins')).toBe('')
  })

  // KILLING MUTATION: treat status 0 as a refusal (roll back). RESULT: RED — an offline pin vanishes.
  it('offline (status 0): the pin STAYS, marked pending, and is re-sent on the online event', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: [], can_edit_bar: false })
    await boot()
    saveSpy.mockResolvedValueOnce({ ok: false, status: 0 })
    let outcome
    await act(async () => { outcome = await api.current.togglePin('photos') })
    expect(outcome).toBe('pinned')
    expect(text('pins')).toBe('photos')
    expect(text('pending')).toBe('true')
    expect(read(MORE_PINS_PENDING_KEY)).toBe(ME)
    expect(read(MORE_PINS_CACHE_KEY)).toEqual(pinsCache(['photos']))
    // KILLING MUTATION (this half): drop the onReconnect subscription. RESULT: RED — never re-sent.
    saveSpy.mockResolvedValueOnce({ ok: true })
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(saveSpy.mock.calls[1][0].ids).toEqual(['photos'])
    expect(text('pending')).toBe('false')
    expect(localStorage.getItem(MORE_PINS_PENDING_KEY)).toBeNull()
  })

  it('a 5xx is not a refusal either: kept and pending', async () => {
    await boot()
    saveSpy.mockResolvedValueOnce({ ok: false, status: 503 })
    await act(async () => { await api.current.togglePin('photos') })
    expect(text('pins')).toBe('photos')
    expect(text('pending')).toBe('true')
  })

  // KILLING MUTATION: keep the pin on a 4xx. RESULT: RED — a refused list would sit on this phone
  // disagreeing with the server until the next launch quietly reversed it.
  it('a refusal (4xx) rolls back to the last server-confirmed list and reports error', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['seeds'], can_edit_bar: false })
    await boot()
    saveSpy.mockResolvedValueOnce({ ok: false, status: 400 })
    let outcome
    await act(async () => { outcome = await api.current.togglePin('photos') })
    expect(outcome).toBe('error')
    expect(text('pins')).toBe('seeds')
    expect(text('pending')).toBe('false')
    expect(read(MORE_PINS_CACHE_KEY)).toEqual(pinsCache(['seeds']))
    expect(localStorage.getItem(MORE_PINS_PENDING_KEY)).toBeNull()
  })

  // KILLING MUTATION: drop the drawn-pin cap check. RESULT: RED — a fifth pin is saved.
  it('a fifth drawn pin is refused as full, with nothing saved and nothing changed', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['seeds', 'photos', 'admin', 'about'], can_edit_bar: false })
    await boot()
    let outcome
    await act(async () => { outcome = await api.current.togglePin('helper') })
    expect(outcome).toBe('full')
    expect(saveSpy).not.toHaveBeenCalled()
    expect(text('pins')).toBe('seeds,photos,admin,about')
  })

  it('a SLEEPING pin does not count toward the four', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['future-row', 'seeds', 'photos', 'admin'], can_edit_bar: false })
    await boot()
    let outcome
    await act(async () => { outcome = await api.current.togglePin('about') })
    expect(outcome).toBe('pinned')
  })

  // The launch re-send does not wait for prefs: a slow or failed GET must not strand the pin.
  // KILLING MUTATION: drop the [s.epoch] launch effect (leaving only the on-landing re-send).
  // RESULT: RED — with prefs never answering, nothing is sent.
  it('a pending list is re-sent at launch even when prefs never answer', async () => {
    seed(MORE_PINS_CACHE_KEY, pinsCache(['photos']))
    seed(MORE_PINS_PENDING_KEY, ME)
    fetchPrefsSpy.mockReturnValue(new Promise(() => {}))
    await act(async () => { render(tree()) })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][0].ids).toEqual(['photos'])
    expect(text('pending')).toBe('false')
  })

  it('a list left pending by the last session is re-sent at launch, and the server copy does not overwrite it', async () => {
    seed(MORE_PINS_CACHE_KEY, pinsCache(['seeds', 'photos']))
    seed(MORE_PINS_PENDING_KEY, ME)
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['seeds'], can_edit_bar: false })
    await boot()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][0].ids).toEqual(['seeds', 'photos'])
    expect(text('pins')).toBe('seeds,photos')
    expect(text('pending')).toBe('false')
  })

  // THE STALE-READ RACE. A prefs GET issued before a pin's PATCH can land after it; folding it in
  // would un-pin what was just pinned. KILLING MUTATION: adopt the server list on every landing (drop
  // the `touched` guard). RESULT: RED.
  it('once pins are touched this session, a later prefs read never overwrites them', async () => {
    fetchPrefsSpy.mockResolvedValueOnce({ bar_layout: null, more_pins: [], can_edit_bar: false })
    await boot()
    await act(async () => { await api.current.togglePin('photos') })
    fetchPrefsSpy.mockResolvedValueOnce({ bar_layout: null, more_pins: [], can_edit_bar: false })  // stale
    await act(async () => { await api.current.refreshPrefs() })
    expect(text('pins')).toBe('photos')
  })

  it('two taps in one frame build on each other, and only the latest answer settles the list', async () => {
    await boot()
    const answers = []
    saveSpy.mockImplementation(() => new Promise(r => answers.push(r)))
    act(() => { api.current.togglePin('photos'); api.current.togglePin('seeds') })
    expect(text('pins')).toBe('photos,seeds')
    expect(saveSpy.mock.calls.map(c => c[0].ids)).toEqual([['photos'], ['photos', 'seeds']])
    // The OLDER save is refused after the newer one is sent: its answer must not roll anything back.
    await act(async () => { answers[0]({ ok: false, status: 400 }) })
    expect(text('pins')).toBe('photos,seeds')
    await act(async () => { answers[1]({ ok: true }) })
    expect(text('pins')).toBe('photos,seeds')
    expect(text('pending')).toBe('false')
  })

  it('rejects an id that is not an id, without saving', async () => {
    await boot()
    let outcome
    await act(async () => { outcome = await api.current.togglePin('Seeds') })
    expect(outcome).toBe('error')
    expect(saveSpy).not.toHaveBeenCalled()
  })
})

describe('a different person on the same phone', () => {
  // Sign-out clears the caches (CLIENT_PREF_KEYS) BEFORE Clerk signs out; the provider stays mounted
  // above the routes. KILLING MUTATION: drop the userId-change reset. RESULT: RED — Jen's first frame
  // would be Dave's bar and Dave's pins.
  it('starts from a clean launch, and never folds the previous person’s prefs into the new session', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: { order: [...DEFAULT_BAR.split(',')], hidden: ['put-up'] }, more_pins: ['seeds'], can_edit_bar: true })
    const view = await boot()
    expect(text('bar')).toBe('today,garden,create,harvests')
    expect(text('pins')).toBe('seeds')
    // Sign out: caches cleared, identity goes null, then Jen signs in.
    localStorage.clear()
    userRef.current = null
    await act(async () => { view.rerender(tree()) })
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: null, can_edit_bar: false })
    userRef.current = { id: 'jen' }
    await act(async () => { view.rerender(tree()) })
    expect(text('bar')).toBe(DEFAULT_BAR)
    expect(text('pins')).toBe('')
    expect(text('edit')).toBe('false')
  })
})

// QA IMPORTANT-2 + regression M5 — A PREFS BODY THAT IS NOT FRESH NEVER OVERWRITES WHAT THIS SESSION
// KNOWS. `fromSwCache` marks a body the way fetchNotificationPrefs marks one the service worker served
// from its cache (api.js's FROM_CACHE: a non-enumerable global-registry Symbol).
describe('a prefs body that is not fresh', () => {
  const FROM_CACHE = Symbol.for('garden-app.fromCache')
  const fromSwCache = (body) => Object.defineProperty(body, FROM_CACHE, { value: true, enumerable: false })
  const LAYOUT = { order: [...DEFAULT_BAR.split(',')], hidden: ['put-up'] }

  // The QA probe: Dave confirmed Seeds last session (cache ['seeds']); this launch's GET fails
  // outright and the SW answers with a body from before that pin.
  // KILLING MUTATION: drop the servedFromCache guard in the landing effect. RESULT: RED — Seeds
  // vanishes, the caches are rewritten, and the next pin PATCHes ['photos'] without Seeds.
  it('a body the SW served from its cache updates who may edit — and nothing else', async () => {
    seed(BAR_LAYOUT_CACHE_KEY, barCache(LAYOUT, false))
    seed(MORE_PINS_CACHE_KEY, pinsCache(['seeds']))
    fetchPrefsSpy.mockResolvedValue(fromSwCache({ bar_layout: null, more_pins: null, can_edit_bar: true }))
    await boot()
    expect(text('pins')).toBe('seeds')
    expect(text('bar')).toBe('today,garden,create,harvests')
    expect(text('edit')).toBe('true')                             // the one thing it may say
    expect(read(MORE_PINS_CACHE_KEY)).toEqual(pinsCache(['seeds']))
    expect(read(BAR_LAYOUT_CACHE_KEY)).toEqual(barCache(LAYOUT, false))
    await act(async () => { await api.current.togglePin('photos') })
    expect(saveSpy.mock.calls[0][0].ids).toEqual(['seeds', 'photos'])
  })

  // With no cache of its own, a stale body cannot become the base of a whole-list save either:
  // pinning then would replace the server's pins with a list built from nothing.
  // KILLING MUTATION: drop the pinsKnown guard in togglePin. RESULT: RED — ['photos'] is PATCHed.
  it('with no launch cache, a stale (or failed) read leaves pins unknown, and a tap saves nothing', async () => {
    fetchPrefsSpy.mockResolvedValue(fromSwCache({ bar_layout: LAYOUT, more_pins: ['seeds'], can_edit_bar: false }))
    const view = await boot()
    expect(text('pins')).toBe('')
    expect(text('bar')).toBe(DEFAULT_BAR)                          // not adopted either
    let outcome
    await act(async () => { outcome = await api.current.togglePin('photos') })
    expect(outcome).toBe('error')
    expect(saveSpy).not.toHaveBeenCalled()
    expect(localStorage.getItem(MORE_PINS_CACHE_KEY)).toBeNull()
    view.unmount()
    localStorage.clear()
    fetchPrefsSpy.mockResolvedValue(null)                          // a failed read, same rule
    await boot()
    await act(async () => { outcome = await api.current.togglePin('photos') })
    expect(outcome).toBe('error')
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('…and a FRESH read makes the list known: the next tap saves on top of the server’s list', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: ['seeds'], can_edit_bar: false })
    await boot()
    await act(async () => { await api.current.togglePin('photos') })
    expect(saveSpy.mock.calls[0][0].ids).toEqual(['seeds', 'photos'])
  })

  // Regression M5, the bar half: after this person's own Save (applyLayout), a later landing — the
  // editor's re-read joining a GET that left before the save — must not put the old bar in the cache.
  // KILLING MUTATION: drop the barTouched guard. RESULT: RED — the cache holds the pre-save layout and
  // the next launch draws the old bar.
  it('after applyLayout, a later (older) landing never rewrites the bar cache', async () => {
    await boot()                                                   // server layout: null
    const saved = { order: [...DEFAULT_BAR.split(',')], hidden: ['garden'] }
    act(() => { api.current.applyLayout(saved) })
    fetchPrefsSpy.mockResolvedValueOnce({ bar_layout: null, more_pins: null, can_edit_bar: true })
    await act(async () => { await api.current.refreshPrefs() })
    expect(read(BAR_LAYOUT_CACHE_KEY).layout).toEqual(saved)
    expect(text('bar')).toBe('today,create,harvests,put-up')
    expect(text('edit')).toBe('true')                              // who-may-edit still updates
  })
})

// QA IMPORTANT-1 — A SESSION THAT ENDS WITHOUT THE SIGN-OUT FUNNEL. An expired or revoked Clerk session
// never runs clearClientPrefs(), so the previous person's caches are still on the phone when the next
// person signs in. NOTHING IN THIS BLOCK CLEARS STORAGE between the two people: that is the whole point
// (the case above clears it itself, so it can only ever test the funnel). Each case names the mutation.
describe('the same phone, a session that ended WITHOUT sign-out (storage never cleared)', () => {
  const DAVE_LAYOUT = { order: [...DEFAULT_BAR.split(',')], hidden: ['put-up'] }
  const JEN_LAYOUT = { order: [...DEFAULT_BAR.split(',')], hidden: ['garden'] }
  const seedDaveLeftovers = () => {
    seed(BAR_LAYOUT_CACHE_KEY, barCache(DAVE_LAYOUT, true, 'dave'))
    seed(MORE_PINS_CACHE_KEY, pinsCache(['seeds', 'photos'], 'dave'))
    seed(MORE_PINS_PENDING_KEY, 'dave')                 // Dave pinned offline; never confirmed
  }

  // KILLING MUTATIONS: readLaunch ignores the stamp (`ownedBy` → any object); the pending check
  // ignores whose sub it holds. RESULT: RED — Jen's first frame is Dave's bar with Dave's editor door,
  // and Dave's unsent list is PATCHed onto Jen's row with Jen's token.
  it('Jen, launching on Dave’s leftovers: shipped first paint, no editor door, and Dave’s pending list is NEVER sent', async () => {
    seedDaveLeftovers()
    userRef.current = { id: 'jen' }
    let answer
    fetchPrefsSpy.mockReturnValue(new Promise(r => { answer = r }))
    await act(async () => { render(tree()) })
    expect(text('bar')).toBe(DEFAULT_BAR)
    expect(text('moved')).toBe('')
    expect(text('edit')).toBe('false')
    expect(text('pins')).toBe('')
    expect(text('pending')).toBe('false')
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(saveSpy).not.toHaveBeenCalled()
    // Her OWN server bar applies at once when it lands — for her this is a first launch.
    await act(async () => { answer({ bar_layout: JEN_LAYOUT, more_pins: null, can_edit_bar: false }) })
    expect(text('bar')).toBe('today,create,harvests,put-up')
    expect(text('moved')).toBe('garden')
    expect(saveSpy).not.toHaveBeenCalled()
    // …and the caches now belong to her.
    expect(read(BAR_LAYOUT_CACHE_KEY)).toEqual(barCache(JEN_LAYOUT, false, 'jen'))
    expect(read(MORE_PINS_CACHE_KEY)).toEqual(pinsCache([], 'jen'))
  })

  // The same, inside ONE mounted provider — the real shape: the provider sits above the routes, the
  // Clerk identity goes dave → null → jen, and nothing runs sign-out in between.
  // KILLING MUTATION: the identity-change reset re-reads the caches without the owner check.
  // RESULT: RED.
  it('dave → (session expires) → jen in one mounted app: Dave’s offline pin is never re-sent as Jen', async () => {
    fetchPrefsSpy.mockResolvedValue({ bar_layout: DAVE_LAYOUT, more_pins: ['seeds'], can_edit_bar: true })
    const view = await boot()
    expect(text('bar')).toBe('today,garden,create,harvests')
    saveSpy.mockResolvedValueOnce({ ok: false, status: 0 })          // offline
    await act(async () => { await api.current.togglePin('photos') })
    expect(read(MORE_PINS_PENDING_KEY)).toBe('dave')
    expect(saveSpy).toHaveBeenCalledTimes(1)
    // No sign-out: the session simply ends, and Jen signs in on the same phone.
    userRef.current = null
    await act(async () => { view.rerender(tree()) })
    fetchPrefsSpy.mockResolvedValue({ bar_layout: null, more_pins: null, can_edit_bar: false })
    userRef.current = { id: 'jen' }
    await act(async () => { view.rerender(tree()) })
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)                          // only Dave's own, earlier save
    expect(text('bar')).toBe(DEFAULT_BAR)
    expect(text('edit')).toBe('false')
    expect(text('pins')).toBe('')
  })

  // A value written before this fix (or by hand) carries no owner; it is not trusted either.
  // KILLING MUTATION: accept an unstamped shape. RESULT: RED.
  it('a legacy unstamped cache counts as no cache', async () => {
    seed(BAR_LAYOUT_CACHE_KEY, { layout: DAVE_LAYOUT, canEdit: true })
    seed(MORE_PINS_CACHE_KEY, ['seeds'])
    seed(MORE_PINS_PENDING_KEY, true)
    let answer
    fetchPrefsSpy.mockReturnValue(new Promise(r => { answer = r }))
    await act(async () => { render(tree()) })
    expect(text('bar')).toBe(DEFAULT_BAR)
    expect(text('edit')).toBe('false')
    expect(text('pins')).toBe('')
    expect(saveSpy).not.toHaveBeenCalled()
    await act(async () => { answer({ bar_layout: JEN_LAYOUT, more_pins: ['photos'], can_edit_bar: true }) })
    expect(text('bar')).toBe('today,create,harvests,put-up')   // applied at once: no trusted cache
    expect(text('pins')).toBe('photos')
  })

  // Control: the owner's OWN stamped caches are still honoured — the stamp is a filter, not a wipe.
  it('the owner’s own stamped caches still draw the first paint and re-send her own pending list', async () => {
    seed(BAR_LAYOUT_CACHE_KEY, barCache(JEN_LAYOUT, false, 'jen'))
    seed(MORE_PINS_CACHE_KEY, pinsCache(['photos'], 'jen'))
    seed(MORE_PINS_PENDING_KEY, 'jen')
    userRef.current = { id: 'jen' }
    fetchPrefsSpy.mockReturnValue(new Promise(() => {}))
    await act(async () => { render(tree()) })
    expect(text('bar')).toBe('today,create,harvests,put-up')
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][0].ids).toEqual(['photos'])
  })
})

describe('no provider', () => {
  it('returns the shipped bar, no pins, no editor, and a toggle that does nothing', async () => {
    render(<Probe />)
    expect(text('bar')).toBe(DEFAULT_BAR)
    expect(text('pins')).toBe('')
    expect(text('edit')).toBe('false')
    expect(await api.current.togglePin('seeds')).toBe('error')
  })
})
