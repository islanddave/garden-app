// POI-SEEDDOORMENU-001 — the two things the pre-promote pass found the seed door had no cover for.
//
// Both were filed IMPORTANT on 2026-09-02 against the v4.94.0→v4.95.0 diff and both are fixed here
// rather than accepted. They sit in one file because they share a cause: the menu door put a Sheet
// somewhere a Sheet had never been, on the app's most-tapped route.
//
// IMP-1 — A STALE DRAFT AUTO-OPENED THE SHEET. `DRAFT_FORM_FIELDS` carries `event_type` AND
// `plant_id`; PROJECTS_HIDDEN makes `plantsForProject` the unscoped list so a restored plant_id
// always resolves; and SaveSeedSheet's save path navigates to /inventory/:id without clearing the
// stash (only handleSubmit calls clearDraft). So after ONE trip through the menu door, every later
// bare "Log an event" tap re-derived seedSaveTarget and opened the Save-seed sheet with no user
// action. No data loss and one-tap recovery, but on the surface Dave waters and harvests from, in an
// installed PWA whose session outlives the day. The fix drops ONLY the type from a restore, so a
// half-typed note and the chosen planting still come back.
//
// IMP-2 — SHEET INSIDE A SHEET, UNCOVERED. `/log` is `overlayable: true`, so EventNew renders inside
// an OverlayHost <Sheet>; SaveSeedSheet is itself a <Sheet>. That configuration did not exist before
// this diff — the pre-existing door renders from PlantingDetail, which is not overlayable — and of
// the 34 EventNew test files none rendered this page inside an OverlayHost with a sheet open. The
// mechanism was read and found sound (refcounted scroll lock, seq tie-break in resolveTopmost); what
// was missing was any test that would notice it breaking. Green here proves the arbitration, not the
// author's reading of it.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, getTokenSpy, navigateSpy, searchParamsRef, identity } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
  navigateSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  identity: { current: { user: { id: 'sub-A' }, profile: null, loading: false } },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => identity.current,
  useAuth: () => identity.current,
}))

import EventNew from '../pages/EventNew.jsx'
import { OverlayHost } from '../App.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { writeDraft, readDraft, clearDraft } from '../lib/draftStash.js'
import * as cache from '../lib/dataCache.js'

const DRAFT_KEY = 'logone'
const TOMATO = {
  id: 'pl-1', name: 'Brandywine — bed 3', project_id: 'proj-1', project_name: 'Tomatoes',
  variety_ref: { id: 'var-brandy', name: 'Brandywine' },
}

function prime() {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    const u = String(url)
    if (opts.method === 'POST' && u === '/api/inventory-items') return Promise.resolve({ id: 'lot-1' })
    if (opts.method === 'POST') return Promise.resolve({ id: 'evt-1' })
    if (u === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Tomatoes', status: 'growing' }])
    if (u === '/api/locations/with-path') return Promise.resolve([])
    if (u.startsWith('/api/plants')) return Promise.resolve([TOMATO])
    return Promise.resolve(null)
  })
}

// A BARE mount — no search params at all. That is the state the defect needed: the restore effect
// refuses to run when any seed param is present, so a test that passed ?event_type=… would prove
// nothing about the draft path.
async function renderBare() {
  searchParamsRef.current = new URLSearchParams()
  const out = await act(async () => render(<ToastProvider><EventNew /></ToastProvider>))
  await act(async () => { await Promise.resolve() })
  return out
}

async function renderInOverlay(qs) {
  searchParamsRef.current = new URLSearchParams(qs)
  const out = await act(async () => render(
    <DismissRegistryProvider>
      <ToastProvider>
        <OverlayHost ariaLabel="Log an event"><EventNew /></OverlayHost>
      </ToastProvider>
    </DismissRegistryProvider>,
  ))
  await act(async () => { await Promise.resolve() })
  return out
}

beforeEach(() => {
  try { sessionStorage.clear() } catch { /* noop */ }
  try { localStorage.clear() } catch { /* noop */ }
  cache.__resetDataCache()
  clearDraft(DRAFT_KEY)
  identity.current = { user: { id: 'sub-A' }, profile: null, loading: false }
  navigateSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  document.body.style.overflow = ''
})

describe('IMP-1 — a stale seed_saved draft must not open the sheet by itself', () => {
  // The EXACT stash the menu door leaves behind after a successful save, printed verbatim from
  // sessionStorage during the pre-promote probe. An invented draft would not reproduce the bug.
  const staleDraft = {
    form: { event_type: 'seed_saved', plant_id: 'pl-1', notes: 'half-typed note', event_date: '2026-09-02' },
  }

  it('a bare Log tap with that draft does NOT open the Save-seed sheet', async () => {
    prime()
    writeDraft(DRAFT_KEY, staleDraft)
    await renderBare()
    expect(screen.queryByTestId('save-seed-submit'), 'the sheet opened with no user action').toBeNull()
  })

  it('but the rest of the draft still comes back — only the TYPE is dropped', async () => {
    // The fix must not degrade into "throw the draft away". The stash exists so a dismissed form
    // resumes; losing a typed note to fix an unrelated auto-open would trade one defect for another.
    prime()
    writeDraft(DRAFT_KEY, staleDraft)
    await renderBare()
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/half-typed note/)
    })
  })

  it('an ordinary draft is untouched — the refusal is scoped to one type', async () => {
    prime()
    writeDraft(DRAFT_KEY, { form: { event_type: 'watering', plant_id: 'pl-1', notes: 'watered deeply' } })
    await renderBare()
    await waitFor(() => expect(document.body.textContent).toMatch(/watered deeply/))
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
  })

  it('an EXPLICIT seed_saved param still opens it — this is a draft rule, not a kill switch', async () => {
    // The guard must not break the door it protects. A param-seeded mount skips the restore effect
    // entirely, so the deliberate route is unaffected.
    prime()
    writeDraft(DRAFT_KEY, staleDraft)
    searchParamsRef.current = new URLSearchParams('event_type=seed_saved&plant=pl-1&project=proj-1')
    await act(async () => { render(<ToastProvider><EventNew /></ToastProvider>) })
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
  })
})

describe('IMP-2 — Sheet inside a Sheet: /log is overlayable and the seed door is a sheet', () => {
  it('renders both layers without either one erroring', async () => {
    prime()
    await renderInOverlay('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    // Two sheets, one stack. If the inner sheet failed to mount inside the overlay, the assertion
    // above is what breaks — this one pins that the OUTER one is still there too.
    expect(screen.getAllByTestId('save-seed-submit')).toHaveLength(1)
  })

  it('the body scroll lock survives closing the INNER sheet — it is refcounted, not a boolean', async () => {
    // The failure this guards is a nested unlock: the inner sheet unmounting and restoring
    // `overflow` while the outer overlay is still open, letting the page behind an open overlay
    // scroll. Sheet.jsx no-ops the unlock above stack depth 0; nothing tested that with a real
    // second layer.
    prime()
    await renderInOverlay('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    expect(document.body.style.overflow).toBe('hidden')

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })

    // One Escape closes ONE sheet: the inner one goes, the overlay stays, and the lock holds.
    await waitFor(() => expect(screen.queryByTestId('save-seed-submit')).toBeNull())
    expect(document.body.style.overflow, 'the page behind the overlay became scrollable').toBe('hidden')
  })

  it('closing the seed sheet leaves the user on the chooser, not behind a dead overlay', async () => {
    prime()
    await renderInOverlay('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await waitFor(() => expect(screen.queryByTestId('save-seed-submit')).toBeNull())
    // onClose clears the type, so the ordinary form is back and reachable rather than a blank shell.
    expect(document.body.textContent).toMatch(/More event types/)
  })

  it('opening the sheet writes NOTHING on its own', async () => {
    // The sheet is a form, not an action. A render that POSTed would turn an accidental open (IMP-1)
    // from a surprise into a fabricated lot.
    prime()
    await renderInOverlay('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    expect(fetchSpy.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0)
  })
})
