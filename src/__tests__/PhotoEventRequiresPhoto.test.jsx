// PhotoEventRequiresPhoto.test.jsx — BUG-SNAPATTACH-001.
//
// PROVENANCE, because the filed premise was wrong and the fix is not what the report asked for.
// BD-009 reported "Snap gallery photo saves the event but never attaches the photo", on Tendersweet
// carrots. Checked against live Neon: that photo DID attach — it carries BOTH event_id and the exact
// plant_id. The repro is falsified.
//
// What IS real, found by generalising instead of stopping there: 22 of 582 photo-typed events in
// prod carry zero photos, and there are no orphaned photo ROWS to match them. So nothing failed
// mid-upload — no upload was ever attempted. Two routes reach that state:
//   1. "📷 Photo" is a first-class option in EventTypePicker, so it can be chosen and saved with
//      nothing attached; and
//   2. the V4-PHOTOQUICK-001 park/claim seam hands a File through module state that is cleared on
//      read, so a remount in transit consumes it and the form arrives photo-typed but empty.
// Both end identically: a permanent empty event, a "✓ Logged" confirmation, and nothing to recover.
//
// One gate closes both, which is why the fix is a submit guard rather than a repair to either route.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, searchParamsRef, pendingRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  searchParamsRef: { current: new URLSearchParams() },
  pendingRef: { current: null },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
// Mirror the real module's take-once semantics: the claim CLEARS the park. That is the property
// that makes a double mount lose the file, so a mock that returned it twice would hide the bug.
vi.mock('../lib/pendingCapture.js', () => ({
  setPendingCapture: f => { pendingRef.current = f || null },
  takePendingCapture: () => { const f = pendingRef.current; pendingRef.current = null; return f },
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
// V4-PLANTREQUIRED-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip
// and its assertions describe the planting-OPTIONAL behavior, which remains a live configuration
// (rollback = one-line revert). Mocked FALSE so every assertion below keeps covering what it was
// written to cover, rather than being rewritten to the flag-ON world. Flag-ON is covered by
// EventNew.plantRequired.test.jsx and EventNew.plantMismatch.plantRequired.test.jsx.
// importActual spread so every other flag (OVERLAY_ROUTES_ENABLED etc.) keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PLANTING_REQUIRED_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Herb Plants', status: 'growing' }

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  pendingRef.current = null
  // jsdom implements neither; the component builds a preview URL on every photo pick. Environment
  // gap, not product behavior — stub rather than route around it, or the attached-photo path (the
  // one that must still SAVE) can't be exercised at all.
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
  searchParamsRef.current = new URLSearchParams()
  try { localStorage.clear() } catch { /* noop */ }
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve({ id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

async function renderForm(query) {
  searchParamsRef.current = new URLSearchParams(query)
  const utils = render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  return utils
}

describe('BUG-SNAPATTACH-001 — a photo event must carry a photo', () => {
  it('refuses to save a photo event with nothing attached', async () => {
    await renderForm('event_type=photo&project=proj-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/Add a photo for a photo event/i)).toBeTruthy()
  })

  // The guard must be type-scoped. Every other event type is legitimately photo-less — a gate that
  // caught watering would be a far worse bug than the one it fixes.
  it('does not block other event types that have no photo', async () => {
    await renderForm('event_type=watering&project=proj-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('watering')
  })

  it('lets a photo event through once a photo is attached', async () => {
    await renderForm('event_type=photo&project=proj-1')
    const input = document.querySelector('input[type="file"]')
    expect(input).toBeTruthy()
    const file = new File(['x'], 'shot.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('photo')
    expect(postCalls[0].has_photo).toBe(true)
  })
})

describe('BUG-SNAPATTACH-001 — the quick-photo claim announces a miss', () => {
  it('says so when the parked file is gone by the time the form mounts', async () => {
    // Park nothing: the exact state a remount-in-transit leaves behind.
    await renderForm('event_type=photo&plant=pl-1&project=proj-1&fromquick=1')
    expect(await screen.findByText(/didn’t carry over/i)).toBeTruthy()
  })

  it('stays quiet when the file arrives intact', async () => {
    pendingRef.current = new File(['x'], 'parked.jpg', { type: 'image/jpeg' })
    await renderForm('event_type=photo&plant=pl-1&project=proj-1&fromquick=1')
    expect(screen.queryByText(/didn’t carry over/i)).toBeNull()
  })

  // The two halves compose: a dropped file must not become a saveable empty photo event.
  it('a dropped quick-photo cannot be saved as an empty photo event', async () => {
    await renderForm('event_type=photo&plant=pl-1&project=proj-1&fromquick=1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(0)
  })
})
