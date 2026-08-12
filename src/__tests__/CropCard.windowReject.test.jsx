// V4-RIPENESSCUES-001 — the failure branch of the app's FIRST code-split point. The colour-window
// chunk is lazy-loaded from CropCard in an offline-normal app whose SW purges versioned caches on
// deploy, so import rejection is an EXPECTED runtime condition, not an edge case. Contract: a
// chunk-miss renders the card WITHOUT the window — page intact, no error surface, no route
// fallback (React.lazy is forbidden at/above CropCard for exactly this reason). The vi.mock
// factory below THROWS, which makes the component's dynamic import reject; it also counts
// evaluation attempts, which is the loader spy pinning "a null variety_ref fires NO import".
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { apiFetchSpy, loader } = vi.hoisted(() => ({ apiFetchSpy: vi.fn(), loader: { attempts: 0 } }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/harvestWindows.js', () => {
  loader.attempts += 1
  throw new Error('simulated chunk load failure (offline / purged old-hash chunk)')
})

import CropCard from '../components/planting/CropCard.jsx'
import ErrorBoundary from '../components/ErrorBoundary.jsx'

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue(null) })

const flush = () => act(async () => {})

describe('CropCard — window chunk-load failure (V4-RIPENESSCUES-001)', () => {
  // ORDER MATTERS: this test must run before any variety_ref-bearing mount in this file, so a
  // zero attempt count proves the bare record never even requested the module.
  it('a null variety_ref fires NO import at all — bare records stay synchronous', async () => {
    render(<CropCard planting={{ id: 'p', variety_ref: null, sown_at: '2026-03-01' }} />)
    expect(screen.getByText(/^Day \d+/)).toBeTruthy() // the card itself renders (maturity band)
    await flush()                                     // give a wrongly-fired import every chance
    expect(loader.attempts).toBe(0)
  })

  it('import rejection → card renders windowless, content intact, no route fallback, no crash', async () => {
    render(
      <ErrorBoundary fallback={<div data-testid="route-fallback" />}>
        <CropCard planting={{ id: 'p', variety_ref: {
          name: 'Cherokee Green', crop_type_slug: 'tomato', sun_requirements: 'Full sun',
        } }} />
      </ErrorBoundary>,
    )
    await flush() // let the import reject and the .catch branch run
    expect(loader.attempts).toBeGreaterThan(0)                      // the import WAS attempted
    expect(screen.getByText('Full sun')).toBeTruthy()               // sync content intact
    expect(screen.getByText(/When it.s ripe/i)).toBeTruthy()        // cue still renders
    expect(screen.queryByText('When you can pick')).toBeNull()      // window absent, silently
    expect(screen.queryByTestId('route-fallback')).toBeNull()       // no boundary trip
  })

  it('rejection on a SPARSE record keeps rendering nothing — failed+sparse is null, page intact', async () => {
    const { container } = render(
      <CropCard planting={{ id: 'p', variety_ref: { name: 'No Such Plant', crop_type_slug: 'zz_no_such_crop' } }} />,
    )
    expect(container.firstChild).toBeNull() // pending+sparse renders null (identical to today)
    await flush()
    expect(container.firstChild).toBeNull() // failed+sparse stays null permanently
  })
})
