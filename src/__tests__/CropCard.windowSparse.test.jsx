// V4-RIPENESSCUES-001 — the async card-earning model: a window-ONLY sparse card (every sync
// signal empty) DOES render once the window resolves, and a sparse record whose window resolves
// EMPTY stays null permanently. NOTE: no real-data window-only fixture exists — all 19 window
// crop types also carry a ripenessCues crop mechanic (verified against both datasets 2026-08-12),
// so hasCue is true for every real cultivar — therefore the resolver is MOCKED here with a
// synthetic window on a crop slug outside the cue dataset, exactly as the design doc §3
// prescribes ("mock the resolver in that one dedicated case — say so in the test").
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/harvestWindows.js', () => ({
  resolveHarvestWindow: (v) => v?.name === 'Windowed Wonder'
    ? {
        cultivar: {
          window_label: 'test green → test red',
          window: [
            { at: 'test green', look: 'synthetic look 1', gives: 'synthetic gives 1' },
            { at: 'test red', look: 'synthetic look 2', gives: 'synthetic gives 2' },
          ],
          ripe_vs_unripe: null,
          source: 'Synthetic Test Source', source_url: null,
          confidence: 'high', asserted_on: '2026-08-12', caveat: null,
        },
        crop: null,
      }
    : { cultivar: null, crop: null },
}))

import CropCard from '../components/planting/CropCard.jsx'

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue(null) })

describe('CropCard — window-only sparse card (V4-RIPENESSCUES-001)', () => {
  it('renders NOTHING while pending, then the card once the window resolves', async () => {
    // zz_no_such_crop: outside the cue dataset → hasCue false; no dates/DTM/attrs → all sync
    // signals empty. The ONLY thing this record will ever earn its card with is the window.
    const { container } = render(
      <CropCard planting={{ id: 'p', variety_ref: { name: 'Windowed Wonder', crop_type_slug: 'zz_no_such_crop' } }} />,
    )
    expect(container.firstChild).toBeNull() // pending+sparse: indistinguishable from today
    // Mutation target: drop the async-sparse term from the early return and this findBy fails.
    expect(await screen.findByText('test green → test red')).toBeTruthy()
    expect(screen.getByText('When you can pick')).toBeTruthy()
  })

  it('a sparse record whose window resolves EMPTY returns null permanently', async () => {
    const { container } = render(
      <CropCard planting={{ id: 'p', variety_ref: { name: 'Windowless', crop_type_slug: 'zz_no_such_crop' } }} />,
    )
    expect(container.firstChild).toBeNull()
    await act(async () => {}) // resolved-empty: no re-render, no window, no card
    expect(container.firstChild).toBeNull()
  })
})
