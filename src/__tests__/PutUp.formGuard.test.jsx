// V4-RELOADGATEWIRE-001 — proves PutUpForm carries the same three-part form guard as
// EventNew/LogMany: a versioned sessionStorage draft (draftStash), the Sheet backdrop-tap guard
// (useReportOverlayDirty), and the SW reload deferral (reloadGate) — all driven off ONE `dirty`
// predicate (see the rationale comment above `dirty` in PutUp.jsx).
//
// Mirrors three existing files rather than inventing new conventions:
//   - PutUp.test.jsx           — mock shape for useApiFetch/useUploadPhoto/useCropTypes, renderPutUp.
//   - LogManyDraftFullPage.test.jsx — readStash/seedStash sessionStorage helpers.
//   - EventNew.reloadGateWire.test.jsx — REAL reloadGate (isReloadBlocked/clearReloadBlocks), no
//     spy: a mocked setReloadBlocked would hide exactly the "shipped but never wired" blind spot
//     that file exists to catch (reloadGate.js's own header names EventNew as the "FIRST INTENDED
//     CONSUMER" — this file proves PutUp is now a second, real one).
//   - OverlayDirtyWiring.test.jsx — real OverlayHost + backdrop-tap dismiss check for the dirty
//     channel (a mocked useReportOverlayDirty would prove nothing about wiring).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
const uploadMock = vi.fn()
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadMock, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
      { slug: 'pepper', display_name: 'Peppers', category: 'vegetable' },
    ],
    loading: false,
  }),
}))

import PutUp from '../pages/PutUp.jsx'
import { OverlayHost } from '../App.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const STASH_KEY = 'gardenApp.draft.put-up'
function readStash() {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
function seedStash(data) {
  sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))
}

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path === '/api/plants' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1', source_kind: 'own_garden' })
    return Promise.resolve(null)
  })
}

function lastPost() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => o?.method === 'POST')
  return call ? JSON.parse(call[1].body) : null
}

function entryFor(prefill) {
  return prefill ? { pathname: '/put-up', state: { prefill } } : { pathname: '/put-up' }
}
function renderFullPage(prefill) {
  return render(<MemoryRouter initialEntries={[entryFor(prefill)]}><PutUp /></MemoryRouter>)
}
// Location sink for the overlay-dirty backdrop tests — a dismiss navigates to the background
// (here: falls back to /today, since no background was pushed), a no-op leaves us on /put-up.
function Loc() {
  return <div data-testid="loc">{useLocation().pathname}</div>
}
function renderInOverlay(prefill) {
  return render(
    <MemoryRouter initialEntries={[entryFor(prefill)]}>
      <Loc />
      <OverlayHost ariaLabel="Put-Up" size="full"><PutUp /></OverlayHost>
    </MemoryRouter>
  )
}
const backdrop = () => screen.getByRole('dialog').previousSibling

function openLogForm() {
  fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
}

beforeEach(() => {
  fetchMock.mockReset(); uploadMock.mockReset(); wire()
  sessionStorage.clear()
  clearReloadBlocks()
})

describe('PutUp — draft stash (V4-RELOADGATEWIRE-001)', () => {
  it('does NOT persist a pristine form', async () => {
    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(readStash()).toBeNull()
  })

  it('persists a dirty form (a crop pick alone, no typed text)', async () => {
    renderFullPage()
    openLogForm()
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    await waitFor(() => expect(readStash()?.cropSlug).toBe('tomato'))
  })

  it('restores a stashed draft on mount (no prefill)', async () => {
    seedStash({ cropSlug: 'pepper', qtyValue: '7' })
    renderFullPage()
    openLogForm()
    const cropSelect = await screen.findByRole('combobox', { name: 'Crop' })
    await waitFor(() => expect(cropSelect.value).toBe('pepper'))
    expect(screen.getByRole('textbox', { name: 'Quantity' }).value).toBe('7')
  })

  it('clears the stash on a successful submit', async () => {
    renderFullPage({ crop_type_slug: 'tomato' }) // prefill -> lands directly on the log form
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '3' } })
    await waitFor(() => expect(readStash()?.qtyValue).toBe('3'))
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    await screen.findByText(/Now in/i)
    expect(readStash()).toBeNull()
  })

  // The precedence rule mirrored from EventNew's hasSeed / LogMany's seedProject|seedLocation: an
  // explicit fresh navigation (here, a harvest-triggered "preserve this?" prefill) must win over an
  // unrelated stale draft left by an earlier session — never silently swap the user's attribution.
  it('a harvest-triggered prefill is NOT clobbered by an unrelated stashed draft', async () => {
    seedStash({ cropSlug: 'pepper', qtyValue: '99', notes: 'unrelated old draft' })
    renderFullPage({ crop_type_slug: 'tomato' })
    const cropSelect = await screen.findByRole('combobox', { name: 'Crop' })
    expect(cropSelect.value).toBe('tomato')
    expect(screen.getByRole('textbox', { name: 'Quantity' }).value).toBe('')
  })
})

describe('PutUp — reloadGate + overlay-dirty wiring on the SAME predicate', () => {
  it('a pristine mount does not hold the reload gate', async () => {
    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(isReloadBlocked()).toBe(false)
  })

  it('a crop pick holds the reload gate; clearing it back to pristine releases the hold', async () => {
    renderFullPage()
    openLogForm()
    const cropSelect = await screen.findByRole('combobox', { name: 'Crop' })
    fireEvent.change(cropSelect, { target: { value: 'tomato' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(cropSelect, { target: { value: '' } })
    expect(isReloadBlocked()).toBe(false)
  })

  it('unmounting a dirty form releases the reload-gate hold (never wedge updates)', async () => {
    const { unmount } = renderFullPage()
    openLogForm()
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '5' } })
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  // THE PROOF the task asks for: the identical action fires BOTH guard hooks off the identical
  // `dirty` value — a crop pick blocks the reload gate AND locks the Sheet backdrop in the same
  // breath, and a clean form does neither.
  it('the same crop pick that holds the reload gate also locks the Sheet backdrop', async () => {
    renderInOverlay()
    openLogForm()
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(backdrop())
    // Dirty -> the backdrop tap no-ops (still on /put-up, never reached the /today dismiss).
    expect(screen.getByTestId('loc').textContent).toBe('/put-up')
  })

  it('a clean form lets the backdrop tap dismiss (baseline — the guard is not permanently on)', async () => {
    renderInOverlay()
    openLogForm()
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })
})
