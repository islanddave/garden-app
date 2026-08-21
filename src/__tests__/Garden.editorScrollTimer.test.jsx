// Garden ?edit=<id> scroll timer — unmount teardown race.
//
// Observed live in a full-suite run (2026-08-19), originating in Garden.gridProjection.test.jsx:
//   ReferenceError: document is not defined
//    ❯ Timeout._onTimeout src/pages/Garden.jsx:398:11
// The ~60ms scroll-into-view timer is scheduled from inside the ?edit fetch continuation, so its
// id was never captured and the effect cleanup could not clear it. Under load the timer outlived
// the component and fired after the environment was torn down, reaching for a `document` that no
// longer existed. It surfaced as a NON-failing unhandled error (run still exited 0) and did not
// reproduce in isolation, which is exactly why it needs a deterministic fake-timer guard.
//
// Fake timers, no waitFor/findBy anywhere: those poll on real timers and would hang here.
//
// OPS-GARDENROUTERMOCK-001 — real router, no `react-router-dom` mock. This file's positive control
// asserts the ?edit= editor OPENED, and under the old frozen-ref mock that was unfalsifiable: the
// param strip re-rendered nothing, so the effect cleanup that used to cancel the by-id fetch never
// ran and the editor opened no matter what (BUG-EDITDEEPLINKRACE-001). A positive control that
// cannot fail cannot license the unmount assertion beside it.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderWithRouter, resetRouterHarness } from './helpers/routerHarness.jsx'

const { fetchSpy, getTokenSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => <div data-testid="variety-picker" /> }))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null, is_public: true }]
const PLANT = {
  id: 'plant-2', name: 'Krim Plant', project_id: 'proj-1', project_name: 'Spring 2026',
  quantity: 3, status: 'seedling', notes: null,
  variety: 'Black Krim', variety_id: 'var-1',
  variety_ref: { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum' },
}

function primeFetch() {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants?view=grid' && !opts.method) return Promise.resolve([PLANT])
    if (url === '/api/plants/plant-2' && !opts.method) return Promise.resolve(PLANT)
    return Promise.resolve([])
  })
}

let getByIdSpy

// The observable is the handler's ONLY side effect: document.getElementById('planting-editor').
// Counting calls with that exact id ignores any unrelated lookup elsewhere in the tree.
const scrollLookups = () =>
  getByIdSpy.mock.calls.filter(([id]) => id === 'planting-editor').length

// Flushes the fetch continuations (microtasks) without letting the 60ms timer run.
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}

const renderGarden = () => renderWithRouter(<Garden />, { route: '/garden?edit=plant-2' })

beforeEach(() => {
  localStorage.clear()
  fetchSpy.mockReset()
  resetRouterHarness()
  getByIdSpy = vi.spyOn(document, 'getElementById')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  getByIdSpy.mockRestore()
})

describe('Garden — ?edit scroll timer is owned for the component lifetime', () => {
  // Positive control. Without it the unmount test is vacuous — it would pass just as happily
  // against a build where the timer is never scheduled, or is cancelled on every effect re-run.
  it('still scrolls to the editor when the timer fires while mounted', async () => {
    primeFetch()
    await renderGarden()
    await settle()

    expect(document.querySelector('#planting-editor')).not.toBeNull() // editor really opened
    expect(scrollLookups()).toBe(0)                                   // timer has NOT fired yet

    act(() => { vi.advanceTimersByTime(100) })
    expect(scrollLookups()).toBe(1)
  })

  it('does NOT fire after unmount (teardown race regression guard)', async () => {
    primeFetch()
    const { unmount } = await renderGarden()
    await settle()

    expect(document.querySelector('#planting-editor')).not.toBeNull()
    expect(scrollLookups()).toBe(0)

    unmount()
    act(() => { vi.advanceTimersByTime(1000) })

    expect(scrollLookups()).toBe(0)
  })
})
