// V4-PICKERGATE-001 — the location destination's planting arm ROLLS BACK with its feature flag.
//
// WHY ITS OWN FILE. CaptureFlow reads PLANTING_REQUIRED_ENABLED at MODULE scope, so one vi.mock per
// file is the only clean way to exercise a flag value; the sibling file pins the shipped value
// (true) and this one pins the rollback value. vi.resetModules gymnastics inside a single file
// would work and would also be the kind of harness nobody trusts a year later.
//
// WHAT IT GUARDS, which the flag-on file cannot: a mutation that hardcodes `plantScoped: false`
// instead of `!PLANTING_REQUIRED_ENABLED` produces an IDENTICAL list while the flag is on. The
// rollback lever would then be silently dead — flipping the flag off would leave the location
// select narrowed by a rule that is supposed to be switched off. That is a lever that only half
// works, which is worse than no lever, because it is believed.
//
// WHAT MUST NOT ROLL BACK: the capture-panel arm. The server enforces harvest / failed / given_away
// unconditionally (validatePostBody), so no client flag may re-admit them. Asserted below.
// No jest-dom (L-182).
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
  PLANTING_REQUIRED_ENABLED: false,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'
import { EVENT_TYPES, CAPTURE_PANEL_REQUIRED_TYPES } from '../lib/eventTypes.js'

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  fetchSpy.mockImplementation((path) => {
    if (path === '/api/plants') return Promise.resolve([{ id: 'pl-1', name: 'Basil', project_id: 'proj-9' }])
    if (path === '/api/locations/with-path') {
      return Promise.resolve([{ id: 'loc-1', full_path: 'Back garden › Bed 3', level: 2, is_active: true }])
    }
    return Promise.resolve({ ok: true })
  })
})
afterEach(() => cleanup())

const optionValues = (sel) => Array.from(sel.querySelectorAll('option')).map((o) => o.value)

async function snapToLocation() {
  await act(async () => { render(<CaptureFlow />) })
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId('mode-location')) })
  return screen.getByTestId('cap-loctype')
}

describe('V4-PICKERGATE-001 — PLANTING_REQUIRED_ENABLED = false (the rollback configuration)', () => {
  it('re-admits the planting-predicating types to the location destination', async () => {
    const values = optionValues(await snapToLocation())
    // The D2 enforcement is off, so this arm of the gate is off with it — the same way
    // EventNew.handleSubmit and ProjectDetail.handleLogEvent stop refusing.
    for (const t of ['watering', 'transplant', 'pruning', 'fertilizing']) {
      expect(values, `${t} should return when the D2 rule is rolled back`).toContain(t)
    }
  })

  it('still refuses the capture-panel types — the server enforces those with no flag involved', async () => {
    const values = optionValues(await snapToLocation())
    expect(CAPTURE_PANEL_REQUIRED_TYPES.length).toBeGreaterThan(0)
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) {
      expect(values, `${t} 400s regardless of any client flag`).not.toContain(t)
    }
  })

  it('lands on exactly the vocabulary minus the capture-panel types', async () => {
    const values = optionValues(await snapToLocation())
    expect(values.length).toBe(EVENT_TYPES.length - CAPTURE_PANEL_REQUIRED_TYPES.length)
  })
})
