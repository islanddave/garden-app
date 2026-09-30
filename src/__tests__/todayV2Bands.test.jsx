// V5-TODAYREDESIGN-001 S6 — the Today bands split into a DATA HOOK + optional `data` / `bare` props, so the
// redesigned Today can fetch at the page (a section's presence and header summary are read while its body is
// unmounted) and render each band's rows inside its own section. Three promises, each pinned here:
//   1. `data` path = self-fetch path: handing the band its hook's result renders the same HTML and adds no fetch.
//   2. `bare`: the rows only — no eyebrow, title, card or outer margin, no landmark name (the section holding it
//      is the heading and the region).
//   3. the exported selection helpers are the band's OWN, so a header summary names exactly what the band lists.
// The no-props render being byte-identical to the base commit was proved once, against f47337da's files (build
// report, S6); each band's own suite stays green UNEDITED.
import React from 'react'
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import { RETRY_DELAY_MS } from '../lib/useAmbientBandFetch.js'

const navigateMock = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: '/today' }),
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))
const authRef = vi.hoisted(() => ({ current: { user: null, profile: { id: 'viewer' }, loading: false } }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => authRef.current }))

import '../lib/harvestWindows.js'
import HarvestWatchBand, { useHarvestWatchFeed, watchSelection } from '../components/HarvestWatchBand.jsx'
import AmbientBandNotice, { COULD_NOT_CHECK } from '../components/AmbientBandNotice.jsx'
import ComposeHarvestBand, { useComposeHarvestFeed, composeBatchState } from '../components/ComposeHarvestBand.jsx'
import PutUpUseSoonBand, { usePutUpUseSoonFeed, putUpSoonSlice, putUpSoonTitle } from '../components/PutUpUseSoonBand.jsx'
import CultivationLead, { useCultivationFeed } from '../components/today/CultivationLead.jsx'

const WATCH = '/api/harvests/watch?limit=200'
const cand = (i, over = {}) => ({
  plant_id: 'p' + i, project_id: 'proj' + (i % 3), name: 'Plant ' + i, location_name: 'Bed ' + i,
  watching_since: '2026-08-0' + ((i % 9) + 1), basis: 'sown ' + i + 'd ago', variety_ref: null, ...over,
})
const nine = { candidates: Array.from({ length: 9 }, (_, i) => cand(i)), snoozed: [] }
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })

beforeEach(() => { fetchMock.mockReset(); navigateMock.mockReset(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

// The redesigned Today's shape: the page runs the hook, the band gets the result.
function PageFed({ Band, useFeed, bare }) {
  const feed = useFeed()
  return <Band data={feed} bare={bare} />
}

describe('HarvestWatchBand — data hook + data / bare', () => {
  it('the data path renders the self-fetch path\'s HTML, and the band adds no fetch of its own', async () => {
    fetchMock.mockImplementation((u) => Promise.resolve(u === WATCH ? nine : null))
    const self = render(<HarvestWatchBand />)
    await settle()
    const selfHtml = self.container.innerHTML
    expect(selfHtml).toContain('Start checking Plant')
    cleanup()
    fetchMock.mockClear()
    const fed = render(<PageFed Band={HarvestWatchBand} useFeed={useHarvestWatchFeed} />)
    await settle()
    expect(fed.container.innerHTML).toBe(selfHtml)
    expect(fetchMock.mock.calls.filter(([u]) => u === WATCH)).toHaveLength(1) // the page's, not a second one
  })

  it('bare: the rows only — no eyebrow, title, subtitle, card or landmark name', async () => {
    fetchMock.mockImplementation((u) => Promise.resolve(u === WATCH ? nine : null))
    const { container } = render(<PageFed Band={HarvestWatchBand} useFeed={useHarvestWatchFeed} bare />)
    await settle()
    const band = screen.getByTestId('today-watch-band')
    expect(band.getAttribute('style')).toBeNull()
    expect(band.hasAttribute('aria-label')).toBe(false)
    expect(screen.queryByRole('region')).toBeNull()
    expect(container.textContent).not.toMatch(/Looking ahead|Worth checking soon|start of a stream/i)
    expect(screen.getAllByText(/^Start checking /)).toHaveLength(5)
    expect(screen.getByRole('button', { name: /Show 4 more worth checking/ })).toBeTruthy()
  })

  it('watchSelection is the band\'s own: its visible rows are the rows the band lists, in order', async () => {
    fetchMock.mockImplementation((u) => Promise.resolve(u === WATCH ? nine : null))
    render(<HarvestWatchBand />)
    await settle()
    const listed = screen.getAllByText(/^Start checking /).map((el) => el.textContent.replace('Start checking ', ''))
    const sel = watchSelection(nine)
    expect(sel.visible.map((c) => c.name)).toEqual(listed)
    expect(sel.all).toHaveLength(9)
    expect(sel.overflow).toHaveLength(4)
    expect(watchSelection(null)).toEqual({ all: [], snoozed: [], visible: [], overflow: [] })
  })

  it('bare failure: the notice\'s line and its retry, without the card or the eyebrow', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')))
    const { container } = render(<PageFed Band={HarvestWatchBand} useFeed={useHarvestWatchFeed} bare />)
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 50) })
    await waitFor(() => expect(container.textContent).toContain(`${COULD_NOT_CHECK}.`))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(container.textContent).not.toMatch(/Looking ahead/)
    expect(screen.queryByRole('region')).toBeNull()
  })
})

// A harvest batch of the viewer's: six picks, minutes old (the band's 18 h freshness window and its
// MIN_POST_LINES floor both satisfied).
const HARVESTS = '/api/harvests'
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString()
const pick = (mins, name, crop, by = 'viewer') => ({ event_id: name + mins, event_type: 'harvest', created_at: ago(mins), created_by: by, planting_name: name, variety_name: name, crop_name: crop, quantity: 2, unit: 'count', note_excerpt: null })
const BATCH = { entries: [pick(20, 'Moskvich', 'Tomato'), pick(19, 'San Marzano', 'Tomato'), pick(18, 'Cubanelle', 'Pepper'), pick(17, 'Piri Piri', 'Pepper'), pick(16, 'Sungold', 'Tomato'), pick(15, 'Lemon Drop', 'Pepper')], aggregates: null }
const composeWire = (body) => fetchMock.mockImplementation((u) => Promise.resolve(String(u).startsWith(HARVESTS) ? body : null))

describe('ComposeHarvestBand — data hook + data / bare', () => {
  it('the data path renders the self-fetch path\'s HTML, and the band adds no fetch of its own', async () => {
    composeWire(BATCH)
    const self = render(<ComposeHarvestBand />)
    await settle()
    const selfHtml = self.container.innerHTML
    expect(selfHtml).toContain('6 picks')
    cleanup()
    fetchMock.mockClear()
    const fed = render(<PageFed Band={ComposeHarvestBand} useFeed={useComposeHarvestFeed} />)
    await settle()
    expect(fed.container.innerHTML).toBe(selfHtml)
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith(HARVESTS))).toHaveLength(1)
  })

  it('bare: no card and no title; the picks line and Compose post stay', async () => {
    composeWire(BATCH)
    const { container } = render(<PageFed Band={ComposeHarvestBand} useFeed={useComposeHarvestFeed} bare />)
    await settle()
    const band = screen.getByTestId('compose-harvest-band')
    expect(band.getAttribute('style')).toBeNull()
    expect(container.textContent).not.toMatch(/Tonight.s harvest/)
    expect(container.textContent).toMatch(/^6 picks · logged (just now|\d+ min ago)Compose post$/)
  })

  // composeBatchState is the header's read of the band's own three gates; it must agree with the band on
  // every side of each gate, or the section header would announce a post the body does not offer.
  it('composeBatchState agrees with the band: present exactly when the band renders, with its picks line', async () => {
    const cases = {
      fresh: BATCH,
      someoneElses: { entries: BATCH.entries.map((e) => ({ ...e, created_by: 'jen' })), aggregates: null },
      stale: { entries: BATCH.entries.map((e) => ({ ...e, created_at: ago(19 * 60) })), aggregates: null },
      tooFew: { entries: BATCH.entries.slice(0, 1), aggregates: null },
      empty: { entries: [], aggregates: null },
    }
    for (const [name, body] of Object.entries(cases)) {
      composeWire(body)
      const { container } = render(<ComposeHarvestBand />)
      await settle()
      const state = composeBatchState(body, 'viewer')
      const shown = !!container.querySelector('[data-testid="compose-harvest-band"]')
      expect(!!state, name).toBe(shown)
      if (state) expect(container.textContent).toContain(`${state.postableCount} picks · logged ${state.logged}`)
      cleanup()
      sessionStorage.clear()
    }
    expect(composeBatchState(BATCH, null)).toBeNull() // no viewer, no batch — as the band
    expect(composeBatchState(null, 'viewer')).toBeNull()
  })

  it('the hook reports settled once the first request answers — or fails', async () => {
    let seen = null
    function Probe() { const f = useComposeHarvestFeed(); seen = f; return null }
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')))
    render(<Probe />)
    expect(seen.settled).toBe(false)
    await settle()
    expect(seen.settled).toBe(true)
    expect(seen.data).toBeNull()
  })
})

const USE_SOON = '/api/preservation/use-soon'
const jar = (i, over = {}) => ({ id: 'j' + i, crop_display_name: 'Crop ' + i, quantity_value: i + 1, quantity_unit: 'bags', method: 'whole_freeze', storage_label: 'Freezer', use_by_status: i === 0 ? 'past_use_by' : 'use_soon', ...over })
const SEVEN = { items: Array.from({ length: 7 }, (_, i) => jar(i)) }
const soonWire = (body) => fetchMock.mockImplementation((u) => Promise.resolve(u === USE_SOON ? body : null))

describe('PutUpUseSoonBand — data hook + data / bare', () => {
  it('the data path renders the self-fetch path\'s HTML, and the band adds no fetch of its own', async () => {
    soonWire(SEVEN)
    const self = render(<PutUpUseSoonBand />)
    await settle()
    const selfHtml = self.container.innerHTML
    expect(selfHtml).toContain('Crop 1')
    cleanup()
    fetchMock.mockClear()
    const fed = render(<PageFed Band={PutUpUseSoonBand} useFeed={usePutUpUseSoonFeed} />)
    await settle()
    expect(fed.container.innerHTML).toBe(selfHtml)
    expect(fetchMock.mock.calls.filter(([u]) => u === USE_SOON)).toHaveLength(1)
  })

  // The destination is PUTUP's (release 1a moves it to the filtered list): this pins only that the bare band keeps
  // its one door to Put-Up and that the door still navigates — never where to.
  it('bare: no card, eyebrow, title or landmark; the rows and the Open Put-Up door stay', async () => {
    soonWire(SEVEN)
    const { container } = render(<PageFed Band={PutUpUseSoonBand} useFeed={usePutUpUseSoonFeed} bare />)
    await settle()
    const band = screen.getByTestId('putup-use-soon')
    expect(band.getAttribute('style')).toBeNull()
    expect(band.hasAttribute('aria-label')).toBe(false)
    expect(container.textContent).not.toMatch(/From the Pantry|Cook these next/)
    expect(container.textContent).toContain('+2 more in the Pantry')
    screen.getByRole('button', { name: 'Open Put-Up' }).click()
    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(String(navigateMock.mock.calls[0][0])).toMatch(/^\/put-up/)
  })

  it('putUpSoonSlice is the band\'s own: the jars a header names are the rows the band lists, in order', async () => {
    soonWire(SEVEN)
    const { container } = render(<PutUpUseSoonBand />)
    await settle()
    const rows = [...container.querySelectorAll('li')].map((li) => li.firstElementChild.firstElementChild.textContent)
    const { shown, more } = putUpSoonSlice(SEVEN.items)
    expect(shown.map(putUpSoonTitle)).toEqual(rows)
    expect(more).toBe(2)
    expect(putUpSoonSlice(null)).toEqual({ shown: [], more: 0 })
  })
})

const SOW = '/api/inventory-items/sow-candidates'
// Two candidates the real sow engine buckets as window_closing on 2026-09-24 (a fall direct-sow near its latest
// safe date), so the lines come from bucketize itself rather than a stub.
const sowItems = JSON.parse(readFileSync('tests/harness/_todaymeasure/sowcandidates.json', 'utf8')).items
const sowWire = () => fetchMock.mockImplementation((u) => Promise.resolve(u === SOW ? { items: sowItems } : null))

describe('CultivationLead — data hook + data / bare (the V2 Sow link row)', () => {
  it('the data path renders the self-fetch path\'s HTML, and the lead adds no fetch of its own', async () => {
    sowWire()
    const self = render(<CultivationLead todayISO="2026-09-24" />)
    await settle()
    const selfHtml = self.container.innerHTML
    expect(selfHtml).toMatch(/by Sep 24/)
    cleanup()
    fetchMock.mockClear()
    function Fed() { return <CultivationLead todayISO="2026-09-24" data={useCultivationFeed()} /> }
    const fed = render(<Fed />)
    await settle()
    expect(fed.container.innerHTML).toBe(selfHtml)
    expect(fetchMock.mock.calls.filter(([u]) => u === SOW)).toHaveLength(1)
  })

  it('bare with no lines: exactly the Sow link row — sprout, "All sow windows ›", a 44px link with no card', async () => {
    function Fed() { return <CultivationLead todayISO="2026-10-01" data={useCultivationFeed({ enabled: false })} bare /> }
    render(<Fed />)
    await settle()
    const row = screen.getByTestId('cultivation-lead')
    expect(row.tagName).toBe('A')
    expect(row.getAttribute('href')).toBe('/seeds?view=sow')
    expect(row.textContent).toBe('All sow windows ›')
    expect(row.children).toHaveLength(2) // the icon and the one label span — no line block
    expect(row.style.minHeight).toBe('44px')
    expect(row.style.backgroundColor).toBe('')
    expect(row.style.border).toBe('')
    expect(fetchMock).not.toHaveBeenCalled() // enabled:false asks nothing
  })

  it('bare with the engine\'s dated lines: the lines, then the door', async () => {
    sowWire()
    function Fed() { return <CultivationLead todayISO="2026-09-24" data={useCultivationFeed()} bare /> }
    render(<Fed />)
    await settle()
    expect(screen.getByTestId('cultivation-lead').textContent).toMatch(/^Sow .+ by Sep 24\.Start .+ indoors by Sep 24\.All sow windows ›$/)
  })

  it('settled: at once when nothing is asked; after the answer (or the failure) otherwise', async () => {
    const seen = {}
    function Probe({ id, enabled }) { seen[id] = useCultivationFeed({ enabled }); return null }
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')))
    render(<><Probe id="off" enabled={false} /><Probe id="on" enabled /></>)
    expect(seen.off.settled).toBe(true)
    expect(seen.on.settled).toBe(false)
    await settle()
    expect(seen.on.settled).toBe(true)
    expect(seen.on.items).toBeNull()
  })
})

describe('AmbientBandNotice — bare', () => {
  it('without bare: the card, the eyebrow and the named region, as always', () => {
    render(<AmbientBandNotice eyebrow="Put up" onRetry={() => {}} />)
    expect(screen.getByRole('region', { name: 'Put up — unavailable' }).textContent).toBe('Put upCouldn’t check just now.Try again')
  })
  it('bare: the line and Try again only', () => {
    const retry = vi.fn()
    const { container } = render(<AmbientBandNotice eyebrow="Put up" onRetry={retry} bare />)
    expect(container.textContent).toBe('Couldn’t check just now.Try again')
    expect(container.firstElementChild.getAttribute('style')).toBeNull()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
