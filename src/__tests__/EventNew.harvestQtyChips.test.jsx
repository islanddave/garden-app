// V4-QUICKHITRANGE-001 (BD-047) — harvest quantity digit PAD. Supersedes V4-HARVQTYCHIPS-001's
// 1-6 quick-pick chips.
//
// ⚠️ THIS FILE DELIBERATELY BREAKS A PINNED ORACLE. It previously pinned REPLACE semantics — a
// chip SET the quantity, and selection was reflected via aria-pressed. Both are gone on purpose:
// under build semantics no single key is "the" value after 1,3, so aria-pressed would be a lie,
// and the 1-6 set is superseded by ten digits. The assertions that still hold are kept verbatim
// rather than rewritten, so the diff shows exactly what changed and what did not.
//
// WHAT SURVIVED, and why it matters: the single-digit fast path still costs ONE tap. 83.2% of the
// 519 prod harvest_log rows are integers 1-6 and 87.1% are a single character, so if that path had
// regressed the pad would be a net loss regardless of how well it handles the tail.
//
// jsdom has NO layout engine and no soft keyboard, so this file CANNOT prove the keyboard win or
// the fold position — the last two defects on this exact surface were invisible to 148 passing
// tests and fell out immediately on a 390px render. Those claims need an on-device or harness
// artifact and are deliberately NOT asserted here. What this file pins is the state machine.
//
// Flag note: PLANTING_REQUIRED_ENABLED is TRUE in source as of 2026-08-10, and `harvest` is a
// plant-predicated type — so every save here picks a planting first. That is the real prod path.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1' } },
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

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (String(path).startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = 'event_type=harvest&project=proj-1') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

async function pickPlanting(id = 'plant-1') {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

const qtyField = () => screen.getByLabelText('Harvest quantity')

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — harvest quantity pad (V4-QUICKHITRANGE-001)', () => {
  it('renders ten digits plus . and ⌫, digits in keypad order', async () => {
    renderEventNew(); await flushLoad()
    const group = screen.getByRole('group', { name: 'Harvest quantity quick pick' })
    const labels = Array.from(group.querySelectorAll('button')).map(b => b.textContent)
    // Ten keys cover every value, which is what retired BD-047's "extend the range to 20" ask.
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.', '⌫'])
  })

  it('ONE tap sets the quantity — no typing into the field', async () => {
    // UNCHANGED from the chip era. This is the assertion that proves the pad did not tax the
    // 83.2% fast path to serve the tail.
    renderEventNew(); await flushLoad()
    expect(qtyField().value).toBe('')
    fireEvent.click(screen.getByTestId('qty-chip-3'))
    expect(qtyField().value).toBe('3')
  })

  it('BUILDS a two-digit value — 1 then 3 is 13, which is the whole point', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-1'))
    fireEvent.click(screen.getByTestId('qty-chip-3'))
    // Under the outgoing chips this same sequence produced '3' and 13 needed the keyboard.
    expect(qtyField().value).toBe('13')
  })

  it('⌫ undoes a mis-tap — without it, build semantics are worse than the chips were', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-1'))
    fireEvent.click(screen.getByTestId('qty-chip-7'))
    expect(qtyField().value).toBe('17')
    fireEvent.click(screen.getByTestId('qty-chip-back'))
    expect(qtyField().value).toBe('1')
  })

  it('the . key builds a decimal and then disables itself', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-2'))
    fireEvent.click(screen.getByTestId('qty-chip-dot'))
    fireEvent.click(screen.getByTestId('qty-chip-5'))
    expect(qtyField().value).toBe('2.5')
    // A second . would make Number() return NaN, and validateHarvest() would reject the whole
    // entry with a generic message long after the keypress that caused it.
    expect(screen.getByTestId('qty-chip-dot').disabled).toBe(true)
  })

  it('carries NO aria-pressed — the keys append, they do not select', async () => {
    // The deliberate inversion of the old oracle. aria-pressed on a keypad tells a screen-reader
    // user the key is a toggle in an on state, which is false and actively misleading.
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-2'))
    expect(screen.getByTestId('qty-chip-2').getAttribute('aria-pressed')).toBeNull()
    expect(screen.getByTestId('qty-chip-5').getAttribute('aria-pressed')).toBeNull()
  })

  it('a pad-built quantity reaches the POST body as a number', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.click(screen.getByTestId('qty-chip-1'))
    fireEvent.click(screen.getByTestId('qty-chip-4'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].harvest.quantity).toBe(14)
  })

  it('the free-text field is UNTOUCHED — the tail still types a decimal and posts it', async () => {
    // The anti-regression assertion, kept verbatim. The pad is an addition; if a future change
    // hides the field behind a "More" affordance, this REDs and the tail's cost must be re-argued.
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.change(qtyField(), { target: { value: '2.5' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].harvest.quantity).toBe(2.5)
  })

  it('typing a tail value after a pad tap overrides it', async () => {
    renderEventNew(); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-6'))
    fireEvent.change(qtyField(), { target: { value: '12' } })
    expect(qtyField().value).toBe('12')
    // And the pad picks up from the typed value rather than resetting it.
    fireEvent.click(screen.getByTestId('qty-chip-5'))
    expect(qtyField().value).toBe('125')
  })

  it('a pad tap clears a standing harvest validation error', async () => {
    renderEventNew(); await flushLoad()
    await pickPlanting()
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/Enter a quantity greater than zero/i)).toBeTruthy()
    fireEvent.click(screen.getByTestId('qty-chip-1'))
    expect(screen.queryByText(/Enter a quantity greater than zero/i)).toBeNull()
  })

  it('the pad does not render for a non-harvest event type', async () => {
    renderEventNew('event_type=watering&project=proj-1'); await flushLoad()
    expect(screen.queryByRole('group', { name: 'Harvest quantity quick pick' })).toBeNull()
  })

  it('outside the weigh-in session the field keeps its keyboard and shows no Next button', async () => {
    // The non-session harvest path must stay byte-identical in behaviour: inputMode=decimal, and
    // no on-screen advance button competing with the Enter key that still works there.
    renderEventNew(); await flushLoad()
    expect(qtyField().getAttribute('inputmode')).toBe('decimal')
    expect(screen.queryByTestId('qty-chip-primary')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Harvest weight keypad' })).toBeNull()
  })
})

describe('EventNew — weigh-in session pads (V4-WEIGHKBDNEXT-001)', () => {
  const SESSION = 'session=harvest&event_type=harvest&project=proj-1'

  it('suppresses the keyboard on BOTH fields and mounts the weight pad', async () => {
    renderEventNew(SESSION); await flushLoad()
    expect(qtyField().getAttribute('inputmode')).toBe('none')
    expect(screen.getByLabelText('Harvest weight').getAttribute('inputmode')).toBe('none')
    expect(screen.getByRole('group', { name: 'Harvest weight keypad' })).toBeTruthy()
  })

  it('the quantity pad gains a Next button that moves focus to weight', async () => {
    // With inputMode=none the Enter key no longer exists, so this button is the ONLY remaining
    // path from quantity to weight. If it regresses, the session loop is stranded.
    renderEventNew(SESSION); await flushLoad()
    fireEvent.click(screen.getByTestId('qty-chip-2'))
    fireEvent.click(screen.getByTestId('qty-chip-primary'))
    expect(document.activeElement).toBe(screen.getByLabelText('Harvest weight'))
  })

  it('the weight pad builds grams and the existing sticky Save posts the whole entry', async () => {
    renderEventNew(SESSION); await flushLoad()
    await pickPlanting()
    fireEvent.click(screen.getByTestId('qty-chip-3'))
    for (const d of ['3', '3', '7']) fireEvent.click(screen.getByTestId(`wt-key-${d}`))
    expect(screen.getByLabelText('Harvest weight').value).toBe('337')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].harvest.quantity).toBe(3)
    expect(postCalls[0].harvest.weight).toBe(337)
  })

  it('the weight pad carries NO Save of its own — the sticky Save band already does that job', async () => {
    // Regression guard with teeth: adding one here made getByText('Save') ambiguous and took out
    // 18 tests across EventNew.sessionDraftRestore. It is also the BD-036b defect (two controls,
    // one job) reintroduced one screen over. Exactly one control on this surface says "Save".
    renderEventNew(SESSION); await flushLoad()
    expect(screen.queryByTestId('wt-key-primary')).toBeNull()
    expect(screen.getAllByText('Save')).toHaveLength(1)
  })
})

// V4-WEIGHMOBILEVIEWPORT-001 — BOTH PADS BELOW THEIR FIELDS.
//
// DOM structure, not layout, so jsdom is a legitimate oracle here — unlike everything the header of
// this file disclaims. The panel shipped with two grammars for one control type: the quantity pad
// above its field (it inherited the slot V4-HARVQTYCHIPS-001's chip row vacated) and the weight pad
// below its own. Nothing at either render site ever argued for a position. The measured half of this
// change lives in tests/harness — see the comment at the quantity pad's render site for the 390x500
// before/after coordinates and the elementFromPoint results. What is pinned here is the ORDER, so a
// future edit cannot quietly restore the asymmetry.
const SESSION_Q = 'session=harvest&event_type=harvest&project=proj-1'

function orderOf(...els) {
  // compareDocumentPosition rather than any coordinate: jsdom has no layout engine, and a rect-based
  // assertion here would be a guard that cannot fail (every rect is zero).
  for (let i = 0; i < els.length - 1; i++) {
    const rel = els[i].compareDocumentPosition(els[i + 1])
    if (!(rel & Node.DOCUMENT_POSITION_FOLLOWING)) return false
  }
  return true
}

describe('EventNew — pad position is uniform: each pad follows its own field', () => {
  it('the quantity pad renders AFTER the quantity field, not before it', async () => {
    renderEventNew(); await flushLoad()
    const field = screen.getByLabelText('Harvest quantity')
    const pad = screen.getByRole('group', { name: 'Harvest quantity quick pick' })
    expect(orderOf(field, pad)).toBe(true)
  })

  it('puts the quantity pad BETWEEN the two fields it bridges', async () => {
    // The sequence argument, pinned: `Next →` advances downward to #harvest-weight, so the pad that
    // carries it must sit between the field it leaves and the field it targets. Above the quantity
    // field it was above BOTH, and the gesture pointed the opposite way to the control.
    renderEventNew(SESSION_Q); await flushLoad()
    expect(orderOf(
      screen.getByLabelText('Harvest quantity'),
      screen.getByRole('group', { name: 'Harvest quantity quick pick' }),
      screen.getByLabelText('Harvest weight'),
    )).toBe(true)
  })

  it('gives both pads the same grammar — field, then its pad', async () => {
    renderEventNew(SESSION_Q); await flushLoad()
    expect(orderOf(
      screen.getByLabelText('Harvest quantity'),
      screen.getByRole('group', { name: 'Harvest quantity quick pick' }),
      screen.getByLabelText('Harvest weight'),
      screen.getByRole('group', { name: 'Harvest weight keypad' }),
    )).toBe(true)
  })

  it('keeps the 8px above the moved pad that makes this a PURE reorder', async () => {
    // Not cosmetic and not a style-snapshot for its own sake. NumberPad carries marginBottom:8;
    // below the field that margin COLLAPSES into the weight group's marginTop:14 (block flow), so
    // the naive move shortened the panel 8px and lifted everything under it. MEASURED consequence
    // at 390x500: the weight pad's bottom row rose into the sticky Save band and elementFromPoint
    // returned the BAND instead of the key — the exact failure mode NumberPad.jsx's 6-vs-5 column
    // note records. With this spacer, the harness reports the weight input and Save on
    // byte-identical coordinates before and after. Delete it and the occlusion comes back silently,
    // because no jsdom test can see it.
    renderEventNew(SESSION_Q); await flushLoad()
    const pad = screen.getByRole('group', { name: 'Harvest quantity quick pick' })
    expect(pad.parentElement.style.marginTop).toBe('8px')
  })
})
