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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import { RETRY_DELAY_MS } from '../lib/useAmbientBandFetch.js'

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/today' }),
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import '../lib/harvestWindows.js'
import HarvestWatchBand, { useHarvestWatchFeed, watchSelection } from '../components/HarvestWatchBand.jsx'
import AmbientBandNotice, { COULD_NOT_CHECK } from '../components/AmbientBandNotice.jsx'

const WATCH = '/api/harvests/watch?limit=200'
const cand = (i, over = {}) => ({
  plant_id: 'p' + i, project_id: 'proj' + (i % 3), name: 'Plant ' + i, location_name: 'Bed ' + i,
  watching_since: '2026-08-0' + ((i % 9) + 1), basis: 'sown ' + i + 'd ago', variety_ref: null, ...over,
})
const nine = { candidates: Array.from({ length: 9 }, (_, i) => cand(i)), snoozed: [] }
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })

beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear() })
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
