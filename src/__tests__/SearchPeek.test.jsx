// V4-SEARCHPEEK-001 — peek a search result IN PLACE. PANED, not stacked.
//
// Two harnesses, deliberately, because the claims split into two kinds:
//
//   A. PANE — what swaps, what the URL carries, what a deep link renders. Search alone under
//      MemoryRouter (the file's existing house style, matching Search.test.jsx).
//   B. SHEET — depth-1 and Android Back. These are claims about the REAL Sheet, the REAL
//      DismissRegistry and REAL window.history, so B renders the actual <OverlayHost> exported from
//      App.jsx inside a BrowserRouter and drives window.history.back(). BackNav.history.test.jsx is
//      the repo's precedent for that and its measured jsdom facts are reused verbatim: popstate DOES
//      fire on back() but needs ~50ms to settle, and back() at index 0 is a SILENT no-op — so a
//      floor sentinel is asserted before every traversal, or a "nothing happened" assertion would
//      pass for entirely the wrong reason.
//
// STATED PLAINLY: jsdom is not Chrome on Android. It cannot express a predictive-back gesture or an
// installed-PWA history floor. What it CAN establish is the structural property those depend on —
// that opening a peek PUSHES a history entry carrying the same overlay background, so a router pop
// lands on the results pane with the sheet still mounted. GATE-A (tests/device/GATE-A.md) owns the
// on-device half.
//
// No jest-dom (L-182): attributes + toBe/toBeTruthy only.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'

// A wide row (what /api/plants really returns) for p1, a THIN server-slice shape for p9 — p9 exists
// only in the /api/search payload, so it exercises "row came from the server, peek comes from the
// client list". p3 is the BUG-SEARCHDEADTAP-001 project-less shape.
const PLANTS = [
  {
    id: 'p1', project_id: 'pr1', name: 'Cherokee Purple', status: 'growing',
    quantity: 4, qty_current: null, location_id: 'l1', sown_at: '2026-03-14',
    planted_out_at: null, notes: 'Volunteer from last year, keep an eye on it.',
    variety_ref: {
      id: 'v9', name: 'Cherokee Purple', genus: 'Solanum', species: 'Solanum lycopersicum',
      days_to_maturity_min: 75, days_to_maturity_max: 80, sun_requirements: 'full_sun',
      lifecycle: 'tender_perennial', crop_type_slug: 'tomato',
      growth_habit: 'indeterminate beefsteak; needs staking',
    },
  },
  { id: 'p2', project_id: 'pr2', name: 'Jalapeno', status: 'growing', variety_ref: { name: 'Jalapeno', crop_type_slug: 'pepper' } },
  { id: 'p3', project_id: null, name: 'Aloe Vera', status: 'growing' },
  { id: 'p9', project_id: 'pr1', name: 'Shishito', status: 'growing', location_id: 'l2', variety_ref: { name: 'Shishito', crop_type_slug: 'pepper' } },
]
const SAMPLE = {
  '/api/plants': PLANTS,
  '/api/locations': [{ id: 'l1', name: 'Greenhouse Bench' }, { id: 'l2', name: 'Pasture Bed' }],
  '/api/varieties': [{ id: 'v1', name: 'Sungold', crop_type_slug: 'tomato' }],
}
// PARTIAL mock: harness B imports App.jsx, which transitively pulls useUploadPhoto's `apiFetch`
// re-export. A bare replacement of this module fails the whole SUITE at collection time.
vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useApiFetch: () => ({
    fetch: async (path) => {
      if (path.startsWith('/api/search')) {
        // The notes-column slice: a THIN planting row, no variety_ref (handlers.js searchPlantings
        // selects id/name/status/project_id/project_name/snippet and nothing else).
        return { results: { plantings: [{ id: 'p9', name: 'Shishito', status: 'growing', project_id: 'pr1', snippet: 'blistered' }] } }
      }
      return SAMPLE[path] ?? []
    },
  }),
}))
vi.mock('../lib/transcribe.js', () => ({ isTranscriptionSupported: () => false, startLiveTranscription: () => ({ stop() {}, cancel() {} }) }))

import Search from '../pages/Search.jsx'
import { OverlayHost } from '../App.jsx'
import { OverlayProvider, useOverlayNavigate, useOverlay } from '../context/OverlayContext.jsx'
import { DismissRegistryProvider, useDismissStackCount } from '../context/DismissRegistry.jsx'

// ─── A. PANE ──────────────────────────────────────────────────────────────────────────────────────

function UrlSink() {
  const loc = useLocation()
  return <div data-testid="url">{loc.pathname + loc.search}</div>
}
const url = () => screen.getByTestId('url').textContent
const renderPane = (entry = '/search') =>
  render(<MemoryRouter initialEntries={[entry]}><UrlSink /><Search /></MemoryRouter>)

async function typeQuery(text) {
  const input = await screen.findByLabelText('Search your garden')
  fireEvent.change(input, { target: { value: text } })
}

describe('§peek pane — one sheet, content swaps results <-> peek', () => {
  it('a Peek control opens the peek and the results list is GONE (swapped, not covered)', async () => {
    renderPane()
    await typeQuery('cherokee')
    expect(await screen.findByText('Cherokee Purple')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Peek at Cherokee Purple'))

    const peek = await screen.findByTestId('search-peek')
    expect(peek).toBeTruthy()
    // The results surface is REPLACED: no search box, no result row, no section head.
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
    expect(screen.queryByText('Plantings')).toBe(null)
    expect(screen.queryByLabelText('Peek at Cherokee Purple')).toBe(null)
  })

  it('the URL carries q AND peek=<id>', async () => {
    renderPane()
    await typeQuery('cherokee')
    fireEvent.click(await screen.findByLabelText('Peek at Cherokee Purple'))
    expect(url()).toBe('/search?q=cherokee&peek=p1')
  })

  it('renders the fields off the row already in hand — no second fetch, no server change', async () => {
    renderPane()
    await typeQuery('cherokee')
    fireEvent.click(await screen.findByLabelText('Peek at Cherokee Purple'))
    await screen.findByTestId('search-peek')
    expect(screen.getByText('Growing')).toBeTruthy()               // statusLabel('growing')
    expect(screen.getByText('Tomato')).toBeTruthy()                // crop_type_slug humanized
    expect(screen.getByText('Solanum lycopersicum')).toBeTruthy()  // genus not double-prefixed
    expect(screen.getByText('Greenhouse Bench')).toBeTruthy()      // location_id -> /api/locations
    expect(screen.getByText('75–80 days')).toBeTruthy()
    expect(screen.getByText('Full sun')).toBeTruthy()
    expect(screen.getByText('Tender perennial')).toBeTruthy()
    expect(screen.getByText('2026-03-14')).toBeTruthy()
    expect(screen.getByText('Open full details ›').getAttribute('href')).toBe('/plantings/p1')
  })

  it('a direct load of /search?q=x&peek=y renders the peek with no typing at all', async () => {
    renderPane('/search?q=cherokee&peek=p1')
    expect(await screen.findByTestId('search-peek')).toBeTruthy()
    expect(screen.getByText('Cherokee Purple')).toBeTruthy()
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })

  it('Back to results restores the list AND the query seeded from the URL', async () => {
    renderPane('/search?q=cherokee&peek=p1')
    await screen.findByTestId('search-peek')
    fireEvent.click(screen.getByText('Back to results'))
    // Cold deep link: nothing to pop, so it replace-navigates back to the results URL.
    expect(url()).toBe('/search?q=cherokee')
    expect(screen.queryByTestId('search-peek')).toBe(null)
    const input = await screen.findByLabelText('Search your garden')
    expect(input.value).toBe('cherokee')
    expect(screen.getByText('Cherokee Purple')).toBeTruthy()
  })

  it('a server-slice row (thin, no variety_ref) still peeks with its FULL client row', async () => {
    renderPane()
    await typeQuery('blistered')     // matches only via the server notes slice
    const btn = await screen.findByLabelText('Peek at Shishito', {}, { timeout: 2000 })
    fireEvent.click(btn)
    await screen.findByTestId('search-peek')
    expect(screen.getByText('Pepper')).toBeTruthy()          // from /api/plants, not from the slice
    expect(screen.getByText('Pasture Bed')).toBeTruthy()
  })

  it('an unknown peek id renders a plain explanation, not a blank sheet', async () => {
    renderPane('/search?q=cherokee&peek=nope')
    expect(await screen.findByText(/isn’t in your garden list any more/)).toBeTruthy()
    expect(screen.queryByTestId('search-peek')).toBe(null)
    expect(screen.getByText('Back to results')).toBeTruthy()
  })

  it('is READ-ONLY: the peek pane renders no form control at all', async () => {
    renderPane('/search?q=cherokee&peek=p1')
    await screen.findByTestId('search-peek')
    const peek = screen.getByTestId('search-peek')
    expect(peek.querySelectorAll('input, textarea, select, button').length).toBe(0)
  })

  it('scope: only planting rows get a Peek control — locations and varieties are untouched', async () => {
    renderPane()
    await typeQuery('pasture')
    expect((await screen.findByText('Pasture Bed')).closest('a').getAttribute('href')).toBe('/locations/l2')
    expect(screen.queryByLabelText(/^Peek at/)).toBe(null)
    await typeQuery('sungold')
    expect(await screen.findByText('Sungold')).toBeTruthy()
    expect(screen.queryByLabelText(/^Peek at/)).toBe(null)
  })

  it('the row keeps its own destination — the peek is additive, not a hijacked tap', async () => {
    renderPane()
    await typeQuery('aloe')
    const link = (await screen.findByText('Aloe Vera')).closest('a')
    expect(link.getAttribute('href')).toBe('/plantings/p3')       // BUG-SEARCHDEADTAP-001 intact
    expect(screen.getByLabelText('Peek at Aloe Vera')).toBeTruthy()
  })
})

// ─── B. SHEET — real Sheet, real registry, real history ───────────────────────────────────────────

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const back = async () => { act(() => { window.history.back() }); await settle() }

const SENTINEL = { __floor: 1 }
const atFloor = () => window.history.state?.__floor === 1

function StackProbe() {
  return <div data-testid="depth">{useDismissStackCount()}</div>
}
const depth = () => Number(screen.getByTestId('depth').textContent)

// Every committed navigation, in order. This is how "closes ONCE, not twice" is made falsifiable:
// dismiss is a REPLACE to the background, so a second close would land on the same URL and be
// invisible to a location assertion — but it cannot hide from the length of this log.
const navLog = []
function NavLog() {
  const loc = useLocation()
  React.useEffect(() => { navLog.push(loc.pathname + loc.search) }, [loc])
  return null
}

function Opener() {
  const nav = useOverlayNavigate()
  return <button onClick={() => nav('/search')}>open search</button>
}

// A miniature of AppShell: page tree at pageLocation, overlay tree at overlayLocation mounted only
// when a background exists — wrapping the REAL OverlayHost around the REAL Search.
function MiniShell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  return (
    <>
      <Routes location={pageLocation}>
        <Route path="/today" element={<div data-testid="today">TODAY<Opener /></div>} />
        <Route path="/search" element={<div data-testid="search-fullpage" />} />
        <Route path="/plantings/:id" element={<div data-testid="planting-page" />} />
      </Routes>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<OverlayHost ariaLabel="Search your garden" size="peek"><Search /></OverlayHost>} />
        </Routes>
      )}
      <StackProbe />
      <NavLog />
    </>
  )
}

function renderShell() {
  return render(
    <BrowserRouter>
      <DismissRegistryProvider>
        <OverlayProvider>
          <MiniShell />
        </OverlayProvider>
      </DismissRegistryProvider>
    </BrowserRouter>
  )
}

// PRE-EXISTING, worth naming: OverlayHost labels the dialog "Search your garden" and the input
// carries the same aria-label, so getByLabelText is ambiguous in harness B. Query the input by role
// here. (Harness A has no dialog and keeps Search.test.jsx's label query.)
const searchBox = () => screen.findByRole('searchbox')

// Open the flyover and peek Cherokee Purple, through the real controls.
async function openSearchThenPeek() {
  fireEvent.click(screen.getByText('open search'))
  const input = await searchBox()
  fireEvent.change(input, { target: { value: 'cherokee' } })
  fireEvent.click(await screen.findByLabelText('Peek at Cherokee Purple'))
  await screen.findByTestId('search-peek')
}

describe('§peek sheet — depth-1 and Android Back (real Sheet + registry + history)', () => {
  beforeEach(() => { navLog.length = 0; window.history.replaceState(SENTINEL, '', '/today') })
  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
    document.body.style.overscrollBehavior = ''
    window.history.replaceState(null, '', '/')
  })

  it('SELF-TEST: the floor sentinel is current before any traversal under test', () => {
    expect(atFloor()).toBe(true)
  })

  it('opening the peek keeps exactly ONE dismissable surface (depth never exceeds 1)', async () => {
    renderShell()
    expect(depth()).toBe(0)
    fireEvent.click(screen.getByText('open search'))
    const input = await searchBox()
    expect(depth()).toBe(1)                       // the route Sheet
    fireEvent.change(input, { target: { value: 'cherokee' } })
    fireEvent.click(await screen.findByLabelText('Peek at Cherokee Purple'))
    await screen.findByTestId('search-peek')
    // The whole shape of the feature in one number: peeking added no second surface.
    expect(depth()).toBe(1)
    expect(screen.getAllByRole('dialog').length).toBe(1)
  })

  it('Back from the peek returns to the RESULTS with the sheet still open', async () => {
    renderShell()
    await openSearchThenPeek()
    expect(window.location.pathname + window.location.search).toBe('/search?q=cherokee&peek=p1')

    await back()

    // The peek is gone, the results pane is back, and the sheet was never torn down.
    expect(screen.queryByTestId('search-peek')).toBe(null)
    expect(screen.getAllByRole('dialog').length).toBe(1)
    expect(depth()).toBe(1)
    // Back POPS, so we land on the entry the flyover was opened at — bare `/search`, not the
    // reconstructed `/search?q=cherokee`. The typed query survives anyway because Search never
    // unmounted; that is the difference between a paned swap and a re-navigation.
    expect(window.location.pathname + window.location.search).toBe('/search')
    expect((await searchBox()).value).toBe('cherokee')
    expect(screen.getByText('Cherokee Purple')).toBeTruthy()
  })

  it('a SECOND Back then closes the flyover and lands back on the tab underneath', async () => {
    renderShell()
    await openSearchThenPeek()
    await back()
    await back()
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(screen.getByTestId('today')).toBeTruthy()
    expect(depth()).toBe(0)
    expect(atFloor()).toBe(true)
  })

  it('the visible Back-to-results control pops the SAME entry the system Back does', async () => {
    renderShell()
    await openSearchThenPeek()
    fireEvent.click(screen.getByText('Back to results'))
    await settle()
    // THE discriminating assertion: a pop lands on the pre-existing `/search` entry. Had the control
    // replace-navigated instead it would read `/search?q=cherokee` here — same pixels, but a
    // stranded duplicate entry that costs the user an extra dead Back press.
    expect(window.location.pathname + window.location.search).toBe('/search')
    expect(screen.getAllByRole('dialog').length).toBe(1)
    await back()
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(atFloor()).toBe(true)
  })

  it('Escape from the peek closes the WHOLE sheet once — not the peek, and not twice', async () => {
    renderShell()
    await openSearchThenPeek()
    expect(navLog).toEqual(['/today', '/search', '/search?q=cherokee&peek=p1'])
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await settle()
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(depth()).toBe(0)
    expect(window.location.pathname).toBe('/today')
    // ONE navigation, not two. A peek-level dismiss handler firing alongside the sheet's would
    // append a second entry here (…, '/search?q=cherokee', '/today') for the same single keypress.
    expect(navLog).toEqual(['/today', '/search', '/search?q=cherokee&peek=p1', '/today'])
  })

  it('Open full details leaves the flyover for the full page (background dropped)', async () => {
    renderShell()
    await openSearchThenPeek()
    fireEvent.click(screen.getByText('Open full details ›'))
    await settle()
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(screen.getByTestId('planting-page')).toBeTruthy()
    expect(document.body.style.overflow).toBe('')   // scroll lock released, not stranded
  })
})
