// PickerSaveCollision.test.jsx — V4-PICKERUX-001 P0.
//
// READ THIS BEFORE ADDING A "THE SAVE BUTTON IS NOT ON TOP" ASSERTION HERE.
//
// The defect is a VISUAL OCCLUSION plus a HIT-TEST theft: a sticky Save painted over rows 2-3 of the
// open listbox and received the taps aimed at them. jsdom has no layout or paint engine —
// getBoundingClientRect returns zeros and stacking contexts are never resolved — so this file
// CANNOT prove the occlusion is gone. Any test claiming to would pass whether or not the bug exists,
// which is the exact shape of the green test that let this ship (PlantingSelect.test.jsx's
// "caps the listbox visibly" certifies a contract the shipped surface breaks).
//
// So this file proves the STRUCTURAL invariant the fix rests on, and nothing more:
//   the Save control is non-interactive for exactly as long as the listbox is open.
// That is the property that makes the wrong-write impossible. Whether the pixels overlap becomes
// irrelevant once nothing under the finger can submit the form.
//
// The visual half needs a real browser (elementFromPoint over each row) and a device pass on
// Android — tracked on V4-PICKERUX-001, NOT claimed here.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'

const PROJECT = { id: 'proj-1', name: 'Herb Plants', status: 'growing' }
const PLANTS = [
  { id: 'pl-1', name: 'Lemon Thyme', project_id: 'proj-1', project_name: 'Herb Plants', variety_ref: { name: 'Lemon Thyme' } },
  { id: 'pl-2', name: 'Lemon Verbena', quantity: 3, project_id: 'proj-1', project_name: 'Herb Plants' },
  { id: 'pl-3', name: 'Sweet Bay Laurel', project_id: 'proj-1', project_name: 'Herb Plants', variety_ref: { name: 'Sweet Bay Laurel' } },
]

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.plants = PLANTS
  try { localStorage.clear() } catch { /* noop */ }
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve({ id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

// V4-KBVIEWPORT-001: `inOverlay` renders the same component inside the real OverlaySurfaceProvider
// rather than mocking the context, so the branch is exercised through the actual mechanism the app
// uses. This file previously only ever rendered the full-page branch.
async function renderForm({ inOverlay = false } = {}) {
  searchParamsRef.current = new URLSearchParams('event_type=watering')
  const tree = <ToastProvider><EventNew /></ToastProvider>
  const utils = render(
    inOverlay ? <OverlaySurfaceProvider>{tree}</OverlaySurfaceProvider> : tree
  )
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  await act(async () => { await Promise.resolve() })
  return utils
}

// V4-KBVIEWPORT-001: query the wrapper by testid, not `closest('div[style*="sticky"]')`. The old
// selector silently re-targeted if any sticky ancestor were introduced between Save and its
// wrapper — and several assertions below would still have PASSED against the wrong node
// (`.style.position` on an outer sticky reads 'sticky' either way). Fragile-selector tripwire on
// this change's own edit site.
const saveWrapper = () => screen.getByTestId('save-sticky')

describe('V4-PICKERUX-001 — Save is inert while the planting listbox is open', () => {
  it('leaves Save interactive when the picker is closed', async () => {
    await renderForm()
    const w = saveWrapper()
    expect(w.style.visibility).toBe('visible')
    expect(w.style.pointerEvents).toBe('auto')
  })

  it('makes Save non-interactive as soon as the listbox opens', async () => {
    await renderForm()
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    await act(async () => { await Promise.resolve() })
    expect(await screen.findByTestId('ps-opt-pl-1')).toBeTruthy()
    const w = saveWrapper()
    expect(w.style.visibility).toBe('hidden')
    expect(w.style.pointerEvents).toBe('none')
  })

  // HONEST LIMIT, recorded rather than papered over. The point of the fix is "Save cannot write
  // while the picker is open" — and that consequence is enforced by the BROWSER's hit-testing of
  // `pointer-events: none`, which jsdom does not implement. A synthetic fireEvent.click here calls
  // the React handler directly and DOES post; an earlier draft of this file asserted zero posts and
  // failed, which is the correct outcome for an assertion jsdom cannot deliver.
  // So this pins the precondition and states what it does not prove. The no-write consequence is
  // verified in a real browser (elementFromPoint over rows 1-3 + a request interceptor) under
  // V4-PICKERUX-001 — not here.
  it('holds the inert state across an attempted click (browser enforces the rest)', async () => {
    await renderForm()
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    expect(await screen.findByTestId('ps-opt-pl-1')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    // The click must not have re-enabled the control as a side effect — the listbox is still open,
    // so Save must still be inert and available to be dropped by the browser on the next tap.
    expect(saveWrapper().style.pointerEvents).toBe('none')
    expect(saveWrapper().style.visibility).toBe('hidden')
  })

  it('restores Save after a planting is chosen', async () => {
    await renderForm()
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    fireEvent.click(await screen.findByTestId('ps-opt-pl-2'))
    await act(async () => { await Promise.resolve() })
    const w = saveWrapper()
    expect(w.style.visibility).toBe('visible')
    expect(w.style.pointerEvents).toBe('auto')
  })

  // Regression guard for the close path that is NOT a selection — the blur timeout. If the host
  // only un-hid on select, dismissing the picker without choosing would strand Save hidden and the
  // form would be permanently unsubmittable.
  it('restores Save when the listbox closes without a selection', async () => {
    await renderForm()
    const input = screen.getByLabelText('Plant or group')
    fireEvent.focus(input)
    expect(await screen.findByTestId('ps-opt-pl-1')).toBeTruthy()
    expect(saveWrapper().style.visibility).toBe('hidden')
    fireEvent.keyDown(input, { key: 'Escape' })
    await act(async () => { await Promise.resolve() })
    expect(saveWrapper().style.visibility).toBe('visible')
  })

  // BUG-SHEET-001 must-not-break: the CTA stays `sticky`. A `fixed` CTA escapes the Sheet's scroll
  // region and repaints over the panel — the class this file's fix must not reopen while moving
  // z-index around.
  it('keeps the Save CTA sticky, never fixed', async () => {
    await renderForm()
    expect(saveWrapper().style.position).toBe('sticky')
  })

  // The backstop: if onOpenChange ever regresses, the listbox must still out-stack Save.
  it('declares a Save z-index below the listbox z-index', async () => {
    await renderForm()
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    const list = await screen.findByRole('listbox')
    expect(Number(saveWrapper().style.zIndex)).toBeLessThan(Number(list.style.zIndex))
  })
})

// V4-KBVIEWPORT-001 — the Save CTA's bottom inset is path-aware, and until now had NO coverage at
// all: no test in the repo asserted `style.bottom` on this wrapper, and this file only ever
// rendered the full-page branch. The declared style value is a structural invariant jsdom CAN
// prove — unlike anything about where the button actually lands, which is the device pass.
describe('V4-KBVIEWPORT-001 — Save clears the nav on the page, nothing in the Sheet', () => {
  it('full page: clears the fixed BottomNav', async () => {
    await renderForm()
    // BOTTOM_NAV_HEIGHT_PX (56) + 12 breathing room. Asserted against the derived expression, not
    // the literal, so a nav-height change cannot silently desync this the way the old magic 68 did.
    expect(saveWrapper().style.bottom).toBe(`${BOTTOM_NAV_HEIGHT_PX + 12}px`)
  })

  it('in the Sheet: no nav clearance, because the Sheet paints over the nav', async () => {
    await renderForm({ inOverlay: true })
    // The sticky container here is the Sheet's own scrollport, and Sheet already reserves
    // calc(12px + env(safe-area-inset-bottom)) at its foot. 68px of nav clearance was dead space at
    // the bottom of a form the keyboard has already shortened.
    expect(saveWrapper().style.bottom).toBe('0px')
  })

  it('the two paths genuinely differ — guards against the branch collapsing to one value', async () => {
    const page = await renderForm()
    const pageBottom = saveWrapper().style.bottom
    page.unmount()
    await renderForm({ inOverlay: true })
    expect(saveWrapper().style.bottom).not.toBe(pageBottom)
  })
})

describe('V4-PICKERUX-001 — label noise reductions', () => {
  it('drops the variety clause when it merely repeats the planting name', async () => {
    await renderForm()
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    const opt = await screen.findByTestId('ps-opt-pl-1')
    expect(opt.textContent).toContain('Lemon Thyme')
    expect(opt.textContent).not.toContain('Lemon Thyme — Lemon Thyme')
  })

  it('hides the project tag when every visible row shares one project', async () => {
    await renderForm()
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    const opt = await screen.findByTestId('ps-opt-pl-2')
    expect(opt.textContent).toContain('Lemon Verbena')
    expect(opt.textContent).not.toContain('Herb Plants')
  })
})
