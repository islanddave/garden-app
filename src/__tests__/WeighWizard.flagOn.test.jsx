// WeighWizard.flagOn.test.jsx — V4-WEIGHWIZARDFLOW-001 (BD-055) Slice 1, the ON arm.
//
// Two jobs, deliberately in one file.
//
// 1. THE SHIPPED-VALUE PIN. Read via importActual, so the pin on WEIGH_WIZARD_ENABLED lives exactly
//    once in the suite and its counterpart WeighWizard.flagOff.test.jsx does not break on a future
//    flip. Same idiom as HarvestQuality.flagOn / SpacePhotos.flagOn.
//
// 2. THE CONFIRM PATH, PROVED NON-VACUOUSLY. c0507f3's own message records how this exact wiring
//    failed last time: `confirmOnDirty` was false at both call sites AND the CONFIRM action had no
//    consumer branch, so flipping the booleans would have changed nothing on any surface while the
//    pure-decider tests stayed green — "a silent no-fix, the worst failure mode available because
//    it is indistinguishable from success." So this file does not assert that the props are passed.
//    It renders inside a real DismissRegistryProvider, dismisses, and asserts the ConfirmSheet is
//    on screen — and the dirty=false case asserts it is NOT, which is what makes the dirty=true
//    case capable of failing.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  WEIGH_WIZARD_ENABLED: true,
}))

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [] },
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
import WeighWizard from '../components/WeighWizard.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANTS = [
  { id: 'plant-1', name: 'Sungold', project_id: 'proj-1', quantity: 3, crop_type_slug: 'tomato' },
  { id: 'plant-2', name: 'Cayenne #1', project_id: 'proj-1', quantity: 2, crop_type_slug: 'pepper' },
]

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  localStorage.clear()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = PLANTS
  searchParamsRef.current = new URLSearchParams('session=harvest')
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve({ id: `evt-${postCalls.length}`, updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

async function renderSession(query = 'session=harvest') {
  searchParamsRef.current = new URLSearchParams(query)
  const view = render(
    <DismissRegistryProvider><ToastProvider><EventNew /></ToastProvider></DismissRegistryProvider>
  )
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  return view
}

describe('WEIGH_WIZARD_ENABLED — the shipped value', () => {
  it('is OFF in source: Dave has not seen the design', async () => {
    const actual = await vi.importActual('../lib/featureFlags.js')
    expect(actual.WEIGH_WIZARD_ENABLED).toBe(false)
  })
})

describe('WEIGH_WIZARD_ENABLED=true — step 1', () => {
  it('opens the chooser at mount, with no landing screen', async () => {
    await renderSession()
    // Dave's first beat verbatim: "enter a weigh session -> IMMEDIATELY prompted with the planting
    // chooser (no landing screen)". No tap between mount and the list.
    expect(screen.getByTestId('weigh-wizard')).toBeTruthy()
    expect(screen.getByTestId('weigh-wizard-opt-plant-1')).toBeTruthy()
  })

  it('does NOT open outside the weigh-in session', async () => {
    await renderSession('event_type=harvest')
    expect(screen.queryByTestId('weigh-wizard')).toBeNull()
  })

  it('picking a planting sets plant_id, closes the wizard, and hands off to the form', async () => {
    await renderSession()
    await act(async () => { fireEvent.click(screen.getByTestId('weigh-wizard-opt-plant-1')) })
    expect(screen.queryByTestId('weigh-wizard')).toBeNull()
    // The hand-off is only real if the value landed: save and read the POST body rather than
    // trusting a rendered label.
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.at(-1).plant_id).toBe('plant-1')
    expect(postCalls.at(-1).project_id).toBe('proj-1')
  })

  it('does not raise a keyboard on the way out — quantity is anchored, not focused', async () => {
    // Focusing #harvest-quantity would raise the numeric keypad (inputMode="numeric" since BD-063),
    // which is the ~301-344px of viewport this whole row exists to stop spending.
    await renderSession()
    await act(async () => { fireEvent.click(screen.getByTestId('weigh-wizard-opt-plant-1')) })
    expect(document.activeElement).not.toBe(document.getElementById('harvest-quantity'))
  })

  it('filters the list by name', async () => {
    await renderSession()
    fireEvent.change(screen.getByTestId('weigh-wizard-search'), { target: { value: 'cay' } })
    expect(screen.queryByTestId('weigh-wizard-opt-plant-1')).toBeNull()
    expect(screen.getByTestId('weigh-wizard-opt-plant-2')).toBeTruthy()
  })

  it('says so when a filter matches nothing, rather than showing an unexplained empty list', async () => {
    await renderSession()
    fireEvent.change(screen.getByTestId('weigh-wizard-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('weigh-wizard-empty').textContent).toBe('No plantings match that.')
  })
})

// ── The confirm path. Driven on WeighWizard directly so `dirty` can be varied; EventNew passes
//    false in slice 1 for the reason stated at its call site (dismissing step 1 discards nothing).
function renderWizard({ dirty }) {
  const onDismiss = vi.fn()
  const view = render(
    <DismissRegistryProvider>
      <WeighWizard open plants={PLANTS} dirty={dirty} onPick={vi.fn()} onDismiss={onDismiss} />
    </DismissRegistryProvider>
  )
  return { ...view, onDismiss }
}

describe('dismiss', () => {
  it('with nothing entered, Escape closes outright — no confirm', async () => {
    // This case is what makes the next one non-vacuous: if the confirm rendered unconditionally,
    // this assertion fails.
    const { onDismiss } = renderWizard({ dirty: false })
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByTestId('confirm-sheet')).toBeNull()
    expect(onDismiss).toHaveBeenCalled()
  })

  it('with something entered, Escape raises the ConfirmSheet instead of discarding', async () => {
    const { onDismiss } = renderWizard({ dirty: true })
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    const confirm = screen.getByTestId('confirm-sheet')
    expect(confirm).toBeTruthy()
    expect(screen.getByTestId('confirm-sheet-title').textContent).toBe('Discard this harvest?')
    // The body must not overstate the loss — saved picks are server-side and are never at risk.
    expect(screen.getByTestId('confirm-sheet-body').textContent).toMatch(/already saved are kept/)
    // Nothing was dismissed yet: the question is a stop, not a formality.
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('"Keep editing" returns to the step; "Discard" dismisses', async () => {
    const { onDismiss } = renderWizard({ dirty: true })
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-sheet-cancel')) })
    expect(screen.queryByTestId('confirm-sheet')).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
    expect(screen.getByTestId('weigh-wizard')).toBeTruthy()

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-sheet-confirm')) })
    expect(onDismiss).toHaveBeenCalled()
  })
})

describe('handedness — no physical offsets anywhere in the wizard', () => {
  it('renders no left:/right: absolute offset a future preference would have to unpick', async () => {
    // Dave operates the weigh-in LEFT-handed and whether that becomes a preference is unsettled
    // (design §6). comboboxInput.js:145-177 is already stuck with hardcoded `right:` offsets that
    // no `dir` flip can reach; this keeps the wizard out of that trap by construction.
    await renderSession()
    const root = screen.getByTestId('weigh-wizard')
    const offenders = [root, ...root.querySelectorAll('*')].filter(el => {
      const s = el.getAttribute('style') || ''
      return /(^|;)\s*(left|right)\s*:/.test(s)
    })
    expect(offenders.map(e => e.getAttribute('data-testid') || e.tagName)).toEqual([])
  })
})
