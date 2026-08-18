// BUG-PLANTHARVCURSOR-001 — PlantingDetail past the 50-row harvest page.
//
// The harvests read model pages entries at PAGE_LIMIT = 50 (lambda/harvests/index.js) and returns a
// `cursor` when more remain. PlantingDetail issued ONE un-drained fetch and summed its entries, so a
// planting past 50 picks printed a total short by everything after the boundary — no error, no
// indicator, just a smaller number. Understatement is the worst direction here: it is the failure
// Dave would believe.
//
// Prod at the time of writing: Pineapple Tomatillo 45 picks at 1.71/day, i.e. it crosses 50 in ~3
// days; Cherry Falls 44 and Blueberries 41 follow. Nothing was over the boundary yet, so this file
// is the only place the defect can be shown at all — the fixtures ARE the evidence.
//
// The two halves are deliberately independent, and that is the design being pinned:
//   * the TOTAL comes from the server's un-capped aggregate (exact by construction, one request)
//   * the per-row CHIPS come from a bounded drain (the UI renders every event, so it needs every row)
// A drain that fails can therefore cost chips but can never make the total wrong.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail, { MAX_HARVEST_PAGES } from '../pages/PlantingDetail.jsx'

const PLANTING = {
  id: 'pl1', name: 'Pineapple Tomatillo', project_id: 'proj1', project_name: 'Tomatillos 2026',
  status: 'fruiting', quantity: 3, variety_ref: { name: 'Pineapple', crop_type_slug: 'tomatillo' },
  featured_photo_view_url: null,
}

const N = 60           // harvests on the planting — past the boundary
const PAGE = 50        // the server's PAGE_LIMIT
const GRAMS = 100      // per pick, so the true total is unmistakable: 6 kg, not the 5 kg of page one

const evId = (i) => `ev-h${i}`
// Newest first, the order both /api/events and the harvests read model use.
const EVENTS = Array.from({ length: N }, (_, i) => ({
  id: evId(i + 1), event_type: 'harvest', event_date: `2026-06-${String(30 - i % 28).padStart(2, '0')}T12:00:00Z`,
  plant_id: 'pl1', title: `Pick ${i + 1}`,
}))
const entry = (i) => ({
  event_id: evId(i + 1), event_type: 'harvest', day_key: '2026-06-01',
  plant_id: 'pl1', project_id: 'proj1', harvest_log_id: `h${i + 1}`, quantity: 4, unit: 'count',
  weight_grams: GRAMS, weight_estimated: false, weight_basis: 'measured',
})
const ALL_ENTRIES = Array.from({ length: N }, (_, i) => entry(i))

const weightObj = (grams, count) => ({
  grams, measured_grams: grams, estimated_grams: 0, measured: count, estimated: 0, unweighed: 0,
})
// The planting-grain member of the GROUPING SETS roll-up, deliberately DIFFERENT from the grand
// total: `aggregates.weight` is the whole filter range, which is this planting only when the Lambda
// honours ?plant=. Reading the planting grain instead is correct under both Lambda generations, and
// this divergence is what proves which one the page reads.
const HOUSEHOLD_GRAMS = 9000
const aggregates = ({ plantingWeight = weightObj(N * GRAMS, N) } = {}) => ({
  crops: [], other: [], weekly: [], crop_list: [], unquantified_total: 0,
  weight: weightObj(HOUSEHOLD_GRAMS, 90),
  first_pick: [
    { plant_id: 'pl1', planting_name: 'Pineapple Tomatillo', crop_type_slug: 'tomatillo', first_pick_date: '2026-06-04', weight: plantingWeight },
    { plant_id: 'pl9', planting_name: 'Cherry Falls', crop_type_slug: 'tomato', first_pick_date: '2026-06-10', weight: weightObj(3000, 30) },
  ],
})

// A cursor-bearing paged harvests endpoint. `pages` is an array of {entries, cursor} keyed by
// arrival order; the spy hands back the page whose cursor the request asked for.
function mountPaged({ pages, aggs, onHarvestCall } = {}) {
  const calls = []
  apiFetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (p.startsWith('/api/harvests')) {
      calls.push(p)
      onHarvestCall?.(p)
      const cur = new URL(p, 'http://x').searchParams.get('cursor')
      const idx = cur == null ? 0 : pages.findIndex((pg) => pg.cursor === cur)
      const page = idx === -1 ? { entries: [] } : pages[idx]
      const body = { entries: page.entries, cursor: page.next ?? null }
      // Aggregates ride the FIRST request only, exactly as the server computes them: full range,
      // no cursor, no limit. A drain page asking for them again is 11 wasted GROUPING SETS passes.
      if (aggs !== null && cur == null) body.aggregates = aggs ?? aggregates()
      return Promise.resolve(body)
    }
    if (p.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
    if (p.startsWith('/api/events')) return Promise.resolve(EVENTS)
    return Promise.resolve(null)
  })
  const view = render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
      </Routes>
    </MemoryRouter>,
  )
  return { ...view, calls }
}

// The shape prod is about to be in: one full page plus a short second one.
const TWO_PAGES = [
  { entries: ALL_ENTRIES.slice(0, PAGE), next: 'cur-2' },
  { cursor: 'cur-2', entries: ALL_ENTRIES.slice(PAGE), next: null },
]

beforeEach(() => { apiFetchSpy.mockReset(); window.scrollTo = vi.fn() })

describe('BUG-PLANTHARVCURSOR-001 — the total past 50 harvests', () => {
  it('reports the FULL total for a planting past the 50-row page, not the first page sum', async () => {
    mountPaged({ pages: TWO_PAGES })
    const total = await screen.findByTestId('planting-weight-total')
    // 60 picks x 100 g. A first-page sum reads 5 kg; anything but 6 kg is the truncation.
    expect(total.textContent).toBe('6 kg')
    expect(screen.getByTestId('planting-weight-basis').textContent).toBe('60 weighed')
  })

  it('takes the planting-grain aggregate, never the household grand total', async () => {
    mountPaged({ pages: TWO_PAGES })
    const total = await screen.findByTestId('planting-weight-total')
    // aggregates.weight is 9 kg across the household. Rendering it here would be a far louder lie
    // than the truncation this row is about.
    expect(total.textContent).not.toBe('9 kg')
    expect(total.textContent).toBe('6 kg')
  })

  it('does not re-request the un-capped aggregate on every drain page', async () => {
    const { calls } = mountPaged({ pages: TWO_PAGES })
    await screen.findByTestId('planting-weight-total')
    const withAggs = calls.filter((p) => p.includes('include=entries,aggregates'))
    expect(withAggs).toHaveLength(1)
    // Every follow-up page is entries-only; the server recomputes the GROUPING SETS roll-up over the
    // full range on any request that asks for aggregates.
    expect(calls.filter((p) => p.includes('cursor=')).every((p) => !p.includes('aggregates'))).toBe(true)
  })

  it('still totals correctly when the whole planting fits in one page', async () => {
    const small = ALL_ENTRIES.slice(0, 3)
    mountPaged({
      pages: [{ entries: small, next: null }],
      aggs: aggregates({ plantingWeight: weightObj(300, 3) }),
    })
    const total = await screen.findByTestId('planting-weight-total')
    expect(total.textContent).toBe('300 g')
    expect(screen.getByTestId('planting-weight-basis').textContent).toBe('3 weighed')
    expect(apiFetchSpy.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('cursor='))).toHaveLength(0)
  })
})

describe('BUG-PLANTHARVCURSOR-001 — the timeline past 50 harvests', () => {
  it('annotates harvests after the page boundary, not only the first 50', async () => {
    mountPaged({ pages: TWO_PAGES })
    await screen.findByTestId('planting-weight-total')
    // The event log reveals 50 at a time; the 51st..60th picks are behind Show more.
    fireEvent.click(screen.getByTestId('event-log-show-more'))
    expect(screen.getByText(`Pick ${N}`)).toBeTruthy()
    expect(screen.getAllByTestId('harvest-weight')).toHaveLength(N)
    // "unloaded" must never have rendered as "unweighed" on the way there.
    expect(screen.queryAllByTestId('harvest-weight-none')).toHaveLength(0)
  })
})

describe('BUG-PLANTHARVCURSOR-001 — the drain cannot run away or lie', () => {
  // A server that keeps handing back a cursor (a bug, or a cache replaying one page) must not spin
  // forever. The bound is the BUG-EXPORTDRAINBOUND-001 precedent: stop, and treat the rowset as a
  // prefix rather than as the whole thing.
  it('stops on a never-ending cursor instead of looping forever', async () => {
    let harvestCalls = 0
    apiFetchSpy.mockImplementation((path) => {
      const p = String(path)
      if (p.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (p.startsWith('/api/harvests')) {
        harvestCalls += 1
        if (harvestCalls > 500) throw new Error('drain never terminated')
        const body = { entries: ALL_ENTRIES.slice(0, PAGE), cursor: `cur-${harvestCalls}` }
        if (!p.includes('cursor=')) body.aggregates = aggregates()
        return Promise.resolve(body)
      }
      if (p.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
      if (p.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    render(
      <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
        <Routes><Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} /></Routes>
      </MemoryRouter>,
    )
    // The total still lands, because it never depended on the drain finishing.
    const total = await screen.findByTestId('planting-weight-total')
    expect(total.textContent).toBe('6 kg')
    expect(harvestCalls).toBeLessThanOrEqual(MAX_HARVEST_PAGES)
    expect(harvestCalls).toBeGreaterThan(1)
  })

  // A cache or a buggy keyset can hand back the SAME cursor forever. The bound would eventually
  // catch it, but re-fetching one page N times first is pure waste, so a non-advancing cursor ends
  // the drain immediately.
  it('stops when the cursor stops advancing', async () => {
    let harvestCalls = 0
    apiFetchSpy.mockImplementation((path) => {
      const p = String(path)
      if (p.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (p.startsWith('/api/harvests')) {
        harvestCalls += 1
        const body = { entries: ALL_ENTRIES.slice(0, PAGE), cursor: 'stuck' }
        if (!p.includes('cursor=')) body.aggregates = aggregates()
        return Promise.resolve(body)
      }
      if (p.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
      if (p.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    render(
      <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
        <Routes><Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} /></Routes>
      </MemoryRouter>,
    )
    await screen.findByTestId('planting-weight-total')
    // Page 1, then the repeat that reveals the cursor is stuck. No third request.
    expect(harvestCalls).toBe(2)
  })

  // The aggregate-less leg of the split-artifact contract. An older harvests Lambda projects
  // weight_grams but predates the planting-grain roll-up, so the client sum is the only total
  // available — and it is EXACT once the drain has run, which is the whole point of draining.
  it('falls back to summing a COMPLETE drain when the wire carries no aggregate', async () => {
    mountPaged({ pages: TWO_PAGES, aggs: null })
    const total = await screen.findByTestId('planting-weight-total')
    expect(total.textContent).toBe('6 kg')
    expect(screen.getByTestId('planting-weight-basis').textContent).toBe('60 weighed')
  })

  // ...but a sum over a rowset the wire itself said was incomplete is the original bug wearing a
  // new hat. With no aggregate and no finished drain there is no honest number to print, so the
  // block stays dark — wrong is worse than absent, the same rule the weight-column guard follows.
  it('prints no total when the drain is incomplete and there is no aggregate to fall back on', async () => {
    let harvestCalls = 0
    apiFetchSpy.mockImplementation((path) => {
      const p = String(path)
      if (p.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (p.startsWith('/api/harvests')) {
        harvestCalls += 1
        // Page 1 lands; the drain page fails, so the entries in hand are a known prefix.
        return p.includes('cursor=')
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ entries: ALL_ENTRIES.slice(0, PAGE), cursor: 'cur-2' })
      }
      if (p.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
      if (p.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    render(
      <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
        <Routes><Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Pick 1')).toBeTruthy()
    expect(harvestCalls).toBeGreaterThan(1)
    expect(screen.queryByTestId('planting-weight-total')).toBeNull()
    expect(screen.queryByTestId('planting-weight-none')).toBeNull()
    expect(screen.queryByTestId('planting-weight-basis')).toBeNull()
    // The prefix we DID load still annotates its own rows — "unloaded" costs a chip, not a lie.
    expect(screen.getAllByTestId('harvest-weight')).toHaveLength(PAGE)
  })
})
