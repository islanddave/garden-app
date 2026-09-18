// V5-SEEDSTAB-001 §5.1 — the My seeds view: every packet and saved lot, one row each.
//
// Mounted through a tiny host that owns a real useSeedItems() store, exactly as the Seeds shell does,
// so the stepper's write goes through the same patch path the page uses. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))

import { MemoryRouter } from 'react-router-dom'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'

const SOURCES = [{ id: 'src-fedco', name: 'Fedco' }, { id: 'src-baker', name: 'Baker Creek' }]
const CROPS = [{ slug: 'tomato', display_name: 'Tomato' }, { slug: 'pepper', display_name: 'Pepper' }]

const pkt = (over = {}) => ({
  id: 'p', name: 'Sungold', variety_name: 'Sungold', category: 'seeds', type: 'consumable', unit: 'packet',
  status: 'active', quantity_on_hand: 1, variety_id: 'v-sungold', crop_slug: 'tomato', seed_stage: null,
  seed_process: null, source_plant_id: null, source_kind: null, source_id: null, source: null,
  purchase_date: null, year_harvested: null, stage_entered_at: null, seed_count: null, seed_weight_g: null,
  seed_count_estimated: null, sow_archived_season: null, created_at: '2026-07-01T12:00:00Z',
  ...over,
})

let rows
let putBodies
beforeEach(() => {
  fetchSpy.mockReset()
  putBodies = []
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method === 'PUT') {
      const body = JSON.parse(opts.body)
      putBodies.push(body)
      return Promise.resolve({ id: body.id, quantity_on_hand: body.quantity_on_hand })
    }
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(rows)
    if (p.startsWith('/api/varieties/sources')) return Promise.resolve(SOURCES)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve(CROPS)
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

function Host({ highlight = null, onGoToLot = () => {} }) {
  const store = useSeedItems()
  return <MySeeds store={store} highlight={highlight} onGoToLot={onGoToLot} />
}
const mount = async (props = {}) => {
  let utils
  await act(async () => {
    utils = render(<MemoryRouter><ToastProvider><Host {...props} /></ToastProvider></MemoryRouter>)
  })
  await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
  return utils
}
const rowFor = (id) => document.querySelector(`[data-lot-id="${id}"]`)
const lineOf = (id) => within(rowFor(id)).getByTestId('my-seed-line').textContent.replace(/\s+/g, ' ').trim()

describe('My seeds — what each row says', () => {
  it('bought packets: how much · registry vendor · bought year — never the order text', async () => {
    rows = [pkt({ id: 'a', quantity_on_hand: 3, source_id: 'src-fedco', source: 'Order #4411', purchase_date: '2025-02-10' })]
    await mount()
    await waitFor(() => expect(lineOf('a')).toBe('3 packets · Fedco · bought 2025'))
    expect(lineOf('a')).not.toContain('Order')
  })

  it('saved lots: seed count, origin, harvest year; uncounted says no amount at all', async () => {
    rows = [
      pkt({ id: 's1', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', source_plant_id: 'pl', seed_stage: 'stored', seed_count: 175, seed_count_estimated: true, year_harvested: 2026 }),
      pkt({ id: 's2', name: 'Cayenne — saved 2026', variety_name: 'Cayenne', crop_slug: 'pepper', source_kind: 'farm_stand', seed_stage: 'stored' }),
    ]
    await mount()
    await waitFor(() => expect(lineOf('s1')).toBe('approx. 175 seeds · Saved from my plant · harvested 2026'))
    expect(lineOf('s2')).toBe('Saved · farm stand')
  })

  it('chips come from the engine: a fermenting jar at 0 stays in the list, a used-up packet goes under Sowed previously', async () => {
    rows = [
      pkt({ id: 'jar', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', seed_stage: 'fermenting', source_plant_id: 'pl', quantity_on_hand: 0, stage_entered_at: new Date().toISOString() }),
      pkt({ id: 'unstarted', name: 'Lemon Drop — saved 2026', variety_name: 'Lemon Drop', source_plant_id: 'pl', quantity_on_hand: 0 }),
      pkt({ id: 'empty', name: 'Old Packet', variety_name: 'Old Packet', quantity_on_hand: 0 }),
    ]
    await mount()
    await waitFor(() => expect(rowFor('jar')).toBeTruthy())
    expect(lineOf('jar')).toContain('Fermenting · today')
    expect(lineOf('unstarted')).toContain('Not started')
    // Used up: collapsed by default, counted, and one tap open.
    expect(rowFor('empty')).toBeNull()
    const sowed = screen.getByTestId('my-seeds-sowed')
    expect(sowed.textContent).toContain('Sowed previously')
    const toggle = within(sowed).getByRole('button', { expanded: false })
    await act(async () => { fireEvent.click(toggle) })
    expect(rowFor('empty')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('an archived packet carries its chip', async () => {
    rows = [pkt({ id: 'arch', sow_archived_season: new Date().getFullYear() })]
    await mount()
    await waitFor(() => expect(lineOf('arch')).toContain('Archived for this season'))
  })

  it('two rows that would read alike are told apart on screen', async () => {
    rows = [pkt({ id: 'd1' }), pkt({ id: 'd2' })]
    await mount()
    await waitFor(() => expect(rowFor('d2')).toBeTruthy())
    const lines = ['d1', 'd2'].map(lineOf)
    expect(lines[0]).not.toBe(lines[1])
    expect(lines.some((l) => l.includes('1 of 2 with identical details'))).toBe(true)
    expect(lines.some((l) => l.includes('2 of 2 with identical details'))).toBe(true)
  })
})

describe('My seeds — grouping, filtering, sorting', () => {
  const CROPPED = [
    pkt({ id: 't1', variety_name: 'Sungold', crop_slug: 'tomato' }),
    pkt({ id: 't2', name: 'Brandywine', variety_name: 'Brandywine', crop_slug: 'tomato', purchase_date: '2021-03-01', created_at: '2026-09-01T00:00:00Z' }),
    pkt({ id: 'p1', name: 'Gong Bao', variety_name: 'Gong Bao', crop_slug: 'pepper', year_harvested: 2019 }),
  ]

  it('groups by crop with visible-row counts, and shows crop chips only when there are two crops', async () => {
    rows = CROPPED
    await mount()
    await waitFor(() => expect(screen.getAllByTestId('my-seeds-group').length).toBe(2))
    const headers = screen.getAllByTestId('facet-group-header').map((h) => h.textContent)
    expect(headers).toEqual(['Pepper1', 'Tomato2'])
    expect(screen.getByTestId('my-seeds-crop-filter')).toBeTruthy()
    cleanup()
    rows = [CROPPED[0]]
    await mount()
    await waitFor(() => expect(rowFor('t1')).toBeTruthy())
    expect(screen.queryByTestId('my-seeds-crop-filter')).toBeNull()
  })

  it('search narrows by variety or vendor; a search that matches nothing offers to clear', async () => {
    rows = [...CROPPED, pkt({ id: 'v1', name: 'Mystery', variety_name: 'Mystery', source_id: 'src-baker' })]
    await mount()
    const box = screen.getByTestId('my-seeds-search')
    await act(async () => { fireEvent.change(box, { target: { value: 'baker creek' } }) })
    await waitFor(() => expect(screen.getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id'))).toEqual(['v1']))
    await act(async () => { fireEvent.change(box, { target: { value: 'zzzz' } }) })
    expect(screen.getByTestId('my-seeds-no-match')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear search' })) })
    expect(screen.getAllByTestId('my-seed-row').length).toBe(4)
  })

  it('Oldest puts unknown years under a labelled divider; Newest follows created_at', async () => {
    rows = CROPPED
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Oldest' })) })
    const order = () => screen.getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id'))
    expect(order()).toEqual(['p1', 't2', 't1'])
    expect(screen.getByTestId('my-seeds-date-unknown').textContent).toBe('Date unknown (1)')
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Newest' })) })
    expect(order()[0]).toBe('t2')
  })

  it('remembers search, chips and sort for the visit (sessionStorage), not in the URL', async () => {
    rows = CROPPED
    await mount()
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'gong' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Oldest' })) })
    cleanup()
    await mount()
    expect(screen.getByTestId('my-seeds-search').value).toBe('gong')
    expect(screen.getByRole('radio', { name: 'Oldest' }).getAttribute('aria-checked')).toBe('true')
  })

  it('has three different empty states', async () => {
    rows = []
    await mount()
    expect(screen.getByTestId('my-seeds-empty').textContent).toContain('No seed yet')
    cleanup()
    rows = [pkt({ id: 'e', quantity_on_hand: 0 })]
    await mount()
    await waitFor(() => expect(screen.getByTestId('my-seeds-all-sowed')).toBeTruthy())
  })
})

describe('My seeds — the stepper (moved from the Inventory row)', () => {
  it('− writes the wide PUT WITHOUT the presence-guarded seed columns, and the row updates', async () => {
    rows = [pkt({ id: 'q', quantity_on_hand: 3, seed_stage: 'stored', source_plant_id: 'pl', source_id: 'src-fedco', year_harvested: 2025, seed_count: 40 })]
    await mount()
    await act(async () => { fireEvent.click(within(rowFor('q')).getByRole('button', { expanded: false })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /One fewer packet/ })) })
    await waitFor(() => expect(putBodies.length).toBe(1))
    const body = putBodies[0]
    expect(body.quantity_on_hand).toBe(2)
    expect(body.type).toBe('consumable')          // load-bearing: the handler nulls qty for any other type
    for (const k of ['seed_stage', 'source_plant_id', 'source_id', 'year_harvested', 'seed_count', 'variety_id', 'crop_slug', 'variety_name']) {
      expect(k in body, k).toBe(false)
    }
    await waitFor(() => expect(within(rowFor('q')).getByTestId('my-seed-qty').textContent).toContain('2'))
    // The list-only projections survive the write (the PUT answers bare columns).
    expect(rowFor('q').closest('section')?.textContent).toContain('Tomato')
  })

  it('offers Undo, and Undo sends the reversing write', async () => {
    rows = [pkt({ id: 'u', quantity_on_hand: 2 })]
    await mount()
    await act(async () => { fireEvent.click(within(rowFor('u')).getByRole('button', { expanded: false })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /One more packet/ })) })
    await waitFor(() => expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Undo/ })) })
    await waitFor(() => expect(putBodies.map((b) => b.quantity_on_hand)).toEqual([3, 2]))
  })

  it('offers "Change stage in Saved seeds →" only for a lot in process, and hands the lot to the shell', async () => {
    const onGoToLot = vi.fn()
    rows = [
      pkt({ id: 'dry', name: 'Gong Bao — saved 2026', variety_name: 'Gong Bao', seed_stage: 'drying', source_plant_id: 'pl' }),
      pkt({ id: 'plain' }),
    ]
    await mount({ onGoToLot })
    await act(async () => { fireEvent.click(within(rowFor('plain')).getByRole('button', { expanded: false })) })
    expect(screen.queryByTestId('my-seed-change-stage')).toBeNull()
    expect(within(rowFor('plain')).getByTestId('my-seed-details').getAttribute('href')).toBe('/inventory/plain')
    await act(async () => { fireEvent.click(within(rowFor('dry')).getByRole('button', { expanded: false })) })
    await act(async () => { fireEvent.click(screen.getByTestId('my-seed-change-stage')) })
    expect(onGoToLot).toHaveBeenCalledWith('dry')
  })
})

describe('My seeds — a write never lands out of sight (§4.3)', () => {
  it('a filter that would hide the outlined row is cleared, and the page says so', async () => {
    rows = [pkt({ id: 'keep' }), pkt({ id: 'new', name: 'Cherokee Purple', variety_name: 'Cherokee Purple' })]
    function Driver() {
      const [h, setH] = useState(null)
      return (
        <>
          <button type="button" onClick={() => setH({ id: 'new', seq: 1 })}>outline-new</button>
          <Host highlight={h} />
        </>
      )
    }
    await act(async () => { render(<MemoryRouter><ToastProvider><Driver /></ToastProvider></MemoryRouter>) })
    await waitFor(() => expect(rowFor('new')).toBeTruthy())
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'sungold' } }) })
    expect(rowFor('new')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText('outline-new')) })
    await waitFor(() => expect(rowFor('new')?.getAttribute('data-outlined')).toBe('true'))
    expect(screen.getByTestId('my-seeds-notice').textContent).toBe('Showing all · Cherokee Purple')
    expect(screen.getByTestId('my-seeds-search').value).toBe('')
  })
})
