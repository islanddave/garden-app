// V4-HARVWEIGHTREAD-001 slice 2 — the harvest weight on PlantingDetail.
//
// Slice 1 put the weight on the Harvests log. PlantingDetail's timeline was the deferred surface, and
// it is the harder one: GET /api/events (its event source) never joins harvest_log, so the page has
// to reach the harvests read model itself. These pin the distinctions a plausible implementation
// collapses:
//   * the timeline says the SAME thing the Harvests log says — same ≈, same provenance sentence
//   * "we could not load it" must NOT render as "it has no weight" (the two are different facts)
//   * the enhancement fetch is scoped to THIS planting, and its failure is silent
//   * a cumulative total never implies more precision than it has
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
// V4-RIPENESSCUES-001: CropCard lazy-loads the colour-window resolver in an effect — stub it to
// the sync no-window resolver so nothing async mutates state mid-test (no act() churn; absence
// assertions race-free). Window rendering is covered in CropCard.window*.test.jsx.
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'
import { ESTIMATE_SOURCE_COPY, ESTIMATE_SOURCE_FALLBACK, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'

const PLANTING = {
  id: 'pl1', name: 'Megatron Jalapeno', project_id: 'proj1', project_name: 'Peppers 2026',
  status: 'fruiting', quantity: 3, variety_ref: { name: 'Megatron F4', crop_type_slug: 'pepper' },
  featured_photo_view_url: null,
}
// The timeline as GET /api/events returns it: no quantity, no unit, no weight — which is exactly why
// the page needs the harvests read model at all.
const EVENTS = [
  { id: 'ev-h2', event_type: 'harvest', event_date: '2026-06-01T12:00:00Z', plant_id: 'pl1', title: 'Big pick' },
  { id: 'ev-h1', event_type: 'first_harvest', event_date: '2026-05-20T12:00:00Z', plant_id: 'pl1', title: 'First pick' },
  { id: 'ev-w1', event_type: 'watering', event_date: '2026-05-19T12:00:00Z', plant_id: 'pl1', title: 'Watered' },
]
const ENTRY = {
  event_id: 'ev-h2', event_type: 'harvest', day_key: '2026-06-01',
  plant_id: 'pl1', project_id: 'proj1', harvest_log_id: 'h1', quantity: 4, unit: 'count',
}

// `harvests` is the /api/harvests payload (or an Error to reject with). Everything else is a fixed
// happy path so a failure here can only be about weight.
function renderWith(harvests) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (path.startsWith('/api/harvests')) {
      return harvests instanceof Error ? Promise.reject(harvests) : Promise.resolve(harvests)
    }
    if (path.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
    if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { apiFetchSpy.mockReset(); window.scrollTo = vi.fn() })

describe('PlantingDetail timeline — weight chip', () => {
  it('marks an ESTIMATE with ≈ and carries the same provenance sentence as the Harvests log', async () => {
    renderWith({ entries: [{ ...ENTRY, weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' }] })
    const chip = await screen.findByTestId('harvest-weight')
    expect(chip.textContent).toBe('≈ 492 g')
    expect(chip.getAttribute('title')).toBe(ESTIMATE_SOURCE_COPY.cultivar)
    expect(chip.getAttribute('aria-label')).toBe('Estimated weight: 492 g')
  })

  // V4-HARVWEIGHTSURF-001 — the provenance must be VISIBLE, not only in `title`. Dave's only
  // surface is Chrome on Android, where a title attribute never fires: no hover exists, so the
  // sentence below was rendered to a dead-end attribute and the basis axis collapsed onto the bare
  // ≈. These pin the sentence as rendered text, with the chip's own contract left byte-identical.
  it('renders the provenance sentence as VISIBLE text, not only as a title attribute', async () => {
    renderWith({ entries: [{ ...ENTRY, weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar_sample' }] })
    const src = await screen.findByTestId('harvest-weight-source')
    expect(src.textContent).toBe(ESTIMATE_SOURCE_COPY.cultivar_sample)
    // Rendered text, reachable without any pointer interaction at all.
    expect(screen.getByText(ESTIMATE_SOURCE_COPY.cultivar_sample)).toBeTruthy()
    // The chip is untouched: same text, same testid, same title/aria-label as before.
    const chip = screen.getByTestId('harvest-weight')
    expect(chip.textContent).toBe('≈ 492 g')
    expect(chip.getAttribute('title')).toBe(ESTIMATE_SOURCE_COPY.cultivar_sample)
    // Sibling, not child — the sentence must not leak into the chip's own text contract.
    expect(chip.contains(src)).toBe(false)
  })

  it('uses the shared vocabulary verbatim for every basis, including the unknown-value fallback', async () => {
    for (const [basis, copy] of [
      ['cultivar', ESTIMATE_SOURCE_COPY.cultivar],
      ['crop_type', ESTIMATE_SOURCE_COPY.crop_type],
      // The enum has grown twice; an unrecognised value must degrade to the generic sentence
      // rather than render `undefined` into it (harvestWeight.js's ?? fallback).
      ['some_future_tier', ESTIMATE_SOURCE_FALLBACK],
    ]) {
      const { unmount } = renderWith({ entries: [{ ...ENTRY, weight_grams: 492, weight_estimated: true, weight_basis: basis }] })
      expect((await screen.findByTestId('harvest-weight-source')).textContent).toBe(copy)
      unmount()
      apiFetchSpy.mockReset()
    }
  })

  it('spends no line on a MEASURED row — the absent ≈ already says it was weighed', async () => {
    renderWith({ entries: [{ ...ENTRY, weight_grams: 337, weight_estimated: false, weight_basis: 'measured' }] })
    await screen.findByTestId('harvest-weight')
    expect(screen.queryByTestId('harvest-weight-source')).toBeNull()
    expect(screen.queryByText(/Currently estimated/)).toBeNull()
  })

  it('renders a MEASURED weight without the ≈, and does not call it an estimate', async () => {
    renderWith({ entries: [{ ...ENTRY, weight_grams: 337, weight_estimated: false, weight_basis: 'measured' }] })
    const chip = await screen.findByTestId('harvest-weight')
    expect(chip.textContent).toBe('337 g')
    expect(chip.textContent).not.toContain('≈')
    expect(chip.getAttribute('aria-label')).toBe('Weighed: 337 g')
  })

  it('a quantified harvest with no derivable weight reads as "not yet", never 0 g', async () => {
    renderWith({ entries: [{ ...ENTRY, weight_grams: null, weight_estimated: null, weight_basis: null }] })
    const none = await screen.findByTestId('harvest-weight-none')
    expect(none.textContent).toBe('no weight yet')
    expect(none.getAttribute('title')).toBe(NO_WEIGHT_COPY)
    expect(screen.queryByTestId('harvest-weight')).toBeNull()
    expect(screen.queryByText(/\b0 g\b/)).toBeNull()
  })

  it('the chip lands on the matching event row only — a watering event gets nothing', async () => {
    renderWith({ entries: [{ ...ENTRY, weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' }] })
    await screen.findByTestId('harvest-weight')
    // Three events render; exactly one of them is the one the read model priced.
    expect(screen.getAllByTestId('harvest-weight')).toHaveLength(1)
    expect(screen.getByText('Watered')).toBeTruthy()
    expect(screen.queryAllByTestId('harvest-weight-none')).toHaveLength(0)
  })

  it('an event the read model did not return renders NO chip — unloaded is not unweighed', async () => {
    // ev-h1 is a harvest in the timeline but absent from entries (older than the page, or filtered).
    // Rendering "no weight yet" there would assert a fact about data we never received.
    renderWith({ entries: [{ ...ENTRY, weight_grams: 337, weight_estimated: false, weight_basis: 'measured' }] })
    await screen.findByTestId('harvest-weight')
    expect(screen.getByText('First pick')).toBeTruthy()
    expect(screen.queryByTestId('harvest-weight-none')).toBeNull()
  })

  it('scopes the harvests read to THIS planting rather than filtering a project-wide page client-side', async () => {
    renderWith({ entries: [] })
    // Wait on something that DOES appear. The harvests fetch is issued from the same effect pass as
    // the event fetch, so once the log has rendered the call has already been made — waiting on the
    // absent chip instead would just burn the findBy timeout on every run.
    await screen.findByText('Big pick')
    const call = apiFetchSpy.mock.calls.map(c => c[0]).find(p => String(p).startsWith('/api/harvests'))
    expect(call, 'PlantingDetail never fetched the harvests read model').toBeTruthy()
    expect(call).toContain('plant=pl1')
    expect(call).toContain('include=entries')
  })

  it('a failed weight fetch leaves the timeline intact and says nothing about weight', async () => {
    renderWith(new Error('boom'))
    // The event log is the page's spine — it renders exactly as it did before this feature.
    expect(await screen.findByText('Big pick')).toBeTruthy()
    expect(screen.queryByTestId('harvest-weight')).toBeNull()
    expect(screen.queryByTestId('harvest-weight-none')).toBeNull()
    expect(screen.queryByTestId('planting-weight-total')).toBeNull()
  })
})

describe('PlantingDetail — cumulative weight for the planting', () => {
  it('sums measured and estimated together but says how the total is made up', async () => {
    renderWith({ entries: [
      { ...ENTRY, event_id: 'ev-h2', weight_grams: 300, weight_estimated: false, weight_basis: 'measured' },
      { ...ENTRY, event_id: 'ev-h1', weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' },
      { ...ENTRY, event_id: 'ev-h0', weight_grams: null, weight_estimated: null, weight_basis: null },
    ] })
    const total = await screen.findByTestId('planting-weight-total')
    expect(total.textContent).toBe('≈ 792 g')
    expect(total.getAttribute('aria-label')).toBe('Estimated total harvest weight: 792 g')
    // The qualifier is what stops the number reading as fully measured.
    expect(screen.getByTestId('planting-weight-basis').textContent)
      .toBe('1 weighed · 1 estimated · 1 with no weight yet')
  })

  it('drops the ≈ when every contributing row was actually weighed', async () => {
    renderWith({ entries: [
      { ...ENTRY, event_id: 'ev-h2', weight_grams: 300, weight_estimated: false, weight_basis: 'measured' },
      { ...ENTRY, event_id: 'ev-h1', weight_grams: 700, weight_estimated: false, weight_basis: 'measured' },
    ] })
    const total = await screen.findByTestId('planting-weight-total')
    expect(total.textContent).toBe('1 kg')
    expect(total.getAttribute('aria-label')).toBe('Total harvest weight: 1 kg')
    expect(screen.getByTestId('planting-weight-basis').textContent).toBe('2 weighed')
  })

  it('with nothing weighable it shows the ratchet copy, not a zero total', async () => {
    renderWith({ entries: [
      { ...ENTRY, event_id: 'ev-h2', weight_grams: null, weight_estimated: null, weight_basis: null },
      { ...ENTRY, event_id: 'ev-h1', weight_grams: null, weight_estimated: null, weight_basis: null },
    ] })
    const none = await screen.findByTestId('planting-weight-none')
    expect(none.textContent).toBe(NO_WEIGHT_COPY)
    expect(screen.queryByTestId('planting-weight-total')).toBeNull()
    expect(screen.getByTestId('planting-weight-basis').textContent).toBe('2 with no weight yet')
  })

  it('renders no total block at all for a planting with no harvests', async () => {
    renderWith({ entries: [] })
    expect(await screen.findByText('Big pick')).toBeTruthy()
    expect(screen.queryByTestId('planting-weight-total')).toBeNull()
    expect(screen.queryByTestId('planting-weight-none')).toBeNull()
    expect(screen.queryByTestId('planting-weight-basis')).toBeNull()
  })

  // SPLIT-ARTIFACT CONTRACT (pre-promote regression pass, finding I1). The SPA and the harvests
  // Lambda deploy on separate legs. Against the PREVIOUS harvests Lambda this page gets entries that
  // (a) ignore the unknown `plant=` param, so they are household-wide and capped at PAGE_LIMIT, and
  // (b) carry no weight_grams key at all, because the old projectEntry() never projected it. Summed
  // naively that announces "50 with no weight yet" on EVERY planting — including ones with no
  // harvests. Wrong is worse than absent, so the whole block must stay dark until the wire carries
  // the field. Note this is the ONE case that must not reuse the ratchet copy: "no weight yet" is a
  // claim about the harvest, and we have not yet earned the right to make it.
  it('renders nothing when the wire predates the weight columns — wrong is worse than absent', async () => {
    renderWith({ entries: [
      { ...ENTRY, event_id: 'ev-h2' },
      { ...ENTRY, event_id: 'ev-h1' },
    ] })
    expect(await screen.findByText('Big pick')).toBeTruthy()
    expect(screen.queryByTestId('planting-weight-total')).toBeNull()
    expect(screen.queryByTestId('planting-weight-none')).toBeNull()
    expect(screen.queryByTestId('planting-weight-basis')).toBeNull()
  })

  // The discriminator is `undefined` vs `null`, not truthiness. A pick the new Lambda reports as
  // genuinely unweighed sends weight_grams: null, and that MUST still render the ratchet copy —
  // otherwise the split-artifact guard above would also blank the real "go weigh one" prompt, which
  // is the entire read-side feature. Pins `'weight_grams' in en` against a `!= null` shortcut.
  it('a null weight still counts as wire support — the guard must not swallow the ratchet copy', async () => {
    renderWith({ entries: [{ ...ENTRY, event_id: 'ev-h2', weight_grams: null, weight_estimated: null, weight_basis: null }] })
    expect(await screen.findByTestId('planting-weight-none')).toBeTruthy()
  })
})
