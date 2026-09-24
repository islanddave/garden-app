// BUG-INVREFSTRAND-001 (option C) — Snap's inventory Undo keeps working under the delete guard, and a
// failed Undo says so.
//
// The inventory destination creates the item, ATTACHES THE CAPTURED PHOTO to it, and only then offers
// Undo = DELETE /api/inventory-items/:id. The Sept-8 guard counted the item's own photos, so that Undo
// would have been refused every single time. Option C blocks only on something sown or applied from
// the item, so the server answers 200 here — lambda/inventory-items/delete-reference-guard.test.js
// proves that half through the real handler. This file proves the client half at the level that can
// fail:
//   • Undo sends exactly that DELETE, AFTER the photo was attached to the item, and on success the card
//     reads "Undone" with Undo and the item link withdrawn;
//   • if the DELETE ever fails, the done card SAYS SO (role="alert") and keeps Undo — before this, doUndo
//     set `err` but the done step never rendered it, so a failed Undo was silent.
// Mounting follows CaptureFlow.postSaveLink.test.jsx (same api / upload / router doubles). No jest-dom
// (L-182).
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

const ITEM_ID = 'inv-new'
const deleteCalls = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'DELETE')

let deleteResult
beforeEach(() => {
  try { sessionStorage.clear() } catch { /* noop */ }
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  deleteResult = () => Promise.resolve({ ok: true })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve([])
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve([])
    if (m === 'POST' && path === '/api/inventory-items') return Promise.resolve({ id: ITEM_ID, name: 'Fish emulsion' })
    if (m === 'DELETE' && path === `/api/inventory-items/${ITEM_ID}`) return deleteResult()
    return Promise.resolve({ ok: true })
  })
})

async function saveInventoryCapture() {
  await act(async () => { render(<CaptureFlow />) })
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId('mode-inventory')) })
  await act(async () => { fireEvent.change(screen.getByTestId('cap-invname'), { target: { value: 'Fish emulsion' } }) })
  await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
  await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
}

describe('Snap › inventory — Undo under the delete guard', () => {
  it('the captured photo is attached to the item BEFORE Undo is offered — the case the guard must not refuse', async () => {
    await saveInventoryCapture()
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0][1]).toMatchObject({ linkage: { inventory_item_id: ITEM_ID }, parentId: ITEM_ID })
    expect(screen.getByTestId('cap-undo')).toBeDefined()
  })

  it('Undo sends DELETE /api/inventory-items/:id and, on 200, the card reads Undone with Undo and the link withdrawn', async () => {
    await saveInventoryCapture()
    await act(async () => { fireEvent.click(screen.getByTestId('cap-undo')) })
    await waitFor(() => expect(screen.getByTestId('cap-result').textContent).toContain('Undone'))
    expect(deleteCalls().map(([p]) => p)).toEqual([`/api/inventory-items/${ITEM_ID}`])
    expect(document.querySelector('[data-testid="cap-undo"]')).toBeNull()
    expect(document.querySelector('[data-testid="cap-view"]')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a FAILED Undo is shown on the done card, and Undo stays so it can be tried again', async () => {
    const sentence = 'This item can\'t be removed: it was used in 1 logged treatment. To mark it used up, set its Status to "depleted" instead.'
    deleteResult = () => Promise.reject(new Error(sentence))
    await saveInventoryCapture()
    await act(async () => { fireEvent.click(screen.getByTestId('cap-undo')) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(sentence)
    // On the done card, where the Undo tap was — not somewhere the done step never renders.
    const card = screen.getByTestId('cap-result').parentElement
    expect(card.contains(alert)).toBe(true)
    expect(screen.getByTestId('cap-result').textContent).not.toContain('Undone')
    expect(screen.getByTestId('cap-undo')).toBeDefined()
    // …and a retry that succeeds clears it.
    deleteResult = () => Promise.resolve({ ok: true })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-undo')) })
    await waitFor(() => expect(screen.getByTestId('cap-result').textContent).toContain('Undone'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
