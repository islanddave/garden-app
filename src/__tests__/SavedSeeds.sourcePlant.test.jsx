// V4-SEEDLINK-001 — seed-lot provenance on /seeds/saved.
//
// Three things are pinned here, and the first is a COPY assertion, which is unusual and deliberate:
// this page's empty state used to instruct the user to record provenance as a `seed_saved` EVENT on
// the planting. That is a dead end — the event type has never been logged once in the app's history,
// has no side effect of any kind, and event_log's only FK to inventory_items means "the product I
// sprayed". The app was telling Dave to do something that does nothing. Now that provenance has a
// real column and a real control, the sentence has to point at it; a test is what keeps the old one
// from drifting back in with a refactor.
//
// The other two are the §4B placements this page owns: the parent captured in the advance sheet at
// the moment the seed is in hand, and the parent shown (or offered) on the lot card afterwards.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PARENT = {
  id: 'pl-melon', name: 'Green Flesh', quantity: 1, variety_id: 'v-melon', project_name: null,
  variety_ref: { id: 'v-melon', name: 'Green Flesh', crop_type_slug: 'melon' },
  sown_at: null, succession_order: null,
}
const lot = (over = {}) => ({
  id: 'inv-1', name: 'Green Flesh Honeydew', variety_name: 'Green Flesh Honeydew',
  category: 'seeds', variety_id: 'v-melon', seed_stage: 'drying', seed_process: null,
  source_plant_id: null, updated_at: '2026-08-30T12:00:00Z', ...over,
})

const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([PARENT])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}

beforeEach(() => { fetchSpy.mockReset() })

describe('SavedSeeds — provenance (V4-SEEDLINK-001)', () => {
  it('stops sending the user to the dead-end "Seed saved" event', async () => {
    await mount([])
    const empty = screen.getByTestId('saved-seeds-empty').textContent
    expect(empty).not.toContain('Seed saved')
    expect(empty).toContain('Saved from')
  })

  it('names the parent on a linked lot’s card', async () => {
    await mount([lot({ source_plant_id: 'pl-melon' })])
    await waitFor(() =>
      expect(screen.getByTestId('lot-source-plant').textContent).toContain('Green Flesh'))
  })

  it('offers a way in on an UNlinked lot instead of naming nothing', async () => {
    await mount([lot()])
    expect(screen.queryByTestId('lot-source-plant')).toBeNull()
    expect(screen.getByTestId('set-source-plant').getAttribute('href')).toBe('/inventory/inv-1')
  })

  it('does NOT fetch plantings when no lot carries a link', async () => {
    // The name lookup is gated on need. With no linked lot — which is every lot today — the hook
    // stays idle, so the page costs exactly what it cost before this feature.
    await mount([lot()])
    expect(fetchSpy.mock.calls.some(([p]) => String(p).startsWith('/api/plants'))).toBe(false)
  })

  it('captures the parent in the advance sheet, as a SEPARATE write from the stage move', async () => {
    // Separate on purpose: a lot that moved to stored moved whether or not we also learned which
    // plant it came from, so a failed link must not report the stage move as failed.
    await mount([lot()])
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    fireEvent.focus(screen.getByTestId('stage-source-plant-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${PARENT.id}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`ps-opt-${PARENT.id}`)) })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })

    const writes = fetchSpy.mock.calls.filter(([, o]) => o?.method)
    expect(writes.map(([p, o]) => `${o.method} ${p}`)).toEqual([
      'POST /api/inventory-items/inv-1/seed-stage',
      'PATCH /api/inventory-items/inv-1/source-plant',
    ])
    expect(JSON.parse(writes[1][1].body)).toEqual({ source_plant_id: 'pl-melon' })
  })

  it('does not re-ask for a parent the lot already has', async () => {
    // /inventory/:id is the editor for this column; the advance sheet only CAPTURES a missing one.
    await mount([lot({ source_plant_id: 'pl-melon' })])
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    expect(screen.queryByTestId('stage-source-plant')).toBeNull()
  })
})
