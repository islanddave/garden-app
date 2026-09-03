/**
 * V4-SEEDINTAKEAGNOSTIC-001 — the sheet opened with NO planting.
 *
 * Dave, 2026-09-03: "I still cannot find an easy way to start a saved seed path anywhere - i know i
 * can go to a planting page but I need an agnostic intake form which can either select from a
 * planting or create a no-planting parent."
 *
 * He was the THIRD person into this wall, and the two previous fixes both stopped at the same place:
 * the sheet REQUIRED a planting, so every other surface could only point at the plant list. The
 * empty-state copy said so out loud — "open that planting and tap Save seed" — and the code comment
 * beside it conceded the reason. The parameter WAS the defect.
 *
 * The sibling SaveSeedSheet.test.jsx covers the planting-page path and must stay untouched by this:
 * where the caller knows the parent, nothing changed.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { apiFetchSpy, navigateSpy } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
  apiFetch: (...a) => apiFetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
// VarietyPicker drags useCachedFetch + dataCache + Clerk behind it and hangs a bare render; it is not
// the unit under test. Stubbed to a button that selects a fixed variety, so the DB CHECK
// chk_inventory_seed_requires_variety can still be satisfied through the UI.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ onChange }) => (
    <button type="button" data-testid="stub-pick-variety" onClick={() => onChange({ id: 'var-7', name: 'Carolina Reaper' })}>
      pick variety
    </button>
  ),
}))
// Same reasoning for PlantingSelect: it self-fetches. The stub proves the sheet passes the ROW
// through, which is the contract this file cares about.
vi.mock('../components/forms', async (importActual) => ({
  ...(await importActual()),
  PlantingSelect: ({ onChange }) => (
    <button type="button" data-testid="stub-pick-planting" onClick={() => onChange('pl-3', { id: 'pl-3', name: 'Brandywine' })}>
      pick planting
    </button>
  ),
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const bodyOf = (url) => {
  const call = apiFetchSpy.mock.calls.find(([u]) => u === url)
  return call ? JSON.parse(call[1].body) : null
}
const createBody = () => bodyOf('/api/inventory-items')
const eventCalls = () => apiFetchSpy.mock.calls.filter(([u]) => u === '/api/events')

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  apiFetchSpy.mockResolvedValue({ id: 'inv-42' })
})

const open = async () => {
  await act(async () => { render(<ToastProvider><SaveSeedSheet onClose={() => {}} /></ToastProvider>) })
}

describe('V4-SEEDINTAKEAGNOSTIC-001 — no planting given', () => {
  it('asks where the seed came from instead of assuming a planting', async () => {
    await open()
    expect(screen.getByText('Where did this seed come from?')).toBeTruthy()
    expect(screen.getByTestId('seed-origin-plant')).toBeTruthy()
    expect(screen.getByTestId('seed-origin-other')).toBeTruthy()
  })

  it('the no-planting arm writes source_kind and NO parent — the Carolina Reaper case', async () => {
    await open()
    fireEvent.click(screen.getByTestId('seed-origin-other'))
    fireEvent.change(screen.getByTestId('seed-source-kind'), { target: { value: 'store' } })
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Carolina Reaper — saved 2026' } })
    fireEvent.click(screen.getByTestId('save-seed-submit'))

    await waitFor(() => expect(createBody()).toBeTruthy())
    const body = createBody()
    // chk_inventory_source_provenance is `source_kind IS NULL OR source_kind = 'own_garden' OR
    // source_plant_id IS NULL` — sending BOTH a parent and a non-garden kind is a 400, so these two
    // assertions are one invariant, not two independent facts.
    expect(body.source_plant_id).toBe(null)
    expect(body.source_kind).toBe('store')
    expect(body.variety_id).toBe('var-7')
    expect(body.category).toBe('seeds')
  })

  it('writes NO timeline event when there is no plant to put it on', async () => {
    // seed_saved is in PLANTING_REQUIRED_TYPES and validatePostBody wants project_id OR plant_id, so
    // there is nowhere for this row to go. Skipping is the honest outcome; inventing a placeholder
    // planting to carry it would put plants in the garden that were never planted.
    // MUTATION: drop the `if (parent)` guard on the event POST and this goes red.
    await open()
    fireEvent.click(screen.getByTestId('seed-origin-other'))
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Shop pepper' } })
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(createBody()).toBeTruthy())
    expect(eventCalls()).toHaveLength(0)
  })

  it('the picked-planting arm behaves exactly like the planting-page path', async () => {
    // The other half, and the one that makes this a widening rather than a fork: choosing a planting
    // here must produce the SAME write the planting page produces — parent set, no source_kind, and
    // the timeline event present.
    await open()
    fireEvent.click(screen.getByTestId('seed-origin-plant'))
    fireEvent.click(screen.getByTestId('stub-pick-planting'))
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Brandywine — saved 2026' } })
    fireEvent.click(screen.getByTestId('save-seed-submit'))

    await waitFor(() => expect(createBody()).toBeTruthy())
    expect(createBody().source_plant_id).toBe('pl-3')
    expect(Object.prototype.hasOwnProperty.call(createBody(), 'source_kind')).toBe(false)
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    expect(JSON.parse(eventCalls()[0][1].body).plant_id).toBe('pl-3')
  })

  it('still refuses to invent a variety', async () => {
    // The DB CHECK this sheet has always answered client-side rather than after a round trip. The
    // agnostic path must not have opened a hole in it.
    await open()
    fireEvent.click(screen.getByTestId('seed-origin-other'))
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Mystery seed' } })
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(screen.getAllByText(/has to name one/i).length).toBeGreaterThan(0))
    expect(createBody()).toBe(null)
  })
})
