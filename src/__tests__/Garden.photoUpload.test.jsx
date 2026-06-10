// Garden.photoUpload.test.jsx — V3-IA: per-planting photo uploader restored on the merged
// Garden surface (capability lived on the retired Plants page, deleted in ba88379).
// Covers: (1) the SELECTOR CONTRACT — every rendered PlantingRow exposes a hidden
// <input type="file" id="plant-list-photo-<plantId>"> (automated bulk-attach sessions
// drive uploads through it); (2) the WIRE CONTRACT — real PhotoUpload + real
// useUploadPhoto, mocked api fetch + window.fetch: presign GET keyed plants/<id>/...,
// S3 PUT, POST /api/photos { storage_path, plant_id, project_id, caption, is_public },
// then onUploadComplete refetches /api/plants (featured auto-promote read-back);
// (3) the uploader controls live OUTSIDE the row's nav <a> (no accidental navigation).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [
  { id: 'a', name: 'Tomatoes', status: 'active', parent_project_id: null, is_public: true },
]
const PLANTS = [
  { id: 'p1', name: 'Sungold',  project_id: 'a', status: 'growing', quantity: 2 },
  { id: 'p2', name: 'Brandywine', project_id: 'a', status: 'growing', quantity: 1 },
]

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url, opts = {}) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants')   return Promise.resolve(PLANTS)
    if (url.startsWith('/api/photos/upload-url')) return Promise.resolve({ upload_url: 'https://s3.test/put' })
    if (url === '/api/photos' && opts.method === 'POST') return Promise.resolve({ id: 'ph1' })
    return Promise.resolve([])
  })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  globalThis.URL.revokeObjectURL = vi.fn()
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200 }))
})

async function renderExpanded() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
  fireEvent.click(screen.getByLabelText(/Expand Tomatoes/))
}

describe('Garden — per-planting photo uploader (V3-IA restore)', () => {
  it('every planting row exposes the hidden file input under the stable id contract', async () => {
    await renderExpanded()
    for (const pl of PLANTS) {
      const input = document.getElementById(`plant-list-photo-${pl.id}`)
      expect(input).not.toBeNull()
      expect(input.tagName).toBe('INPUT')
      expect(input.getAttribute('type')).toBe('file')
      expect(input.getAttribute('accept')).toBe('image/*')
    }
    // Take + choose triggers render per row.
    expect(screen.getAllByTestId('photo-upload-take')).toHaveLength(PLANTS.length)
    expect(screen.getAllByTestId('photo-upload-choose')).toHaveLength(PLANTS.length)
  })

  it('uploader controls sit OUTSIDE the planting nav link (no accidental navigation)', async () => {
    await renderExpanded()
    const input = document.getElementById('plant-list-photo-p1')
    expect(input.closest('a')).toBeNull()
    const navLink = screen.getByLabelText('Open Sungold')
    expect(navLink.getAttribute('href')).toBe('/projects/a/plantings/p1')
  })

  it('driving the hidden input runs the 3-step wire contract with old Plants.jsx payload semantics', async () => {
    await renderExpanded()
    const file = new File(['x'], 'leaf.jpg', { type: 'image/jpeg' })
    const input = document.getElementById('plant-list-photo-p1')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })

    // Step 1: presign keyed under plants/<plantId>/.
    const presignCall = fetchMock.mock.calls.find(([u]) => typeof u === 'string' && u.startsWith('/api/photos/upload-url'))
    expect(presignCall).toBeDefined()
    expect(decodeURIComponent(presignCall[0])).toContain('key=plants/p1/')

    // Step 2: direct S3 PUT of the file.
    expect(globalThis.fetch).toHaveBeenCalledWith('https://s3.test/put',
      expect.objectContaining({ method: 'PUT', body: file }))

    // Step 3: POST /api/photos with linkage {plant_id, project_id} — featured/primary
    // semantics ride server-side auto-promote off this registration, same as old Plants page.
    const postCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/photos' && o?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body).toMatchObject({ plant_id: 'p1', project_id: 'a', is_public: true, caption: null })
    expect(body.storage_path).toMatch(/^plants\/p1\/.+\.jpg$/)

    // onUploadComplete: refetch /api/plants so featured_photo_view_url flows into the tree.
    await waitFor(() => {
      const plantFetches = fetchMock.mock.calls.filter(([u]) => u === '/api/plants')
      expect(plantFetches.length).toBeGreaterThanOrEqual(2)
    })
  })
})
