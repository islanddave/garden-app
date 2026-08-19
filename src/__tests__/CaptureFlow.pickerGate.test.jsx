// V4-PICKERGATE-001 — Snap's event destination offers only what it can POST.
//
// Snap is the fast path: photo first, three fields, save. The event destination carries no capture
// panel — its submit branch builds a flat body with no `harvest` key and no `metadata` key — so the
// three types whose API contract requires one were guaranteed 400s from here.
//
// This file once cross-asserted a SECOND destination: location. V4-LOCEVENT-001 deleted that
// destination's Event/Date fields outright (event_log_has_anchor has no location arm, so the POST
// they fed could never land), taking its four tests and the flag-rollback companion file with them.
// The PLANTING_REQUIRED_ENABLED rollback direction is still covered — EventTypePicker.pickerGate
// and ProjectDetail.pickerGate both exercise it on surfaces that do write events.
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
