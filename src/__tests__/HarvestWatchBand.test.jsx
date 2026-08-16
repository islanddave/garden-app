// V4-HARVSURFACE-001 Slice 1 — Section 2, the "worth checking" watch list.
//
// EVERY ASSERTION HERE IS AGAINST RENDERED OUTPUT, never against source text, imports or props.
// This codebase has shipped an inert feature twice — most recently the colour windows, which sat
// dead in prod through a full release with a green suite — because tests asserted that code
// EXISTED rather than that it RENDERED. The named mutations at the bottom of this file are the
// contract: each one must turn a specific test red.
//
// The colour-window resolver is loaded for real (not stubbed) so the observable assertions run
// against the shipped dataset — Yellow Brandywine is the design's own §3.3 worst case (a yellow
// beefsteak with no red flush), so a fixture change in the data would correctly break this.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RETRY_DELAY_MS } from '../lib/useAmbientBandFetch.js'

const navigateMock = vi.fn()
const locationRef = { pathname: '/today' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
  // BD-007: carries `to` -> href so the row-headline link is assertable by destination;
  // preventDefault silences jsdom's "Not implemented: navigation" noise when a test clicks it.
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} onClick={(e) => e.preventDefault()} {...rest}>{children}</a>
  ),
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import HarvestWatchBand from '../components/HarvestWatchBand.jsx'
// PRE-WARM THE MODULE REGISTRY — this static import is load-bearing, not a stray.
//
// The band resolves its colour-window dataset through a lazy `import('../lib/harvestWindows.js')`
// (HarvestWatchBand.jsx:125). The observable assertions below therefore raced a real chunk load,
// and under a loaded worker pool the 8s findBy budget was not enough: this file timed out at
// ~8029ms in two separate authoritative runs while passing 32/32 in isolation. That is a stopwatch
// masquerading as an assertion — and a suite that reds on a different file each run randomly blocks
// the promote, with re-running as the tempting wrong response.
//
// Importing the module statically here populates the registry before any render, so the component's
// dynamic import resolves from it immediately — exactly the mechanism the component documents at
// its `hwModule` cache (:52-54). The dataset is still the REAL one, never stubbed, so this file
// keeps its whole reason for existing: it would still catch the colour windows going inert, which
// is a defect this codebase has actually shipped.
import '../lib/harvestWindows.js'

// Panel Q4 contract: the band fetches the whole queue (limit=200) so the tail expands in place.
const WATCH = '/api/harvests/watch?limit=200'
const DISMISS = '/api/harvests/watch/dismiss'
const DISMISSALS = '/api/harvests/watch/dismissals'

// Real dataset keys. `yellowbrandywine` is a cultivar record (confidence medium, no qualifier);
// `tomato` is a crop-level record whose first point is "mature green"; `capeliente` is a
// confidence:'low' cultivar. `basil` exists in NEITHER map — the design names basil explicitly as
// an uncovered edible, which is the degradation path §3.2 requires.
const brandywine = (over = {}) => ({
  plant_id: 'p-yb', project_id: 'proj-1', name: 'Yellow Brandywine',
  location_name: 'Hilltop bed 2', watching_since: '2026-08-04',
  basis: 'sown 118d ago; catalogue 95d from transplant',
  variety_ref: { name: 'Yellow Brandywine', crop_type_slug: 'tomato' }, ...over,
})
const basil = (over = {}) => ({
  plant_id: 'p-bz', project_id: 'proj-2', name: 'Genovese Basil',
  location_name: 'Kitchen bed', watching_since: '2026-08-06',
  basis: 'sown 62d ago; catalogue 60-75 days from sowing',
  variety_ref: { name: 'Genovese Basil', crop_type_slug: 'basil' }, ...over,
})

const payload = (candidates, extra = {}) => fetchMock.mockImplementation((url) =>
  Promise.resolve(url === WATCH ? { candidates, snoozed: [], ...extra } : null))

beforeEach(() => { navigateMock.mockReset(); fetchMock.mockReset(); sessionStorage.clear() })

const band = () => screen.findByRole('region', { name: /Worth checking soon/i })

describe('HarvestWatchBand — the check form (the load-bearing voice rule)', () => {
  it('renders each row as a CHECK prompt, never a readiness assertion', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    // The positive: the row is a standing instruction to go look.
    expect(await within(card).findByText(/Start checking Yellow Brandywine/)).toBeTruthy()
    // The negative: at 11.8% calibration the assertion form would be dishonest most of the time.
    expect(card.textContent).not.toMatch(
      /is ready|are ready|ready to pick|window (has )?opened|window is open|now ripe|is ripe|it'?s time to pick/i)
  })

  it('titles the group per panel Q1 and frames it as a plan, not tonight’s dinner', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    expect(within(card).getByText('Worth checking soon')).toBeTruthy()
    expect(within(card).getByText(/The start of a stream, not tonight’s dinner\./)).toBeTruthy()
  })

  // Panel Q1: every denominator SENTENCE is deleted — the count lives only on the tail button.
  it('prints no "Showing N of M" prose anywhere in the band', async () => {
    payload(Array.from({ length: 9 }, (_, i) =>
      brandywine({ plant_id: `p${i}`, project_id: `proj-${i}`, name: `Row ${i}`, watching_since: `2026-08-0${i + 1}` })))
    render(<HarvestWatchBand />)
    const card = await band()
    expect(card.textContent).not.toMatch(/Showing \d+ of \d+/i)
  })
})

describe('HarvestWatchBand — the observable (design §3.2, the unlock)', () => {
  it('names the observable from the shipped colour-window dataset', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    // Async: the dataset is a lazily-imported chunk, so this must be a findBy.
    expect(await within(card).findByText('colour break (green to pale amber)', undefined, { timeout: 8000 })).toBeTruthy()
    expect(within(card).getByText(/Look for:/)).toBeTruthy()
  })

  it('renders a cultivar-sourced observable with NO provenance qualifier', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    await within(card).findByText('colour break (green to pale amber)', undefined, { timeout: 8000 })
    expect(card.textContent).not.toMatch(/general guidance for this crop|derived from the variety type/)
  })

  it('labels a crop-level fallback as general guidance, not as a claim about the variety', async () => {
    payload([brandywine({
      plant_id: 'p-unk', name: 'Unlisted Heirloom',
      variety_ref: { name: 'No Such Cultivar At All', crop_type_slug: 'tomato' },
    })])
    render(<HarvestWatchBand />)
    const card = await band()
    expect(await within(card).findByText('mature green', undefined, { timeout: 8000 })).toBeTruthy()
    expect(within(card).getByText(/\(general guidance for this crop, not this variety\)/)).toBeTruthy()
  })

  it('labels a low-confidence cultivar record as derived', async () => {
    payload([brandywine({
      plant_id: 'p-cl', name: 'Cape Liente',
      variety_ref: { name: 'Cape Liente', crop_type_slug: 'pepper' },
    })])
    render(<HarvestWatchBand />)
    const card = await band()
    await within(card).findByText('mature green', undefined, { timeout: 8000 })
    expect(within(card).getByText(/\(derived from the variety type\)/)).toBeTruthy()
  })

  it('degrades an uncovered crop to basis-stated calendar text — the row still renders', async () => {
    // 51% dataset coverage: basil has neither a cultivar nor a crop record. §3.2 requires the row
    // to degrade, NOT to hide — hiding it would silently drop half the watch list.
    payload([basil()])
    render(<HarvestWatchBand />)
    const card = await band()
    expect(within(card).getByText(/Start checking Genovese Basil/)).toBeTruthy()
    expect(within(card).getByText(/sown 62d ago; catalogue 60-75 days from sowing/)).toBeTruthy()
    await waitFor(() => expect(card.textContent).not.toMatch(/Look for:/))
  })
})

describe('HarvestWatchBand — row payload and ordering', () => {
  it('renders the location and the standing since-date, not a freshness badge', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    expect(within(card).getByText('Hilltop bed 2')).toBeTruthy()
    expect(within(card).getByText(/Checking since Aug 4/)).toBeTruthy()
    expect(within(card).getByText(/sown 118d ago; catalogue 95d from transplant/)).toBeTruthy()
    expect(card.textContent).not.toMatch(/new\b|just now|today only|fresh/i)
  })

  it('orders rows newest-watched first', async () => {
    // Distinct projects so the Q2 per-project slot cap does not bind here.
    payload([
      brandywine({ plant_id: 'a', project_id: 'proj-a', name: 'Older Row', watching_since: '2026-07-20' }),
      brandywine({ plant_id: 'b', project_id: 'proj-b', name: 'Newest Row', watching_since: '2026-08-10' }),
      brandywine({ plant_id: 'c', project_id: 'proj-c', name: 'Middle Row', watching_since: '2026-08-02' }),
    ])
    render(<HarvestWatchBand />)
    const card = await band()
    const items = within(card).getAllByRole('listitem').map(li => li.textContent)
    expect(items[0]).toMatch(/Newest Row/)
    expect(items[1]).toMatch(/Middle Row/)
    expect(items[2]).toMatch(/Older Row/)
  })

  it('caps the visible group at five — a nine-row declarative group is an inventory again', async () => {
    // Distinct projects so the Q2 per-project cap does not bind — this pins the SLOT cap alone.
    payload(Array.from({ length: 9 }, (_, i) =>
      brandywine({ plant_id: `p${i}`, project_id: `proj-${i}`, name: `Row ${i}`, watching_since: `2026-08-0${i + 1}` })))
    render(<HarvestWatchBand />)
    const card = await band()
    expect(within(card).getAllByRole('listitem')).toHaveLength(5)
  })

  // PANEL Q2: any one project holds at most 2 of the 5 visible slots — a display device over slot
  // allocation, not grouping. The capped-out rows are not lost; they lead the tail.
  it('caps any one project at 2 of the 5 visible slots', async () => {
    payload([
      brandywine({ plant_id: 'a1', project_id: 'proj-peppers', name: 'Pepper 1', watching_since: '2026-08-10' }),
      brandywine({ plant_id: 'a2', project_id: 'proj-peppers', name: 'Pepper 2', watching_since: '2026-08-09' }),
      brandywine({ plant_id: 'a3', project_id: 'proj-peppers', name: 'Pepper 3', watching_since: '2026-08-08' }),
      brandywine({ plant_id: 'b1', project_id: 'proj-melons', name: 'Melon 1', watching_since: '2026-08-07' }),
      brandywine({ plant_id: 'b2', project_id: 'proj-melons', name: 'Melon 2', watching_since: '2026-08-06' }),
      brandywine({ plant_id: 'c1', project_id: 'proj-beans', name: 'Bean 1', watching_since: '2026-08-05' }),
    ])
    render(<HarvestWatchBand />)
    const card = await band()
    const items = within(card).getAllByRole('listitem').map(li => li.textContent)
    expect(items).toHaveLength(5)
    // Pepper 3 (rank #3) is displaced by the cap; Bean 1 (rank #6) takes the freed slot.
    expect(items.filter(t => /Pepper/.test(t))).toHaveLength(2)
    expect(items.some(t => /Bean 1/.test(t))).toBe(true)
    expect(items.some(t => /Pepper 3/.test(t))).toBe(false)
    // The displaced row leads the tail rather than vanishing.
    expect(within(card).getByRole('button', { name: /Show 1 more worth checking/ })).toBeTruthy()
  })

  it('a single-project queue shows 2 rows and an honest tail — the cap does not backfill', async () => {
    payload(Array.from({ length: 6 }, (_, i) =>
      brandywine({ plant_id: `p${i}`, project_id: 'proj-peppers', name: `Pepper ${i}`, watching_since: `2026-08-0${i + 1}` })))
    render(<HarvestWatchBand />)
    const card = await band()
    expect(within(card).getAllByRole('listitem')).toHaveLength(2)
    expect(within(card).getByRole('button', { name: /Show 4 more worth checking/ })).toBeTruthy()
  })
})

describe('HarvestWatchBand — the "not yet" dismissal (the first negative-class sample)', () => {
  it('removes the row and writes the negative sample', async () => {
    payload([brandywine(), basil()])
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ }))

    // The row is GONE from the list — replaced in place by a quiet acknowledgement.
    await waitFor(() => expect(card.textContent).not.toMatch(/Start checking Yellow Brandywine/))
    expect(within(card).getByText(/Not checking Yellow Brandywine for now\./)).toBeTruthy()
    // The other row is untouched.
    expect(within(card).getByText(/Start checking Genovese Basil/)).toBeTruthy()

    const post = fetchMock.mock.calls.find(([u]) => u === DISMISS)
    expect(post).toBeTruthy()
    expect(post[1].method).toBe('POST')
    expect(JSON.parse(post[1].body)).toMatchObject({ plant_id: 'p-yb', dismissed: true })
  })

  it('offers a one-tap undo that reinstates the row and reverses the sample', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ }))
    const undo = await within(card).findByRole('button', { name: /Undo — Yellow Brandywine/ })
    await userEvent.click(undo)

    expect(await within(card).findByText(/Start checking Yellow Brandywine/)).toBeTruthy()
    expect(card.textContent).not.toMatch(/Not checking Yellow Brandywine for now\./)
    const posts = fetchMock.mock.calls.filter(([u]) => u === DISMISS).map(([, o]) => JSON.parse(o.body))
    expect(posts.map(p => p.dismissed)).toEqual([true, false])
  })

  // PANEL Q3: the collapsed row names the RETURN DATE (copy changed from "for now"), and the undo
  // retracts EXACTLY the dismissal that was just made — by id, via DELETE /watch/dismissals/:id —
  // never the planting's accumulated samples.
  it('names the return date on the collapsed row and retracts by id on Undo', async () => {
    const del = vi.fn(() => Promise.resolve({ undone: true }))
    fetchMock.mockImplementation((url, opts) => {
      if (url === WATCH) return Promise.resolve({ candidates: [brandywine()], snoozed: [] })
      if (url === DISMISS) return Promise.resolve({ dismissal: { id: 'd-77', suppressed_until: '2026-08-22' } })
      if (url === `${DISMISSALS}/d-77` && opts?.method === 'DELETE') return del()
      return Promise.resolve(null)
    })
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ }))

    // The snooze states its end — never an ambiguous exit.
    expect(await within(card).findByText(/Not checking Yellow Brandywine — back Aug 22\./)).toBeTruthy()

    await userEvent.click(within(card).getByRole('button', { name: /Undo — Yellow Brandywine/ }))
    expect(await within(card).findByText(/Start checking Yellow Brandywine/)).toBeTruthy()
    // The undo went through the by-id path, not the plural toggle.
    expect(del).toHaveBeenCalledTimes(1)
    const posts = fetchMock.mock.calls.filter(([u]) => u === DISMISS)
    expect(posts).toHaveLength(1) // only the dismissal itself
  })

  it('reverts the row when the write fails — the UI never rests on a write that did not land', async () => {
    fetchMock.mockImplementation((url) => url === WATCH
      ? Promise.resolve({ candidates: [brandywine()] })
      : Promise.reject(new Error('boom')))
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ }))

    expect(await within(card).findByText(/Could not save — try again\./)).toBeTruthy()
    // Row is back, dismissal is re-offered, and no false acknowledgement is left on screen.
    expect(within(card).getByText(/Start checking Yellow Brandywine/)).toBeTruthy()
    expect(within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ })).toBeTruthy()
    expect(card.textContent).not.toMatch(/Not checking Yellow Brandywine for now\./)
  })
})

describe('HarvestWatchBand — logging, empty states, and posture', () => {
  it('navigates to the prefilled harvest form — never one-tap POSTs a harvest', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Log harvest — Yellow Brandywine/ }))
    expect(navigateMock.mock.calls[0][0]).toBe('/log?project=proj-1&plant=p-yb&event_type=harvest')
    // `harvest` requires quantity + unit (both NOT NULL) — a one-tap POST from here would 400.
    expect(fetchMock.mock.calls.filter(([u]) => u !== WATCH)).toHaveLength(0)
  })

  it('renders nothing on an empty watch list', async () => {
    payload([])
    const { container } = render(<HarvestWatchBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(WATCH))
    expect(container.querySelector('section')).toBeNull()
  })

  it('renders nothing before the first load resolves', () => {
    payload([brandywine()])
    const { container } = render(<HarvestWatchBand />)
    expect(container.querySelector('section')).toBeNull()
  })

  it('shows nothing while the transient retry is still outstanding — never throws onto Today', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<HarvestWatchBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(WATCH))
    // Real timers: the RETRY_DELAY_MS gap has not elapsed, so a one-off blip is still invisible.
    expect(container.querySelector('section')).toBeNull()
  })

  // BUG-READYBANDFETCH-001 — a persistent outage must not look like "nothing is coming".
  it('a persistent fetch error renders the muted notice, not the empty state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fetchMock.mockRejectedValue(new Error('boom'))
      render(<HarvestWatchBand />)
      await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 50) })
      expect(screen.getByText(/Couldn’t check just now/i)).toBeTruthy()
    } finally { vi.useRealTimers() }
  })

  it('Reward-UX V102: ambient only — no celebration, no badge, no urgency copy', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    expect(card.textContent).not.toMatch(/streak|nice work|great|congrat|hurry|don'?t let|urgent|overdue|days left|waste|rot|!/i)
    expect(card.querySelector('[role="dialog"], [role="alert"], [role="status"]')).toBeNull()
  })

  it('mobile: both row controls clear the 48px touch floor (Chrome/Android, ~390px)', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    const notYet = within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ })
    const log = within(card).getByRole('button', { name: /Log harvest — Yellow Brandywine/ })
    expect(notYet.style.minHeight).toBe('48px')
    expect(log.style.minHeight).toBe('48px')
    // The dismissal writes training data and must not sit in the right-hand thumb zone where a
    // stray tap lands. DOM order pins it left of the (reversible, write-free) navigation.
    expect(notYet.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notYet.parentElement.style.justifyContent).toBe('space-between')
  })
})

// BD-007 / V4-BANDROWTAP-001 — the row headline IS the navigation to the planting detail: a plain
// react-router Link to /plantings/:plantingId (the canonical UN-scoped route), deliberately NOT
// useOverlayNavigate — the detail route is not in the overlayable set, so a background-carrying
// navigate would leave the overlay tree with no matching route. Same row-body Link convention as
// CareNeeded. The name tap must stay perfectly inert on the band's own state: no dismissal write,
// no overlay navigation, no row collapse — it is the reversible, write-free control on the row.
describe('HarvestWatchBand — the name tap (BD-007 / V4-BANDROWTAP-001)', () => {
  it('links each row headline to ITS planting detail — the right id per row', async () => {
    payload([brandywine(), basil()])
    render(<HarvestWatchBand />)
    const card = await band()
    const yb = within(card).getByRole('link', { name: /Start checking Yellow Brandywine/ })
    const bz = within(card).getByRole('link', { name: /Start checking Genovese Basil/ })
    // plant_id, never project_id — a project holds multiple sibling plantings.
    expect(yb.getAttribute('href')).toBe('/plantings/p-yb')
    expect(bz.getAttribute('href')).toBe('/plantings/p-bz')
  })

  it('a name tap fires neither the dismissal write nor the log navigation, and the row stays open', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('link', { name: /Start checking Yellow Brandywine/ }))
    // No write of any kind, and no imperative (overlay) navigation — href navigation only.
    expect(fetchMock.mock.calls.filter(([u]) => u !== WATCH)).toHaveLength(0)
    expect(navigateMock).not.toHaveBeenCalled()
    // The row did not collapse into the dismissed acknowledgement.
    expect(within(card).getByText(/Start checking Yellow Brandywine/)).toBeTruthy()
    expect(card.textContent).not.toMatch(/Not checking Yellow Brandywine/)
  })

  it('mobile: the name target clears 44px with both 48px buttons intact — and Log harvest still navigates', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    const link = within(card).getByRole('link', { name: /Start checking Yellow Brandywine/ })
    expect(parseInt(link.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    // Same typography as the old headline — the check-form voice keeps its exact weight.
    expect(link.style.fontSize).toBe('0.88rem')
    expect(link.style.textDecoration).toBe('none')
    // The buttons keep their own 48px row: nothing shrank to make room for the link.
    const notYet = within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ })
    const log = within(card).getByRole('button', { name: /Log harvest — Yellow Brandywine/ })
    expect(notYet.style.minHeight).toBe('48px')
    expect(log.style.minHeight).toBe('48px')
    await userEvent.click(log)
    expect(navigateMock.mock.calls[0][0]).toBe('/log?project=proj-1&plant=p-yb&event_type=harvest')
  })

  it('a dismissed row carries no link — Undo is the only control', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Not yet — Yellow Brandywine/ }))
    await within(card).findByText(/Not checking Yellow Brandywine for now\./)
    expect(within(card).queryByRole('link')).toBeNull()
    expect(within(card).getByRole('button', { name: /Undo — Yellow Brandywine/ })).toBeTruthy()
  })
})

// PANEL Q4 — the expandable tail. One tail per section; in-place expand DOWNWARD (content inserted
// after the trigger, so its top edge keeps its viewport y); count in the button label, never a pill.
describe('HarvestWatchBand — the tail (panel Q4)', () => {
  const many = (n, over = (i) => ({})) => Array.from({ length: n }, (_, i) =>
    brandywine({
      plant_id: `p${String(i).padStart(2, '0')}`, project_id: `proj-${i}`,
      name: `Row ${String(i).padStart(2, '0')}`, watching_since: '2026-08-05', ...over(i),
    }))

  it('overflow is a real full-width expand control, not dead text', async () => {
    payload(many(9))
    render(<HarvestWatchBand />)
    const card = await band()
    const btn = within(card).getByRole('button', { name: 'Show 4 more worth checking' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.getAttribute('aria-controls')).toBe('harvest-watch-tail')
    // Mobile floor: full-width, >=48px tall (52 matches CareNeeded's pattern).
    expect(btn.style.width).toBe('100%')
    expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(48)
    // The count lives in the LABEL — no pill anywhere in the band.
    expect(card.textContent).not.toMatch(/\+\d+ more/)

    await userEvent.click(btn)
    expect(within(card).getAllByRole('listitem')).toHaveLength(9)
    // Trigger keeps its place ABOVE the expanded content — expansion goes downward only.
    const panel = card.querySelector('#harvest-watch-tail')
    expect(btn.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // A second collapse control sits at the bottom.
    const fewer = within(card).getByRole('button', { name: /Show fewer/ })
    await userEvent.click(fewer)
    expect(within(card).getAllByRole('listitem')).toHaveLength(5)
  })

  it('groups the expanded overflow by location', async () => {
    payload(many(8, (i) => ({ location_name: i < 6 ? 'Hilltop bed 2' : 'Kitchen bed' })))
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Show 3 more worth checking/ }))
    const panel = card.querySelector('#harvest-watch-tail')
    expect(panel.textContent).toMatch(/Hilltop bed 2/)
    expect(panel.textContent).toMatch(/Kitchen bed/)
  })

  it('reveals 20 at a time above 25 hidden, remaining count staying on the trigger', async () => {
    payload(many(40))
    render(<HarvestWatchBand />)
    const card = await band()
    const btn = within(card).getByRole('button', { name: 'Show 35 more worth checking' })
    await userEvent.click(btn)
    expect(within(card).getAllByRole('listitem')).toHaveLength(25)
    const btn2 = within(card).getByRole('button', { name: 'Show 15 more worth checking' })
    await userEvent.click(btn2)
    expect(within(card).getAllByRole('listitem')).toHaveLength(40)
    expect(within(card).queryByRole('button', { name: /more worth checking/ })).toBeNull()
    expect(within(card).getByRole('button', { name: /Show fewer/ })).toBeTruthy()
  })

  it('the Snoozed subgroup defaults collapsed and prints return dates when opened', async () => {
    payload(many(8), {
      snoozed: [
        { plant_id: 's1', project_id: 'proj-s', name: 'Charentais', location_name: 'Hilltop bed 2', crop_display_name: 'Melon', suppressed_until: '2026-08-20', reason: 'dismissed' },
        { plant_id: 's2', project_id: 'proj-s', name: 'Old Row', location_name: null, crop_display_name: 'Melon', suppressed_until: null, reason: 'dismissed' },
      ],
    })
    render(<HarvestWatchBand />)
    const card = await band()
    await userEvent.click(within(card).getByRole('button', { name: /Show 3 more worth checking/ }))
    const snoozeBtn = within(card).getByRole('button', { name: /Snoozed \(2\)/ })
    expect(snoozeBtn.getAttribute('aria-expanded')).toBe('false')
    expect(card.textContent).not.toMatch(/back Aug 20/)
    await userEvent.click(snoozeBtn)
    expect(within(card).getByText(/back Aug 20/)).toBeTruthy()
    // A pre-bounded season-long row states that honestly instead of inventing a date.
    expect(within(card).getByText(/snoozed for the season/)).toBeTruthy()
  })

  it('snoozed rows stay reachable when every candidate is suppressed (R6)', async () => {
    payload([], {
      snoozed: [{ plant_id: 's1', project_id: 'p', name: 'Charentais', location_name: null, crop_display_name: 'Melon', suppressed_until: '2026-08-20', reason: 'dismissed' }],
    })
    render(<HarvestWatchBand />)
    const card = await band()
    const snoozeBtn = within(card).getByRole('button', { name: /Snoozed \(1\)/ })
    await userEvent.click(snoozeBtn)
    expect(within(card).getByText(/back Aug 20/)).toBeTruthy()
  })
})

// NAMED MUTATION TARGETS (each must turn the listed test red):
//   "Start checking {name}" -> "{name} is ready"        => the check-form test
//   drop <HarvestWindow observable> / return null early  => "names the observable"
//   qualifier always null in observableFrom              => crop-fallback + low-confidence tests
//   hide the row when no window resolves                 => the basil degradation test
//   slice(0, MAX_WATCH_ROWS) -> no slice                 => the cap-at-five test
//   sort ascending in rankWatchCandidates                => the newest-first test
//   dismissal that does not POST / posts dismissed:false => the dismissal test
//   .catch that keeps `dismissed: true` on failure       => the write-failure revert test
//   one-tap POST instead of overlayNavigate              => the navigate test
//   minHeight 48 -> unset, or controls reordered         => the mobile touch-floor test
//   headline Link dropped, or href built from project_id => the BD-007 right-id href test
//   name Link wired to dismissRow or overlayNavigate     => the BD-007 name-tap isolation test
