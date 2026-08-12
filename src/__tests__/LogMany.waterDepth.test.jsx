// V4-WATERMATH-001 F0 — batch amount-class capture on Log Many.
//
// The REAL <ScopeChecklist> is used (not the stub the other LogMany suites install) because the
// per-row override renders inside its review list — stubbing it out would leave the override
// untested while the suite still went green, which is the shape of the inert-feature failures
// this repo has shipped twice. Every assertion is a render or a request-body assertion.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const navigate = vi.fn()
const location = { pathname: '/log/many', search: '', state: {} }
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  useLocation: () => location,
  Link: ({ children }) => children,
}))

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))

import LogMany from '../pages/LogMany.jsx'

const PLANTINGS = [{ id: 'pl-1', name: 'Aji Dulce' }, { id: 'pl-2', name: 'Basil Row' }]
const batchPosts = []

beforeEach(() => {
  navigate.mockClear()
  batchPosts.length = 0
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: [] })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) return Promise.resolve({ count: PLANTINGS.length, plantings: PLANTINGS })
      batchPosts.push(body)
      return Promise.resolve({ batch_id: 'b-1', count: PLANTINGS.length })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

async function renderReady() {
  render(<LogMany />)
  // Wait for the dry-run preview to land — the confirm button label carries the committed count.
  await screen.findByText(/^Log watered on 2$/)
}

async function openReviewList() {
  fireEvent.click(await screen.findByText(/Review 2 plantings/))
}

async function confirm() {
  fireEvent.click(await screen.findByText(/^Log watered on 2$/))
  await waitFor(() => expect(batchPosts.length).toBe(1))
}

describe('LogMany — ONE batch-level chip', () => {
  it('renders the three batch chips with Normal preselected (watering is the default type)', async () => {
    await renderReady()
    expect(screen.getByTestId('water-depth-group')).toBeTruthy()
    expect(screen.getByTestId('water-depth-normal').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('water-depth-light').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('water-depth-deep').getAttribute('aria-pressed')).toBe('false')
  })

  it('an untouched batch posts normal/default for the whole batch', async () => {
    await renderReady()
    await confirm()
    expect(batchPosts[0].metadata).toEqual({ water_depth: 'normal', water_depth_source: 'default' })
    expect(batchPosts[0].metadata_overrides).toBeUndefined()
  })

  it('the tapped batch chip reaches the batch POST as a user choice', async () => {
    await renderReady()
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    expect(screen.getByTestId('water-depth-deep').getAttribute('aria-pressed')).toBe('true')
    await confirm()
    expect(batchPosts[0].metadata).toEqual({ water_depth: 'deep', water_depth_source: 'user' })
  })
})

describe('LogMany — per-row override', () => {
  it('each review row shows its inherited class without demanding a decision', async () => {
    await renderReady()
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    await openReviewList()
    for (const pl of PLANTINGS) {
      const toggle = screen.getByTestId(`row-depth-toggle-${pl.id}`)
      expect(toggle).toBeTruthy()
      // Inherited from the batch chip — the row is not a blank decision.
      expect(toggle.getAttribute('aria-label')).toMatch(/Deep/)
    }
  })

  it('tapping a row chip reveals that row\'s chips, and the pick rides in metadata_overrides', async () => {
    await renderReady()
    await openReviewList()
    fireEvent.click(screen.getByTestId('row-depth-toggle-pl-2'))
    // Revealed for THAT row only.
    expect(screen.getByTestId('row-depth-pl-2-light')).toBeTruthy()
    expect(screen.queryByTestId('row-depth-pl-1-light')).toBeNull()

    fireEvent.click(screen.getByTestId('row-depth-pl-2-light'))
    await waitFor(() => expect(screen.getByTestId('row-depth-toggle-pl-2').getAttribute('aria-label')).toMatch(/Light/))
    // The other row is untouched and still inherits.
    expect(screen.getByTestId('row-depth-toggle-pl-1').getAttribute('aria-label')).toMatch(/Normal/)

    await confirm()
    expect(batchPosts[0].metadata).toEqual({ water_depth: 'normal', water_depth_source: 'default' })
    expect(batchPosts[0].metadata_overrides).toEqual({
      'pl-2': { water_depth: 'light', water_depth_source: 'user' },
    })
  })

  it('re-picking the batch value clears the override rather than pinning it', async () => {
    await renderReady()
    await openReviewList()
    fireEvent.click(screen.getByTestId('row-depth-toggle-pl-1'))
    fireEvent.click(screen.getByTestId('row-depth-pl-1-deep'))
    fireEvent.click(await screen.findByTestId('row-depth-toggle-pl-1'))
    fireEvent.click(screen.getByTestId('row-depth-pl-1-normal'))
    await confirm()
    expect(batchPosts[0].metadata_overrides).toBeUndefined()
  })

  it('an override on an EXCLUDED planting never reaches the POST', async () => {
    await renderReady()
    await openReviewList()
    fireEvent.click(screen.getByTestId('row-depth-toggle-pl-2'))
    fireEvent.click(screen.getByTestId('row-depth-pl-2-deep'))
    // Deselect that planting in the review list.
    fireEvent.click(await screen.findByText('Basil Row'))
    await waitFor(() => expect(screen.queryByTestId('row-depth-toggle-pl-2')).toBeNull())
    fireEvent.click(await screen.findByText(/^Log watered on 1$/))
    await waitFor(() => expect(batchPosts.length).toBe(1))
    expect(batchPosts[0].exclude_plant_ids).toEqual(['pl-2'])
    expect(batchPosts[0].metadata_overrides).toBeUndefined()
  })
})

describe('LogMany — non-watering batches carry no class', () => {
  it('switching the type off watering removes the chips and the metadata keys', async () => {
    await renderReady()
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    fireEvent.click(screen.getByRole('button', { name: /fertiliz/i }))
    await waitFor(() => expect(screen.queryByTestId('water-depth-group')).toBeNull())
    fireEvent.click(await screen.findByRole('button', { name: /^Log fertilized .* on 2$/ }))
    await waitFor(() => expect(batchPosts.length).toBe(1))
    expect(batchPosts[0].metadata).toBeUndefined()
    expect(batchPosts[0].metadata_overrides).toBeUndefined()
  })
})

describe('LogMany — the result screen names the recorded class', () => {
  it('states the class beside the durable undo', async () => {
    await renderReady()
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    await confirm()
    const line = await screen.findByTestId('logmany-depth-recorded')
    expect(line.textContent).toMatch(/Deep/)
    expect(screen.getByText('Undo')).toBeTruthy()
  })
})
