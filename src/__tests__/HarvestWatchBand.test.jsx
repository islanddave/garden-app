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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const navigateMock = vi.fn()
const locationRef = { pathname: '/today' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
  Link: ({ children }) => <a>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import HarvestWatchBand from '../components/HarvestWatchBand.jsx'

const WATCH = '/api/harvests/watch'
const DISMISS = '/api/harvests/watch/dismiss'

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

const payload = (candidates) => fetchMock.mockImplementation((url) =>
  Promise.resolve(url === WATCH ? { candidates } : null))

beforeEach(() => { navigateMock.mockReset(); fetchMock.mockReset() })

const band = () => screen.findByRole('region', { name: /Worth checking this week/i })

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

  it('titles the group as a watch list and frames it as a plan, not tonight’s dinner', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    expect(within(card).getByText('Worth checking this week')).toBeTruthy()
    expect(within(card).getByText(/The start of a stream, not tonight’s dinner\./)).toBeTruthy()
  })
})

describe('HarvestWatchBand — the observable (design §3.2, the unlock)', () => {
  it('names the observable from the shipped colour-window dataset', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    // Async: the dataset is a lazily-imported chunk, so this must be a findBy.
    expect(await within(card).findByText('colour break (green to pale amber)')).toBeTruthy()
    expect(within(card).getByText(/Look for:/)).toBeTruthy()
  })

  it('renders a cultivar-sourced observable with NO provenance qualifier', async () => {
    payload([brandywine()])
    render(<HarvestWatchBand />)
    const card = await band()
    await within(card).findByText('colour break (green to pale amber)')
    expect(card.textContent).not.toMatch(/general guidance for this crop|derived from the variety type/)
  })

  it('labels a crop-level fallback as general guidance, not as a claim about the variety', async () => {
    payload([brandywine({
      plant_id: 'p-unk', name: 'Unlisted Heirloom',
      variety_ref: { name: 'No Such Cultivar At All', crop_type_slug: 'tomato' },
    })])
    render(<HarvestWatchBand />)
    const card = await band()
    expect(await within(card).findByText('mature green')).toBeTruthy()
    expect(within(card).getByText(/\(general guidance for this crop, not this variety\)/)).toBeTruthy()
  })

  it('labels a low-confidence cultivar record as derived', async () => {
    payload([brandywine({
      plant_id: 'p-cl', name: 'Cape Liente',
      variety_ref: { name: 'Cape Liente', crop_type_slug: 'pepper' },
    })])
    render(<HarvestWatchBand />)
    const card = await band()
    await within(card).findByText('mature green')
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
    payload([
      brandywine({ plant_id: 'a', name: 'Older Row', watching_since: '2026-07-20' }),
      brandywine({ plant_id: 'b', name: 'Newest Row', watching_since: '2026-08-10' }),
      brandywine({ plant_id: 'c', name: 'Middle Row', watching_since: '2026-08-02' }),
    ])
    render(<HarvestWatchBand />)
    const card = await band()
    const items = within(card).getAllByRole('listitem').map(li => li.textContent)
    expect(items[0]).toMatch(/Newest Row/)
    expect(items[1]).toMatch(/Middle Row/)
    expect(items[2]).toMatch(/Older Row/)
  })

  it('caps the visible group at five — a nine-row declarative group is an inventory again', async () => {
    payload(Array.from({ length: 9 }, (_, i) =>
      brandywine({ plant_id: `p${i}`, name: `Row ${i}`, watching_since: `2026-08-0${i + 1}` })))
    render(<HarvestWatchBand />)
    const card = await band()
    expect(within(card).getAllByRole('listitem')).toHaveLength(5)
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

  it('swallows a fetch error — renders nothing, never throws onto Today', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<HarvestWatchBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(WATCH))
    expect(container.querySelector('section')).toBeNull()
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
