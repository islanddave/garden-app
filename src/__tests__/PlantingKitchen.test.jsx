// Put-Up B′ release 3 (V4 §2.5 "Planting page") — the planting's kitchen lists: what was put up from it (the
// shipped list, now with "from <batch> →" and each jar's Next time lines), what is kept fresh from it, and
// every batch that used it. A LIST — never a sum or a percentage.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PlantingKitchen from '../components/planting/PlantingKitchen.jsx'
import { batchByJar, listedBatches, usedWords, plantingBatchesPath } from '../components/planting/plantingKitchen.js'

const PLANTING = { id: 'pl-1', variety_ref: { crop_type_slug: 'pepper' } }
const JAR = { id: 'j-1', label: 'Megatron plain', method: 'hot_sauce', package_count: 2, remaining_count: 2, preserved_at: '2026-09-08', notes: 'Oct 8 · Next time: more garlic' }
const LONE = { id: 'j-2', label: 'Frozen Megatron', method: 'whole_freeze', package_count: 1, remaining_count: 1, preserved_at: '2026-08-01', notes: null }
const SINGLE = { id: 'kb-1', label: 'Megatron mash', single_planting: true, output_ids: ['j-1'], used_via: 'garden', next_time: [{ id: 'n1', note: 'more carrot' }] }
const MIXED = { id: 'kb-2', label: 'Party salsa', single_planting: false, output_ids: [], used_via: 'jar', next_time: [] }
const FRESH = { id: 'it-1', name: 'Jalapeños', place_label: 'Fridge', used_up_at: null, next_time: ['Next time: pick earlier'] }

function mount(read) {
  const fetch = vi.fn((path) => {
    if (String(path).startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [{ label: 'Fridge', records: [JAR, LONE] }] })
    if (path === plantingBatchesPath('pl-1')) return read()
    return Promise.resolve(null)
  })
  render(<MemoryRouter><PlantingKitchen planting={PLANTING} fetch={fetch} /></MemoryRouter>)
  return fetch
}

afterEach(cleanup)

describe('plantingKitchen.js', () => {
  it('a single-planting batch reads on its jar rows; every other batch is listed once', () => {
    expect(batchByJar([SINGLE, MIXED]).get('j-1')).toBe(SINGLE)
    expect(batchByJar([MIXED]).size).toBe(0)
    expect(listedBatches([SINGLE, MIXED], ['j-1']).map(b => b.id)).toEqual(['kb-2'])
    // A single-planting batch whose jars are NOT shown here (e.g. used up and gone) is still listed.
    expect(listedBatches([SINGLE], []).map(b => b.id)).toEqual(['kb-1'])
    expect(usedWords({ used_via: 'jar' })).toMatch(/put up/)
  })
})

describe('PlantingKitchen', () => {
  it('shows "from <batch> →" and Next time on the jar, kept fresh, and the other batches — no totals', async () => {
    mount(() => Promise.resolve({ plant_id: 'pl-1', batches: [SINGLE, MIXED], kept_fresh: [FRESH] }))
    const from = await screen.findByTestId('planting-jar-batch-j-1')
    expect(from.textContent).toBe('from Megatron mash →')
    expect(from.getAttribute('href')).toBe('/put-up?batch=kb-1')
    expect(screen.getByTestId('planting-jar-next-j-1').textContent).toMatch(/more carrot.*more garlic/)
    expect(screen.queryByTestId('planting-jar-batch-j-2')).toBeNull()
    expect(screen.getByTestId('planting-fresh-it-1').textContent).toMatch(/Jalapeños.*Fridge.*pick earlier/)
    await waitFor(() => expect(screen.getByTestId('planting-batches')).toBeTruthy())
    expect(screen.queryByTestId('planting-batch-kb-1')).toBeNull()
    expect(screen.getByTestId('planting-batch-kb-2').textContent).toMatch(/Party salsa/)
    const text = screen.getByTestId('planting-kept-fresh').textContent + screen.getByTestId('planting-batches').textContent
    expect(text).not.toMatch(/%|\btotal\b|\d+ batches/i)
  })

  it('when the read fails the shipped put-up list still renders, and nothing else does', async () => {
    mount(() => Promise.reject(new Error('down')))
    expect(await screen.findByText(/Megatron plain/)).toBeTruthy()
    expect(screen.queryByTestId('planting-kept-fresh')).toBeNull()
    expect(screen.queryByTestId('planting-batches')).toBeNull()
  })
})
