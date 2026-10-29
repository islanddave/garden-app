// new-file: no per-event-type snapshot of EventNew existed (a different module-level mock set from every sibling)
// Pins today's rendered EventNew form for every EVENT_TYPES value (OPS-CODEREVIEW-001 C6) so E4's pure-move split
// is checked against the DOM it must not change. Real router, real flags. Trap: the clock and TZ are frozen
// because the form renders today's date; a snapshot diff after a pure move is a regression, not a re-record.
import React from 'react'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { settle } from './helpers/settle.js'
import { renderWithRouter, resetRouterHarness } from './helpers/routerHarness.jsx'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null,
    reset: vi.fn(),
  }),
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { EVENT_TYPES } from '../lib/eventTypes.js'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold #1', project_id: 'proj-1', quantity: 4, status: 'vegetative' }
const LOCATION = { id: 'loc-1', name: 'Bed A', path: 'Garden / Bed A' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations/with-path') return Promise.resolve([LOCATION])
    if (path.startsWith('/api/plants')) return Promise.resolve([PLANT])
    return Promise.resolve(null)
  })
}

const savedTZ = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'UTC'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-15T14:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
  process.env.TZ = savedTZ
})
beforeEach(() => {
  resetRouterHarness()
  apiFetchSpy.mockReset()
  wireApiFetch()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

async function renderType(type) {
  const view = await renderWithRouter(
    <DismissRegistryProvider><ToastProvider><EventNew /></ToastProvider></DismissRegistryProvider>,
    { route: `/log?event_type=${type}&project=proj-1&plant=plant-1` },
  )
  await settle()
  await settle()
  return view
}

describe('EventNew — rendered form per event type', () => {
  it('covers every EVENT_TYPES value (anti-vacuity)', () => {
    expect(EVENT_TYPES.length).toBeGreaterThan(40)
  })

  it.each(EVENT_TYPES)('%s', async (type) => {
    const { container } = await renderType(type)
    expect(container.innerHTML.length).toBeGreaterThan(0)
    expect(container).toMatchSnapshot()
    cleanup()
  })
})
