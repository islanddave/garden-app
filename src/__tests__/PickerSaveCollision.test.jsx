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

async function renderForm() {
  searchParamsRef.current = new URLSearchParams('event_type=watering')
  const utils = render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  await act(async () => { await Promise.resolve() })
  return utils
}

const saveWrapper = () => screen.getByText('Save').closest('div[style*="sticky"]')

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
