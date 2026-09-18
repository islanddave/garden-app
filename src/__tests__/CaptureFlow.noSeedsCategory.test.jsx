// V5-SEEDSTAB-001 — Snap's "Add inventory" no longer offers Seeds.
//
// WHY IT LEFT. That destination has no variety field, and a seed row must name one:
// chk_inventory_seed_requires_variety, which validateCreate enforces first — so every Seeds save
// from here was a 400 (BUG-SNAPSEEDNOVARIETY-001). Seed is added from Seeds › My seeds, where the
// form asks for the variety. Two halves are pinned:
//   • the Category select offers every consumable category EXCEPT Seeds (and still offers the rest);
//   • a draft stashed as Seeds before the option left restores as the default, rather than as a value
//     the select no longer offers and the save would still send.
// Mounting follows CaptureFlow.postSaveLink.test.jsx (same api / upload / router doubles). No
// jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { fetchSpy, uploadSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), uploadSpy: vi.fn(), navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'
import { INVENTORY_CATEGORIES } from '../lib/inventoryEnums.js'
import { writeDraft } from '../lib/draftStash.js'

beforeEach(() => {
  try { sessionStorage.clear() } catch { /* noop */ }
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve([])
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve([])
    if (m === 'POST' && path === '/api/inventory-items') return Promise.resolve({ id: 'inv-new', name: 'Twine' })
    return Promise.resolve({ ok: true })
  })
})

async function openInventoryDestination() {
  await act(async () => { render(<CaptureFlow />) })
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId('mode-inventory')) })
}

const categorySelect = () => screen.getByLabelText('Category')
const optionValues = (sel) => Array.from(sel.options).map(o => o.value)
const inventoryPosts = () => fetchSpy.mock.calls.filter(([p, o]) => p === '/api/inventory-items' && o?.method === 'POST')

describe('Snap › Add inventory — no Seeds category', () => {
  it('the consumable Category options contain no seeds option, and every other consumable category', async () => {
    await openInventoryDestination()
    expect(screen.getByLabelText('Type').value).toBe('consumable')
    const values = optionValues(categorySelect())
    expect(values).not.toContain('seeds')
    expect(Array.from(categorySelect().options).map(o => o.textContent)).not.toContain('Seeds')
    // The positive half: only Seeds left. A select that had lost its whole list would pass the two
    // negatives above.
    const expected = INVENTORY_CATEGORIES
      .filter(c => c.types.includes('consumable') && c.v !== 'seeds')
      .map(c => c.v)
    expect(expected.length).toBeGreaterThan(0)
    expect(values).toEqual(expected)
    expect(categorySelect().value).toBe('other')
  })

  it('a draft stashed as Seeds restores as the default, and the save sends the default', async () => {
    // Stashed by a build that still offered Seeds. Restored verbatim, the select would show an option
    // it no longer has while the save still sent 'seeds' — the 400 this change exists to remove.
    writeDraft('snap', { invName: 'Tomato seed packet', invCat: 'seeds' })
    await openInventoryDestination()
    // The draft really was read: its name came back.
    expect(screen.getByTestId('cap-invname').value).toBe('Tomato seed packet')
    expect(categorySelect().value).toBe('other')
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(inventoryPosts()).toHaveLength(1))
    expect(JSON.parse(inventoryPosts()[0][1].body).category).toBe('other')
  })

  it('any other stashed category still restores — the fallback is for Seeds only', async () => {
    // The control for the case above: without it, a restore that dropped EVERY category would pass.
    writeDraft('snap', { invName: 'Fish emulsion', invCat: 'fertilizer' })
    await openInventoryDestination()
    expect(categorySelect().value).toBe('fertilizer')
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(inventoryPosts()).toHaveLength(1))
    expect(JSON.parse(inventoryPosts()[0][1].body).category).toBe('fertilizer')
  })
})
