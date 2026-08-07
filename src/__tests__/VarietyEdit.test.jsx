// V4-EDITCOMPLETE-001 V3 — the VarietyEdit route host, end to end through the REAL hooks.
//
// VarietyEditor.test.jsx proves the payload is correct. This file proves the payload actually
// leaves the app on the request the Lambda implements. That distinction is the whole point of
// 5b430f4: two Save buttons passed their tests for months while 405'ing on every press, because
// those tests mocked fetch and never asserted the method or the URL.
//
// Only `useApiFetch` is mocked — useVarieties, useCropTypes and VarietyEditor all run for real,
// so this also gives useVarieties.updateVariety its first executed caller.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import VarietyEdit from '../pages/VarietyEdit.jsx'

const VARIETY = {
  id: 'var-9',
  name: 'Black Krim',
  created_by: 'user_test',
  species: 'Solanum lycopersicum',
  crop_type_slug: 'tomato',
  lifecycle: 'annual',
  care_notes: 'Crack-prone in heavy rain.',
  soil_notes: null,
  days_to_maturity_min: 75,
}

const CROP_TYPES = [
  { slug: 'tomato', display_name: 'Tomato' },
  { slug: 'pepper', display_name: 'Pepper' },
]

// Route by path so the three GETs the page fires can resolve in any order.
function routeFetch(overrides = {}) {
  return (path, opts) => {
    if (opts?.method === 'PUT') return Promise.resolve({ ...VARIETY, ...(overrides.put ?? {}) })
    if (path === '/api/varieties/crop-types') return Promise.resolve(CROP_TYPES)
    if (path === '/api/varieties/var-9') return Promise.resolve(VARIETY)
    if (path.startsWith('/api/varieties')) return Promise.resolve([VARIETY])
    return Promise.resolve(null)
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/varieties/var-9/edit']}>
      <Routes>
        <Route path="/varieties/:varietyId/edit" element={<VarietyEdit />} />
      </Routes>
    </MemoryRouter>
  )
}

function putCall() {
  return fetchSpy.mock.calls.find(([, o]) => o?.method === 'PUT')
}

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(routeFetch())
})

describe('VarietyEdit — loads the row', () => {
  it('renders the variety name in the heading and the form', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#variety-edit-name')).toBeTruthy())
    expect(container.querySelector('#variety-edit-name').value).toBe('Black Krim')
    expect(screen.getByText('Edit Black Krim')).toBeTruthy()
  })

  it('shows a load error instead of an empty form when the GET fails', async () => {
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/varieties/var-9') return Promise.reject(Object.assign(new Error('nope'), { status: 404 }))
      return routeFetch()(path)
    })
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('not found')
    expect(container.querySelector('#variety-edit-name')).toBeNull()
  })
})

describe('VarietyEdit — the wire contract', () => {
  it('a saved edit issues PUT /api/varieties/:id carrying the changed field', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#variety-edit-name')).toBeTruthy())

    fireEvent.change(container.querySelector('#variety-edit-name'), { target: { value: 'Black Krym' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(putCall()).toBeTruthy())
    const [path, opts] = putCall()
    expect(path).toBe('/api/varieties/var-9')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body).name).toBe('Black Krym')
  })

  // The blank-to-clear channel has to survive JSON serialization all the way to the request,
  // not just exist inside the component's state.
  it('an emptied field travels as an explicit clear array on the PUT body', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#variety-edit-name')).toBeTruthy())
    for (const d of container.querySelectorAll('details')) d.open = true

    fireEvent.change(container.querySelector('#variety-edit-care_notes'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(putCall()).toBeTruthy())
    const body = JSON.parse(putCall()[1].body)
    expect(body.clear).toContain('care_notes')
    expect('care_notes' in body).toBe(false)
  })

  it('does not PUT anything when nothing changed', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#variety-edit-name')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
    expect(putCall()).toBeUndefined()
  })
})
