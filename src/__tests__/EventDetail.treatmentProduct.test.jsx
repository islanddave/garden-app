// BUG-TREATMENTPRODUCT-001 — the client half: make the product text VISIBLE.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is invisibility, not absence. treatment_product_text was
// writable by the POST, seeded into the edit form, and returned by both the GET and the PUT — and
// rendered by NOTHING in src/. So when the PUT's isTreatment gate nulled a fertilizing row's
// product on the next unrelated edit, no pixel changed: the value was gone from a column no screen
// was reading. A read render is what turns that class of loss from silent into reportable.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Harness copied verbatim from EventDetail.editFields.test.jsx — useApiFetch returns { fetch }, and
// the upload HOOK is what needs stubbing, not the PhotoUpload component.
const { apiFetchSpy, navigateSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigateSpy }
})

import EventDetail from '../pages/EventDetail.jsx'

// A fertilizing event carrying a product — the row shape the POST has written since the create-half
// of this fix landed, and the one the PUT used to destroy.
const fertEvent = {
  id: 'e1', project_id: 'p1', plant_id: 'pl1', location_id: null,
  event_type: 'fertilizing', event_date: '2026-08-01T00:00:00Z',
  title: 'Fed the tomatoes', notes: '', private_notes: '', quantity: '', is_public: false,
  flagged_as_issue: false, severity: null,
  treatment_product_text: "Neptune's Harvest 2-3-1", treatment_category: null,
  treatment_amount: null, pest_target: null,
  harvest: null,
}

function setup(ev = fertEvent) {
  dataRef.event = { ...ev }
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1') {
      // The PUT echoes the SAVED row, which is what EventDetail re-seeds its state from. Modelled
      // as the server's own preserve semantics: keys the client omitted keep their stored value.
      if (opts?.method === 'PUT') {
        const sent = JSON.parse(opts.body)
        dataRef.event = { ...dataRef.event, ...sent }
        return Promise.resolve({ ...dataRef.event })
      }
      return Promise.resolve(dataRef.event)
    }
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/p1/events/e1']}>
      <Routes><Route path="/projects/:id/events/:eventId" element={<EventDetail />} /></Routes>
    </MemoryRouter>,
  )
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
}

const savedBody = () => {
  const call = apiFetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
  expect(call, 'a PUT must have been issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

describe('the product text is rendered in read mode', () => {
  beforeEach(() => { apiFetchSpy.mockReset() })

  it("shows a fertilizing event's product without opening the editor", async () => {
    // The whole point: before this, the ONLY way to see it was to tap Edit.
    setup(); await flushLoad()
    expect(screen.getByText('Product')).toBeTruthy()
    expect(screen.getByText("Neptune's Harvest 2-3-1")).toBeTruthy()
  })

  it('shows it for the treatment types that always owned the column too', async () => {
    setup({ ...fertEvent, event_type: 'pest_treatment', treatment_product_text: 'Neem oil' })
    await flushLoad()
    expect(screen.getByText('Neem oil')).toBeTruthy()
  })

  it('renders no row when there is no product — an empty labelled row reads as data', async () => {
    // Value-gated, exactly like the Quantity row it sits beside. A row rendered for a null column
    // would put a blank under a heading and look like a recorded value of "nothing".
    setup({ ...fertEvent, treatment_product_text: null })
    await flushLoad()
    expect(screen.queryByText('Product')).toBeNull()
  })
})

describe('an unrelated edit round-trips the product, and the screen proves it', () => {
  beforeEach(() => { apiFetchSpy.mockReset() })

  it('editing the title leaves the product on screen afterwards', async () => {
    // The exact user story from the ticket: open a fertilizing event, fix something trivial, save.
    // Before the server fix, the PUT's NOT isTreatment arm nulled the column and the echoed row came
    // back without it — invisibly, because nothing rendered it. Both halves are needed for this to
    // hold: the render (or you cannot see the loss) and the widened gate (or there is nothing left
    // to see).
    setup(); await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Fed the tomatoes again' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PUT')).toBe(true))

    const b = savedBody()
    // The client must not blank it from its side either: for a non-treatment type it renders no
    // product input, so it sends neither the key nor a clear[] entry — absence is what lets the
    // server's COALESCE preserve arm fire.
    expect(b.treatment_product_text, 'the client must not send an explicit null').toBeUndefined()
    expect(b.clear ?? [], 'the clear loop must not range over unrendered fields').toEqual([])
    expect(b.event_type, 'event_type rides along on every save — the trigger for the server gate').toBe('fertilizing')

    await waitFor(() => expect(screen.getByText("Neptune's Harvest 2-3-1")).toBeTruthy())
  })
})
