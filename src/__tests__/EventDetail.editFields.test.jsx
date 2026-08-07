// BUG-EVENTEDITFIELDS-001 slices 2 + 4 — the client half.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is not "the field is missing". It is the mirror image of
// the bug being fixed: a save that NULLs a column the form never rendered. `clear` is derived from
// a loop, so if that loop ever ranges wider than what is on screen, every save silently wipes
// columns the user cannot see — no error, no log line, and the prior values are gone.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Harness copied verbatim from EventDetail.test.jsx — useApiFetch returns { fetch }, and the
// upload HOOK is what needs stubbing, not the PhotoUpload component.
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

const baseEvent = {
  id: 'e1', project_id: 'p1', plant_id: 'pl1', location_id: null,
  event_type: 'pest_treatment', event_date: '2026-08-01T00:00:00Z',
  title: 't', notes: '', private_notes: '', quantity: '', is_public: false,
  flagged_as_issue: true, severity: 2,
  treatment_product_text: 'Neem oil', treatment_category: 'pest_control',
  treatment_amount: '2 tbsp', pest_target: 'aphids',
  harvest: null,
}

function setup(ev = baseEvent) {
  dataRef.event = { ...ev }
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1') {
      if (opts?.method === 'PUT') return Promise.resolve({ ...dataRef.event })
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

const clickEdit = async () => {
  await flushLoad()
  fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
}

const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
  await waitFor(() => expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PUT')).toBe(true))
}

const savedBody = () => {
  const call = apiFetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
  expect(call, 'a PUT must have been issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

describe('slice 2: the edit form seeds and saves what it can now write', () => {
  beforeEach(() => { apiFetchSpy.mockReset() })

  it('seeds the treatment fields from the GET body', async () => {
    setup(); await clickEdit()
    expect(screen.getByLabelText(/product/i).value).toBe('Neem oil')
    expect(screen.getByLabelText(/amount \(optional\)/i).value).toBe('2 tbsp')
    expect(screen.getByLabelText(/pest \/ target/i).value).toBe('aphids')
  })

  it('seeds the flag and severity, and renders severity only while flagged', async () => {
    setup(); await clickEdit()
    expect(screen.getByLabelText(/flag as an issue/i).checked).toBe(true)
    expect(screen.getByLabelText(/severity/i).value).toBe('2')
    fireEvent.click(screen.getByLabelText(/flag as an issue/i))
    expect(screen.queryByLabelText(/severity/i)).toBeNull()
  })

  it('an unrelated edit ROUND-TRIPS the treatment columns unchanged', async () => {
    // The regression that would otherwise ship: editing the title and blanking four columns.
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'new title' } })
    await save()
    const b = savedBody()
    expect(b.treatment_product_text).toBe('Neem oil')
    expect(b.pest_target).toBe('aphids')
    expect(b.clear ?? []).toEqual([])
  })

  it('emptying a rendered field emits it in clear[] — and ONLY it', async () => {
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/amount \(optional\)/i), { target: { value: '' } })
    await save()
    const b = savedBody()
    expect(b.clear).toEqual(['treatment_amount'])
    expect(b.treatment_product_text).toBe('Neem oil')
  })

  it('unflagging sends severity absent, never a stale value', async () => {
    // The server refuses severity-without-flag with a 400. This proves the client cannot
    // construct that request, so the user never sees an unexplained save failure.
    setup(); await clickEdit()
    fireEvent.click(screen.getByLabelText(/flag as an issue/i))
    await save()
    const b = savedBody()
    expect(b.flagged_as_issue).toBe(false)
    expect(b.severity).toBeUndefined()
  })

  it('a NON-treatment event neither renders nor clears the treatment fields', async () => {
    // The clear loop must be gated on the same condition as the render. If it were not, editing an
    // observation would emit clear:[...4 columns] for fields never shown.
    setup({ ...baseEvent, event_type: 'observation' }); await clickEdit()
    expect(screen.queryByLabelText(/pest \/ target/i)).toBeNull()
    await save()
    expect(savedBody().clear ?? []).toEqual([])
  })
})

describe('slice 4: the re-anchor control is inert while its flag is off', () => {
  it('does not send plant_id/project_id when EVENT_REANCHOR_ENABLED is false', async () => {
    // Flag OFF is the shipped state, so this pins that EventDetail's save is byte-identical to
    // before slice 4 existed — which is what makes the flag a real lever rather than dead code.
    setup(); await clickEdit()
    await save()
    const b = savedBody()
    expect(b.plant_id).toBeUndefined()
    expect(b.project_id).toBeUndefined()
  })
})
