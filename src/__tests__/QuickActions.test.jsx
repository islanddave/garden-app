// V4-PLANTINGUI-001 — QuickActions: water (POST watering) + photo (deep-link).
// V4-STATUSTAP-001: status moved to the hero StatusPicker (see StatusPicker.test.jsx); the
// former inline status <select> and its tests were removed from here.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { navigateSpy, setPendingSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn(), setPendingSpy: vi.fn() }))
vi.mock('react-router-dom', async (orig) => { const actual = await orig(); return { ...actual, useNavigate: () => navigateSpy } })
vi.mock('../lib/pendingCapture.js', () => ({ setPendingCapture: setPendingSpy, takePendingCapture: vi.fn() }))

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import QuickActions, { canMarkSprouted } from '../components/planting/QuickActions.jsx'

const PL = { id: 'pl1', project_id: 'proj1', status: 'seedling' }

function renderQA(props = {}) {
  return render(
    <MemoryRouter>
      <QuickActions planting={PL} {...props} />
    </MemoryRouter>,
  )
}

beforeEach(() => { apiFetchSpy.mockReset() })

describe('QuickActions', () => {
  it('Water POSTs a watering event and calls onLogged (no provider = no throw)', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'ev1', event_type: 'watering' })
    const onLogged = vi.fn()
    renderQA({ onLogged })
    fireEvent.click(screen.getByRole('button', { name: /Log watering/i }))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ project_id: 'proj1', plant_id: 'pl1', event_type: 'watering' })
    await waitFor(() => expect(onLogged).toHaveBeenCalled())
  })

  it('no longer renders a status control (moved to the hero StatusPicker)', () => {
    renderQA()
    expect(screen.queryByRole('combobox', { name: /status/i })).toBeNull()
  })

  it('Photo opens a picker; on pick it parks the file and jumps into the photo log flow (V4-PHOTOQUICK-001)', () => {
    navigateSpy.mockReset(); setPendingSpy.mockReset()
    const { container } = renderQA()
    fireEvent.click(screen.getByRole('button', { name: /Add a photo/i }))
    const input = container.querySelector('input[type="file"]')
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(setPendingSpy).toHaveBeenCalledWith(file)
    // V4-OVERLAY-001 Slice 2: the photo deep-link now opens /log as an overlay, so the nav carries a
    // `background` in options state (flag on). Assert the target + that a background is carried.
    const [toArg, optsArg] = navigateSpy.mock.calls[0]
    expect(toArg).toBe('/log?project=proj1&plant=pl1&event_type=photo&fromquick=1')
    expect(optsArg?.state?.background).toBeTruthy()
  })

  it('It sprouted! POSTs a germination event and calls onLogged (CAL-2)', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'ev2', event_type: 'germination', event_date: '2026-07-30' })
    const onLogged = vi.fn()
    renderQA({ onLogged })
    fireEvent.click(screen.getByRole('button', { name: /sprouted/i }))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ project_id: 'proj1', plant_id: 'pl1', event_type: 'germination' })
    await waitFor(() => expect(onLogged).toHaveBeenCalled())
  })

  it('hides the "It sprouted!" action once the planting has germinated_at (CAL-2)', () => {
    renderQA({ planting: { ...PL, germinated_at: '2026-07-01' } })
    expect(screen.queryByRole('button', { name: /sprouted/i })).toBeNull()
  })
})

// BUG-SPROUTGATE-001 — the stamp alone is not a gate. Measured against live prod on 2026-08-04:
// 264 of 269 plantings rendered the button before this change, 21 after.
describe('BUG-SPROUTGATE-001 — sprout gate (stage + sown origin, not the stamp alone)', () => {
  it('shows for a sown, pre-emergence planting', () => {
    expect(canMarkSprouted({ status: 'seed', source_type: 'seed_packet' })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: 'saved_seed' })).toBe(true)
  })

  it('keeps "seedling" — the one stage where the event is true and still unrecorded', () => {
    // The germination event does not write status, and StatusPicker does not write germinated_at,
    // so a hand-advanced seedling has no other route to capture it.
    expect(canMarkSprouted({ status: 'seedling', source_type: 'seed_packet' })).toBe(true)
  })

  it('hides for every post-emergence lifecycle stage', () => {
    for (const status of ['vegetative', 'flowering', 'fruiting', 'harvested', 'dormant', 'ended', 'failed']) {
      expect(canMarkSprouted({ status, source_type: 'seed_packet' })).toBe(false)
    }
  })

  it('hides for "rooting" — a cutting striking roots is not germination', () => {
    expect(canMarkSprouted({ status: 'rooting', source_type: 'seed_packet' })).toBe(false)
  })

  it('hides for origins that arrived already growing, whatever the stage', () => {
    for (const source_type of ['nursery_transplant', 'division', 'volunteer', 'gift', 'cutting_taken', 'rescued', 'plant_swap']) {
      expect(canMarkSprouted({ status: 'seed', source_type })).toBe(false)
    }
  })

  it('origin is a DENY-list: unknown / absent / future free-text origins still pass the stage gate', () => {
    // source_type is free-text (V4-SOURCEFREE-001) — an allow-list would silently break on a new
    // dropdownRegistry value. NULL means UNKNOWN, and the stage gate already carries the reduction.
    expect(canMarkSprouted({ status: 'seed' })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: null })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: 'unknown' })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: 'bulb_order_2027' })).toBe(true)
  })

  it('the stamp still wins over everything', () => {
    expect(canMarkSprouted({ status: 'seed', source_type: 'seed_packet', germinated_at: '2026-05-01' })).toBe(false)
  })

  it('is null-safe', () => {
    expect(canMarkSprouted(null)).toBe(false)
    expect(canMarkSprouted({})).toBe(false)
  })

  it('the rendered button follows the gate (nursery transplant at fruiting: gone)', () => {
    renderQA({ planting: { ...PL, status: 'fruiting', source_type: 'nursery_transplant' } })
    expect(screen.queryByRole('button', { name: /sprouted/i })).toBeNull()
    // the other two quick actions are untouched
    expect(screen.getByRole('button', { name: /Log watering/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add a photo/i })).toBeTruthy()
  })
})
