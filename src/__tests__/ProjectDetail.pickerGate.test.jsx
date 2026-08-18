// V4-PICKERGATE-001 — the ProjectDetail mini-logger offers only what its POST can carry.
//
// The mini-logger's handleLogEvent builds a FLAT body: project_id, event_type, plant_id,
// event_date, title, notes, private_notes, quantity, is_public, has_photo. No `harvest` key and no
// `metadata` key at all. So the three types whose API contract requires one of those were a
// guaranteed 400 from this surface — harvest since the page shipped, failed / given_away from the
// moment V4-LOSSUI-001 opened the creation gate.
//
// WHY A RENDER TEST AND NOT ONLY THE PURE ONE. creatableEventTypes.test.js proves the SET is right.
// It cannot prove this page renders that set: the page could compute the filtered list and then map
// SELECTABLE_EVENT_TYPES into the <select> anyway. The defect lives in the JSX, so an assertion
// over the real <option> elements is the only one that sees it.
//
// Harness mirrors ProjectDetail.eventPaging.test.jsx (router fully stubbed; heavy children stubbed).
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, paramsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  paramsRef: { id: 'proj-1' },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useParams: () => paramsRef,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))
vi.mock('../components/Breadcrumb.jsx', () => ({ default: () => <div data-testid="breadcrumb-stub" /> }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <div data-testid="favorite-toggle-stub" /> }))
vi.mock('../components/AssigneePicker.jsx', () => ({ default: () => <div data-testid="assignee-stub" /> }))
vi.mock('../lib/status.js', () => ({ getStatusColors: () => ({ bg: '#fff', text: '#000', border: '#ccc' }) }))

import ProjectDetail from '../pages/ProjectDetail.jsx'
import { EVENT_TYPES, CAPTURE_PANEL_REQUIRED_TYPES, creatableEventTypes } from '../lib/eventTypes.js'

const PROJECT = {
  id: 'proj-1', name: 'Peppers', slug: 'peppers', status: 'growing',
  is_public: false, start_date: '2026-03-15', parent_project_id: null,
  version: 4, variety: null, species: null, description: null, location_id: null,
  event_count: 0,
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset()
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/events?project_id=proj-1')) {
      return Promise.resolve({ events: [], limit: 200, offset: 0, has_more: false })
    }
    if (path.startsWith('/api/projects?parent_id=')) return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path.startsWith('/api/projects')) return Promise.resolve([PROJECT])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

// Values, not labels: the assertion is about which event_type strings this <select> can produce,
// and a label is a second thing that can drift.
const optionValues = (sel) => Array.from(sel.querySelectorAll('option')).map((o) => o.value)

async function openMiniLogger() {
  render(<ProjectDetail />)
  await waitFor(() => expect(screen.getByText('+ Log event')).toBeTruthy())
  fireEvent.click(screen.getByText('+ Log event'))
  return screen.getByLabelText('Event type *')
}

describe('V4-PICKERGATE-001 — ProjectDetail mini-logger event-type <select>', () => {
  it('renders EXACTLY the surface\'s creatable set, derived — not a hand-list', () => {
    // Asserted against creatableEventTypes(caps) rather than a literal array, so the day a fourth
    // required-field type joins CAPTURE_PANEL_REQUIRED_TYPES this test needs no edit and still
    // fails if the page forgets to drop it.
    return openMiniLogger().then((sel) => {
      const expected = creatableEventTypes({ capturePanels: false, plantScoped: true })
      expect(optionValues(sel).sort()).toEqual([...expected].sort())
    })
  })

  it('offers NONE of the capture-panel types — every one was a guaranteed 400 here', async () => {
    const sel = await openMiniLogger()
    const values = optionValues(sel)
    expect(CAPTURE_PANEL_REQUIRED_TYPES.length).toBeGreaterThan(0) // the loop below must not be vacuous
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) expect(values).not.toContain(t)
    // Named as well as derived: this lane exists because of these two, and `harvest` is the
    // pre-existing member the general fix picks up for free.
    expect(values).not.toContain('failed')
    expect(values).not.toContain('given_away')
    expect(values).not.toContain('harvest')
  })

  it('still offers everything else, including the ~34 planting-predicating types', async () => {
    const sel = await openMiniLogger()
    const values = optionValues(sel)
    // THE OTHER DIRECTION. A filter that narrowed too far would satisfy the test above completely.
    for (const t of EVENT_TYPES) {
      if (CAPTURE_PANEL_REQUIRED_TYPES.includes(t)) continue
      expect(values, `${t} must still be offered`).toContain(t)
    }
    expect(values.length).toBe(EVENT_TYPES.length - CAPTURE_PANEL_REQUIRED_TYPES.length)
    // The mini-logger HAS a planting picker, so plant-predicating types stay: this is the surface
    // capability that separates it from CaptureFlow's location destination.
    expect(values).toContain('watering')
    expect(values).toContain('transplant')
  })

  it('the default event_type survives the filter — the <select> is never blank', async () => {
    // A <select> whose value is absent from its options silently renders the placeholder (the
    // LOCATION_TYPE_LABELS trap, constants.js). emptyEventForm() seeds 'observation'.
    const sel = await openMiniLogger()
    expect(sel.value).toBe('observation')
    expect(optionValues(sel)).toContain(sel.value)
  })
})
