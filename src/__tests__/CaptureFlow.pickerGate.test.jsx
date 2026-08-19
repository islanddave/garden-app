// V4-PICKERGATE-001 — Snap's two event destinations offer only what they can POST.
//
// Snap is the fast path: photo first, three fields, save. Neither event destination carries a
// capture panel — both submit branches build a flat body with no `harvest` key and no `metadata`
// key — so the three types whose API contract requires one were guaranteed 400s from here.
//
// The two destinations differ in ONE capability and that difference is the whole reason this is a
// capability cross rather than a single shared list:
//   event destination    — always has a planting (submit throws 'Pick a planting' without one)
//   location destination — POSTs plant_id: null BY CONSTRUCTION; the place is the subject
// So the location destination additionally drops the D2 predication partition. Asserting the two
// against the same expected list would hide exactly the bug this file is for.
//
// Flags are pinned to the values featureFlags.js SHIPS (PLANTING_REQUIRED_ENABLED true) rather than
// the more convenient false — the planting arm is inert under false, so testing it off would
// exercise a configuration Dave never runs. The rollback direction has its own file
// (CaptureFlow.pickerGate.flagOff.test.jsx).
//
// Harness mirrors CaptureFlow.locationDest.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'

const { fetchSpy, uploadSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), uploadSpy: vi.fn(), navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PLANTING_REQUIRED_ENABLED: true,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'
import {
  EVENT_TYPES,
  CAPTURE_PANEL_REQUIRED_TYPES,
  PLANTING_REQUIRED_TYPES,
  PLANTING_EXEMPT_TYPES,
  creatableEventTypes,
} from '../lib/eventTypes.js'

const LOCS = [{ id: 'loc-1', full_path: 'Back garden › Bed 3', level: 2, is_active: true }]
const PLANTS = [{ id: 'pl-1', name: 'Basil', project_id: 'proj-9' }]

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  fetchSpy.mockImplementation((path) => {
    if (path === '/api/plants') return Promise.resolve(PLANTS)
    if (path === '/api/locations/with-path') return Promise.resolve(LOCS)
    return Promise.resolve({ ok: true })
  })
})
afterEach(() => cleanup())

const optionValues = (sel) => Array.from(sel.querySelectorAll('option')).map((o) => o.value)

async function snapTo(modeTestId) {
  await act(async () => { render(<CaptureFlow />) })
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId(modeTestId)) })
}

describe('V4-PICKERGATE-001 — Snap event destination (a planting, no capture panel)', () => {
  it('renders EXACTLY the surface\'s creatable set', async () => {
    await snapTo('mode-event')
    const expected = creatableEventTypes({ capturePanels: false, plantScoped: true })
    expect(optionValues(screen.getByLabelText('Event')).sort()).toEqual([...expected].sort())
  })

  it('drops every capture-panel type and keeps everything else', async () => {
    await snapTo('mode-event')
    const values = optionValues(screen.getByLabelText('Event'))
    expect(CAPTURE_PANEL_REQUIRED_TYPES.length).toBeGreaterThan(0)
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) expect(values).not.toContain(t)
    // The other direction — a filter that narrowed everything would pass the loop above.
    for (const t of EVENT_TYPES) {
      if (CAPTURE_PANEL_REQUIRED_TYPES.includes(t)) continue
      expect(values, `${t} must still be offered`).toContain(t)
    }
    expect(values).toContain('watering')     // planting-predicating; this surface HAS a planting
  })

  it('the seeded default (watering) is still in the list — the <select> is never blank', async () => {
    await snapTo('mode-event')
    const sel = screen.getByLabelText('Event')
    expect(sel.value).toBe('watering')
    expect(optionValues(sel)).toContain(sel.value)
  })
})

describe('V4-PICKERGATE-001 — Snap location destination (no planting, no capture panel)', () => {
  it('renders EXACTLY the surface\'s creatable set, which is STRICTLY smaller than the event destination\'s', async () => {
    await snapTo('mode-location')
    const sel = screen.getByTestId('cap-loctype')
    const expected = creatableEventTypes({ capturePanels: false, plantScoped: false })
    expect(optionValues(sel).sort()).toEqual([...expected].sort())
    // The capability difference is real and observable, not a comment: this is the assertion that
    // fails if the location destination is wired to the event destination's list.
    const eventDest = creatableEventTypes({ capturePanels: false, plantScoped: true })
    expect(optionValues(sel).length).toBeLessThan(eventDest.length)
  })

  it('drops every planting-predicating type — a location event has no planting to predicate on', async () => {
    await snapTo('mode-location')
    const values = optionValues(screen.getByTestId('cap-loctype'))
    for (const t of PLANTING_REQUIRED_TYPES) expect(values, `${t} needs a planting`).not.toContain(t)
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) expect(values).not.toContain(t)
  })

  it('keeps every place-scoped type — the ones a photo of a bed is actually about', async () => {
    await snapTo('mode-location')
    const values = optionValues(screen.getByTestId('cap-loctype'))
    for (const t of PLANTING_EXEMPT_TYPES) expect(values, `${t} must still be offered`).toContain(t)
    // The row that asked for this destination named these: a washed-out bed edge, a leaning
    // trellis, a new fence line.
    for (const t of ['observation', 'photo', 'weeded', 'mulched', 'frost_damage']) {
      expect(values).toContain(t)
    }
    expect(values.length).toBeGreaterThan(0)
  })

  it('the seeded default (observation) is still in the list — the <select> is never blank', async () => {
    await snapTo('mode-location')
    const sel = screen.getByTestId('cap-loctype')
    expect(sel.value).toBe('observation')
    expect(optionValues(sel)).toContain(sel.value)
  })
})
