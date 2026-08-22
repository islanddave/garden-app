// V4-HARVFORMORDER-001 (S4) — the harvest-scoped form reorder, in the SHIPPED flag configuration
// (PROJECTS_HIDDEN true, as featureFlags.js has it). Pins three things:
//   1. HARVEST leads with Planting -> Quantity -> Unit, and the blocks the harvest fast path never
//      touches (Photo / Notes / Metadata / When) sit under ONE collapsed disclosure.
//   2. EVERY OTHER event type keeps the shipped V4-LOGPHOTOFIRST-001 photo-first order, byte-for-
//      byte — that is the shipped feature this slice is most able to break, so it is asserted per
//      branch, not assumed.
//   3. The reorder is driven by LIVE state, not by what the form mounted as: switching type in
//      either direction re-orders the page.
// The Save button is deliberately NOT part of the order assertions — it is `position: sticky` and
// therefore already pinned to the viewport bottom for every type. jsdom computes NO layout, so the
// plan's real acceptance criterion (Save.getBoundingClientRect().bottom <= innerHeight with the
// keypad open) CANNOT be proven here and is not claimed here. See the S4 handoff.
// No jest-dom (L-182). Harness mirrors EventNew.projhide.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1' }, postError: null },
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
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

// Shipped configuration — spread the real module so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return dataRef.postError ? Promise.reject(dataRef.postError) : Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// True when `a` comes strictly BEFORE `b` in document order. Node.DOCUMENT_POSITION_FOLLOWING (4)
// means "b follows a". Ordering is asserted on the DOM, not on CSS: DOM order is what a screen
// reader and the tab sequence follow, so a reorder implemented with `order:` would (correctly) fail.
function precedes(a, b) {
  expect(a).toBeTruthy()
  expect(b).toBeTruthy()
  return !!(a.compareDocumentPosition(b) & 4)
}

// Section labels in the order they appear in the DOM. <Section> renders <div><label>..</label>..</div>,
// so reading every uppercase section <label> gives the page's actual block sequence.
function sectionOrder(container) {
  return [...container.querySelectorAll('form label')]
    .filter(l => l.style && l.style.textTransform === 'uppercase')
    .map(l => l.textContent.trim())
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }; dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  try { sessionStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('V4-HARVFORMORDER-001 — harvest order', () => {
  it('leads with Planting, then the Harvest panel (Quantity then Unit)', async () => {
    const { container } = renderEventNew('event_type=harvest')
    await flushLoad()

    const order = sectionOrder(container)
    expect(order[0]).toBe('Planting *')
    expect(order[1]).toBe('Harvest *')

    // ...and inside the harvest panel, Quantity precedes Unit.
    const qty = screen.getByLabelText('Harvest quantity')
    const unit = screen.getByLabelText('Harvest unit')
    expect(precedes(qty, unit)).toBe(true)
    // Planting precedes both, in the DOM — not merely visually.
    expect(precedes(screen.getByLabelText('Plant or group'), qty)).toBe(true)
  })

  it('puts Photo, Notes and When under ONE collapsed disclosure — not five', async () => {
    const { container } = renderEventNew('event_type=harvest')
    await flushLoad()

    // Collapsed: none of the deferred controls are in the tree at all.
    expect(screen.queryByLabelText('Notes')).toBe(null)
    expect(screen.queryByLabelText('Event date')).toBe(null)
    expect(screen.queryByText('Choose photo')).toBe(null)

    const toggle = screen.getByTestId('harvest-more-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Exactly one disclosure was added — the harvest panel did not sprout five.
    expect(container.querySelectorAll('[data-testid="harvest-more-toggle"]').length).toBe(1)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    const notes = screen.getByLabelText('Notes')
    const when = screen.getByLabelText('Event date')
    // V4-HIDECAPTURE-001: 'Choose photo' is the photo control's label now — this line only ever
    // used the label as a proxy for "the photo control is inside the disclosure".
    expect(screen.getByText('Choose photo')).toBeTruthy()
    expect(precedes(notes, when)).toBe(true)
    // The whole disclosure sits BELOW the quantity field it was moved out of the way of.
    expect(precedes(screen.getByLabelText('Harvest quantity'), notes)).toBe(true)
  })

  it('keeps the event-type picker rendered (below the harvest panel), not buried in the disclosure', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()

    const whatHappened = screen.getByText('What happened? *')
    expect(precedes(screen.getByLabelText('Harvest quantity'), whatHappened)).toBe(true)
    // It is OUTSIDE the collapsed disclosure body — which is not even mounted yet.
    expect(screen.queryByTestId('harvest-more-body')).toBe(null)
    expect(whatHappened).toBeTruthy()
  })

  it('renders NO Project select at all — PROJECTS_HIDDEN already hides it, S4 adds no second gate', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.queryByLabelText('Project')).toBe(null)
    fireEvent.click(screen.getByTestId('harvest-more-toggle'))
    // Still absent with the disclosure OPEN: it is gated by the flag, not by the disclosure.
    expect(screen.queryByLabelText('Project')).toBe(null)
  })

  it('does not disturb the quantity chips or either unit select', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()

    // V4-HARVQTYCHIPS-001 — all six chips, still above the field, still filling it in one tap.
    for (const q of ['1', '2', '3', '4', '5', '6']) expect(screen.getByTestId(`qty-chip-${q}`)).toBeTruthy()
    expect(precedes(screen.getByTestId('qty-chip-1'), screen.getByLabelText('Harvest quantity'))).toBe(true)
    fireEvent.click(screen.getByTestId('qty-chip-3'))
    expect(screen.getByLabelText('Harvest quantity').value).toBe('3')

    // TWO unit selects survive and stay distinct — /unit/i matches both, so both are named exactly.
    const unit = screen.getByLabelText('Harvest unit')
    const weightUnit = screen.getByLabelText('Harvest weight unit')
    expect(unit).not.toBe(weightUnit)
    expect(screen.getAllByLabelText(/unit/i).length).toBe(2)
    expect(precedes(unit, weightUnit)).toBe(true)
  })
})

describe('V4-HARVFORMORDER-001 — every OTHER type keeps the shipped photo-first order', () => {
  // One case per branch: the shipped V4-LOGPHOTOFIRST-001 order must survive S4 for all of them.
  for (const type of ['watering', 'photo', 'observation', 'transplant', 'pest_treatment']) {
    it(`${type}: Photo leads, and there is no harvest disclosure`, async () => {
      const { container } = renderEventNew(`event_type=${type}`)
      await flushLoad()

      const order = sectionOrder(container)
      // Photo is FIRST — the whole point of V4-LOGPHOTOFIRST-001.
      expect(order[0].startsWith('Photo')).toBe(true)
      expect(order[1]).toBe('What happened? *')
      // Planting -> When, in the shipped sequence. The Planting label is 'Planting *' or 'Planting'
      // depending on requiresPlanting(type), so match on the prefix rather than pinning a
      // requiredness this slice does not own.
      const planting = order.findIndex(l => l.startsWith('Planting'))
      expect(planting).toBeGreaterThan(order.indexOf('What happened? *'))
      expect(order.indexOf('When?')).toBeGreaterThan(planting)
      // V4-NOTESCOLLAPSE-001 — Notes used to sit between 'What happened?' and Planting, as an
      // always-open Section. It is now a collapsed disclosure at the END of the form, so it emits no
      // uppercase Section label at all and follows the When? field in document order.
      expect(order.includes('Notes')).toBe(false)
      const notesToggle = screen.getByTestId('notes-disclosure')
      expect(screen.queryByLabelText('Notes')).toBe(null)
      const when = screen.getByLabelText('Event date')
      expect(when.compareDocumentPosition(notesToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // No Harvest panel, and none of S4's machinery leaks onto this path.
      expect(order.includes('Harvest *')).toBe(false)
      expect(screen.queryByTestId('harvest-more-toggle')).toBe(null)
      // When is DIRECTLY visible, and Notes is one tap away — never unreachable.
      expect(when).toBeTruthy()
      fireEvent.click(notesToggle)
      expect(screen.getByLabelText('Notes')).toBeTruthy()
    })
  }

  it('reorders LIVE when the type changes — harvest -> watering restores photo-first', async () => {
    const { container } = renderEventNew('event_type=harvest')
    await flushLoad()
    expect(sectionOrder(container)[0]).toBe('Planting *')

    // Change type via the picker the user actually taps.
    fireEvent.click(screen.getByText(/Watered/i))

    const after = sectionOrder(container)
    expect(after[0].startsWith('Photo')).toBe(true)
    expect(after.includes('Harvest *')).toBe(false)
    expect(screen.queryByTestId('harvest-more-toggle')).toBe(null)
    // V4-NOTESCOLLAPSE-001: the non-harvest Notes home is its own collapsed disclosure.
    expect(screen.getByTestId('notes-disclosure')).toBeTruthy()
  })

  it('reorders LIVE the other way — watering -> harvest hides Notes behind the disclosure', async () => {
    const { container } = renderEventNew('event_type=watering')
    await flushLoad()
    // Non-harvest: reachable behind the notes disclosure (V4-NOTESCOLLAPSE-001), not open on arrival.
    expect(screen.getByTestId('notes-disclosure')).toBeTruthy()
    fireEvent.click(screen.getByTestId('notes-disclosure'))
    expect(screen.getByLabelText('Notes')).toBeTruthy()

    fireEvent.click(screen.getByText(/Harvested/i))

    expect(sectionOrder(container)[0]).toBe('Planting *')
    expect(screen.queryByLabelText('Notes')).toBe(null)
    expect(screen.getByTestId('harvest-more-toggle')).toBeTruthy()
  })
})
