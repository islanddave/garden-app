// Saved seeds' count field gives an example in SEEDS, never "e.g. 2 packet".
//
// The advance sheet's count writes seed_count (V5-SEEDQTY-001), but its placeholder still appended the
// lot's unit — and every saved lot's unit is 'packet' — so the one field that asks how many seeds read
// "e.g. 2 packet": the same "1 packet" confusion Dave reported on the lot page (2026-09-25). It now
// carries the Save-seed sheet's example, "e.g. 20". Setup mirrors SavedSeeds.countBasis.test.jsx.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../lib/pendingCapture.js', () => ({ setPendingCapture: vi.fn(), takePendingCapture: vi.fn() }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => <span /> }))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// A drying lot saved off a plant, as the list returns it: one jar, unit 'packet'.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: '1.000', unit: 'packet', tags: [], metadata: null,
  seed_count: null, seed_weight_g: null, seed_count_estimated: null,
  variety_id: 'v-melon', source_plant_id: 'pl-melon', seed_stage: 'drying', seed_process: 'wet',
  variety_name: 'Green Flesh', stage_entered_at: '2026-08-25T12:00:00Z', crop_slug: 'melon',
  year_harvested: 2026, updated_at: '2026-08-30T12:00:00Z',
}

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/inventory-items')) return Promise.resolve([LOT])
    return Promise.resolve([])
  })
})

describe('the advance sheet\'s count field', () => {
  it('offers an example number of SEEDS, with no container unit beside it', async () => {
    await act(async () => { render(<MemoryRouter><ToastProvider><SavedSeeds /></ToastProvider></MemoryRouter>) })
    await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    const input = screen.getByTestId('seed-count-input')
    expect(input.getAttribute('placeholder')).toBe('e.g. 20')
    expect(input.getAttribute('placeholder')).not.toMatch(/packet/)
  })
})
