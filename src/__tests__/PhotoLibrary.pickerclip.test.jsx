/**
 * src/__tests__/PhotoLibrary.pickerclip.test.jsx
 * BUG-PICKERCLIP-001 — the two picker-occlusion instances in PhotoLibrary.
 *
 * WHAT THESE TESTS CANNOT DO: observe the defect. jsdom has no layout engine, no scrollports and no
 * stacking contexts, so "the listbox is clipped" / "the bar paints over row 2" are both unobservable
 * here (see reference/jsdom-cannot-observe-layout-defects.md). A test that opened the picker and
 * asserted the listbox is in the DOM would pass with the bug fully present — it was in the DOM the
 * whole time, just clipped and un-tappable. So each case asserts the STRUCTURAL PROPERTY that makes
 * the defect impossible instead:
 *   clip  — no element between the picker's input and the modal card may be a clipping/scrolling box.
 *   cover — the fixed z150 bar is visibility:hidden + pointerEvents:none exactly while the picker is
 *           open, and visible otherwise.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null,
    preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const PROJECT  = { id: 'proj-1', name: 'Spring 2026' }
const LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }
const PLANT    = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1', project_name: 'Spring 2026' }
// thumb_url only, never view_url: the grid <img> gives the card its accessible name, while the
// modal's PhotoImg (which mints presigned URLs on mount) stays out of a test about occlusion.
const PHOTO    = { id: 'ph-1', project_id: 'proj-1', project_name: 'Spring 2026', caption: null, thumb_url: 'blob:thumb' }

// A box clips its absolutely-positioned descendants unless overflow is `visible` in BOTH axes.
// `auto`/`scroll` count: a scroll container clips the block-START edge unconditionally, which is
// exactly where a flipped-up listbox goes.
const CLIPPING = new Set(['hidden', 'auto', 'scroll', 'clip'])
function clipAxes(el) {
  const cs = getComputedStyle(el)
  return ['overflow', 'overflowX', 'overflowY'].filter(k => CLIPPING.has(cs[k]))
}

beforeEach(() => {
  fetchSpy.mockReset()
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

afterEach(() => { vi.unstubAllEnvs() })

function primeMount({ photos = [] } = {}) {
  fetchSpy.mockResolvedValueOnce([PROJECT])    // /api/projects
  fetchSpy.mockResolvedValueOnce([LOCATION])   // /api/locations/with-path
  fetchSpy.mockResolvedValueOnce(photos)       // /api/photos
}

async function mount(opts) {
  primeMount(opts)
  render(<PhotoLibrary />)
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
}

// PlantingSelect opens on focus. focusin (not the non-bubbling `focus`) is what React delegates.
async function openPicker(input) {
  await act(async () => { input.focus() })
  await waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('true'))
}

describe('BUG-PICKERCLIP-001 — PhotoModal must not clip the planting listbox', () => {
  async function openTagModal() {
    await mount({ photos: [PHOTO] })
    fetchSpy.mockResolvedValueOnce([PLANT])   // /api/plants?project_id=proj-1 (modal effect)
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Garden photo/i })[0]) })
    await waitFor(() => expect(document.getElementById('pl-modal-plant')).toBeTruthy())
    return screen.getByTestId('pl-modal-card')
  }

  it('gives the card a scrollable path instead of a hard clip', async () => {
    const card = await openTagModal()
    const cs = getComputedStyle(card)
    // The hard clip named in the ticket is gone...
    expect(cs.overflow).not.toBe('hidden')
    expect(cs.overflowY).not.toBe('hidden')
    // ...but V4-KBVIEWPORT-001's contract survives: "Save tags" is still reachable by scrolling.
    expect(cs.overflowY).toBe('auto')
  })

  it('leaves NO clipping box between the picker input and the card', async () => {
    const card = await openTagModal()
    const input = document.getElementById('pl-modal-plant')
    const offenders = []
    for (let node = input.parentElement; node && node !== card; node = node.parentElement) {
      if (clipAxes(node).length) offenders.push(`${node.dataset.testid ?? node.tagName}:${clipAxes(node)}`)
    }
    expect(offenders).toEqual([])
  })

  it('keeps the photo header pinned, so folding the two boxes into one does not strand Close', async () => {
    const card = await openTagModal()
    const header = within(card).getByText('✕').parentElement
    expect(getComputedStyle(header).position).toBe('sticky')
  })
})

describe('BUG-PICKERCLIP-001 — the z150 selection bar must not cover the upload picker', () => {
  async function selectModeWithUploadForm() {
    vi.stubEnv('VITE_API_FACEBOOK_SHARE', 'https://example.invalid/share')
    await mount({ photos: [PHOTO] })
    fireEvent.click(screen.getByText('Select'))
    fireEvent.click(screen.getAllByRole('button', { name: /Garden photo/i })[0])
    fireEvent.click(screen.getByText('+ Upload'))
    fetchSpy.mockResolvedValueOnce([PLANT])   // /api/plants?project_id=proj-1 (upload effect)
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue(/Select project/i), { target: { value: 'proj-1' } })
    })
    await waitFor(() => expect(document.getElementById('pl-upload-plant')).toBeTruthy())
    return { bar: screen.getByTestId('pl-select-bar'), input: document.getElementById('pl-upload-plant') }
  }

  // Guards the PRECONDITION rather than the fix: if a later change makes select-mode and the upload
  // form mutually exclusive, the suppression below becomes moot and this says so out loud instead of
  // letting the other two tests pass vacuously.
  it('can render the fixed bar and the upload form at the same time', async () => {
    const { bar, input } = await selectModeWithUploadForm()
    expect(getComputedStyle(bar).zIndex).toBe('150')
    expect(getComputedStyle(bar).position).toBe('fixed')
    expect(input).toBeTruthy()
  })

  it('leaves the bar live while the picker is closed', async () => {
    const { bar, input } = await selectModeWithUploadForm()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(getComputedStyle(bar).visibility).toBe('visible')
    expect(getComputedStyle(bar).pointerEvents).toBe('auto')
  })

  it('suppresses the bar — paint AND hit testing — while the picker is open', async () => {
    const { bar, input } = await selectModeWithUploadForm()
    await openPicker(input)
    expect(getComputedStyle(bar).visibility).toBe('hidden')
    expect(getComputedStyle(bar).pointerEvents).toBe('none')
    // Not unmounted: the picker's 150ms deferred blur-close must not flicker it back under a finger.
    expect(screen.getByTestId('pl-select-bar')).toBeTruthy()
  })
})
