// PlantingSelectA11y.test.jsx — V4-PICKERA11Y-001.
//
// PlantingSelect claimed the ARIA combobox pattern (role="combobox", aria-expanded, aria-controls,
// role="listbox", role="option") but implemented only the half that does not require option
// IDENTITY. The four shipped defects, all confirmed against the source before this suite existed:
//   1. no aria-activedescendant anywhere in src/ — ArrowDown moved a background colour and
//      announced nothing;
//   2. options carried no `id`, which makes (1) literally unimplementable;
//   3. committing a choice unmounted the focused <input> (chip mode does not render it), dropping
//      focus to <body>;
//   4. Escape blurred instead of closing, and its preventDefault() was ungated on `open` — which
//      would have made the hosting Sheet undismissable by keyboard once (3)/(4) kept focus.
//
// WHAT THIS SUITE CAN PROVE. The contract the screen reader READS: which attributes exist, what
// they point at, where DOM focus sits, which events are prevented/stopped, and that the listbox
// owns only valid children. That is the whole of the machine-checkable surface.
//
// WHAT IT CANNOT PROVE. That TalkBack on Chrome for Android actually SPEAKS any of it. There is no
// screen reader in jsdom, and no assertion here should be read as evidence of an announcement.
// Announcement behaviour is a device pass on Dave's Android handset; this suite pins the inputs
// that pass is entitled to assume. Same honesty scoping as PlantingSelectKeyboard.test.jsx, which
// pins `inputmode` without claiming to know whether the soft keyboard rose.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

const apiFetchSpy = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'

const PLANTS = [
  { id: 'p1', name: 'Sunray', quantity: 1 },
  { id: 'p2', name: 'Chili Red', quantity: 1 },
  { id: 'p3', name: 'Minnesota Mini', quantity: 1 },
]

const field = () => screen.getByRole('combobox')
const listbox = () => screen.getByRole('listbox')
const options = () => screen.getAllByRole('option')
const activeDescendant = () => field().getAttribute('aria-activedescendant')

// BUG-PSARIACONTROLS-001. The single invariant the combobox contract reduces to, lifted verbatim
// from VarietyPickerA11y.test.jsx so the two pickers are held to one rule: an IDREF a screen reader
// is told to follow must land on an element that is actually in the document. ABSENT is fine —
// DANGLING is not. This suite already pinned aria-activedescendant in the closed state and never
// pinned aria-controls at all, which is exactly how the dangling `aria-controls` survived here after
// the identical defect was found and fixed in the sibling picker.
function expectNoDanglingRefs() {
  for (const attr of ['aria-controls', 'aria-activedescendant']) {
    const ref = field().getAttribute(attr)
    if (ref === null) continue
    expect(ref, `${attr} must never be empty — '' reads as "there is a target I cannot find"`).not.toBe('')
    expect(document.getElementById(ref), `${attr}="${ref}" points at no element in the DOM`).toBeTruthy()
  }
}

// Real focus, not fireEvent.focus: the whole point of half this suite is where document.activeElement
// actually sits, and fireEvent.focus dispatches the event WITHOUT moving focus.
function openPicker(props = {}) {
  const utils = render(
    <PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" {...props} />,
  )
  act(() => { field().focus() })
  return utils
}

// A host that echoes `value` back, i.e. every real consumer. Without this the component never
// reaches chip mode and the focus-restore path under test is unreachable.
function ControlledHost(props) {
  const [value, setValue] = useState('')
  return <PlantingSelect value={value} onChange={setValue} plants={PLANTS} aria-label="Planting" {...props} />
}

let scrollSpy
beforeEach(() => {
  // jsdom implements neither layout nor scrollIntoView, so the component's optional call is a no-op
  // there. Installing it is what makes the APG "scroll the active descendant into view" requirement
  // observable at all — by CONSTRUCTION (was it called, with what) and never by scroll position.
  scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy
})
afterEach(() => { vi.restoreAllMocks() })

describe('claim 2 — option identity (the enabler for everything else)', () => {
  it('gives every option a non-empty, unique id while keeping the ps-opt-* test id verbatim', () => {
    openPicker()
    const ids = options().map(o => o.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(PLANTS.length)
    // 16 test files and 5 consumer pages select on this. It is a contract, not an implementation
    // detail — the real `id` was ADDED alongside it, never substituted for it.
    expect(options().map(o => o.getAttribute('data-testid')))
      .toEqual(['ps-opt-p2', 'ps-opt-p3', 'ps-opt-p1'])   // alphabetical by name, the default sort
  })

  it('namespaces option ids per instance — CaptureFlow and PhotoLibrary each mount two pickers', () => {
    render(
      <>
        <PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="First" data-testid="ps-a" />
        <PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Second" data-testid="ps-b" />
      </>,
    )
    act(() => { screen.getByLabelText('First').focus() })
    act(() => { screen.getByLabelText('Second').focus() })
    const [listA, listB] = screen.getAllByRole('listbox')
    const idsA = within(listA).getAllByRole('option').map(o => o.id)
    const idsB = within(listB).getAllByRole('option').map(o => o.id)
    // Same plantings, two pickers: duplicate DOM ids would make aria-activedescendant resolve into
    // the WRONG picker's list.
    expect(idsA.some(id => idsB.includes(id))).toBe(false)
    expect(listA.id).not.toBe(listB.id)
  })

})

// BUG-PSARIACONTROLS-001 — moved out of "claim 2" (where a single open-state assertion lived) into
// its own block, mirroring VarietyPickerA11y's "claim 1". The open case is the half this suite
// already had; the closed and disabled cases are the half whose absence let the defect ship.
describe('BUG-PSARIACONTROLS-001 — aria-controls names a listbox that exists, or is absent', () => {
  it('points aria-controls at the listbox that actually exists', () => {
    openPicker()
    expect(field().getAttribute('aria-controls')).toBe(listbox().id)
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expectNoDanglingRefs()
  })

  it('is ABSENT while the popup is closed', () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    // The shipped bug in one line: the attribute was here, and nothing it named was.
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().hasAttribute('aria-controls')).toBe(false)
    expect(field().getAttribute('aria-expanded')).toBe('false')
    expectNoDanglingRefs()
  })

  it('is ABSENT while disabled — a disabled picker renders no popup to control', () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" disabled />)
    act(() => { field().focus() })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().hasAttribute('aria-controls')).toBe(false)
    expect(field().getAttribute('aria-expanded')).toBe('false')
    expectNoDanglingRefs()
  })

  it('drops both attributes when the host disables an ALREADY-OPEN picker', () => {
    // The reachable path, and the reason `open` alone was never a safe source. Nothing in this
    // component closes the panel on disable — `disabled` is a prop the host flips (EventNew disables
    // its planting picker the moment the chosen project is cleared) while `open` is our own state.
    // So the component really does sit at open=true, disabled=true, rendering no listbox.
    const { rerender } = render(
      <PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    act(() => { field().focus() })
    expect(listbox()).toBeTruthy()
    expect(field().getAttribute('aria-controls')).toBe(listbox().id)

    rerender(
      <PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" disabled />)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().getAttribute('aria-expanded')).toBe('false')
    expect(field().hasAttribute('aria-controls')).toBe(false)
    expectNoDanglingRefs()
  })
})

describe('claim 1 — aria-activedescendant tracks the visual highlight', () => {
  it('is ABSENT (not empty) while the popup is closed', () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    // '' would be a dangling reference: "there is an active option, I cannot find it".
    expect(field().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('names the first option as soon as the popup opens', () => {
    openPicker()
    expect(activeDescendant()).toBe(options()[0].id)
  })

  it('follows ArrowDown / ArrowUp through the list', () => {
    openPicker()
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(activeDescendant()).toBe(options()[1].id)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(activeDescendant()).toBe(options()[2].id)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(activeDescendant()).toBe(options()[1].id)
  })

  it('stays on the same row the background highlight paints — one source of truth, no drift', () => {
    openPicker()
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    const active = document.getElementById(activeDescendant())
    // rowStyle paints the highlighted row P.greenPale and every other row transparent.
    expect(active.style.backgroundColor).not.toBe('transparent')
    for (const other of options().filter(o => o !== active)) {
      expect(other.style.backgroundColor).toBe('transparent')
    }
  })

  it('does NOT move DOM focus to the option — the input must keep it (Android soft keyboard)', () => {
    openPicker()
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(field())
  })

  it('drops the attribute when the query filters the list empty', () => {
    openPicker()
    fireEvent.change(field(), { target: { value: 'zzzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(field().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('re-points at the surviving row after the query narrows the list', () => {
    openPicker()
    fireEvent.change(field(), { target: { value: 'Chili' } })
    expect(activeDescendant()).toBe(screen.getByTestId('ps-opt-p2').id)
  })
})

describe('A7 — the active descendant is scrolled into view', () => {
  it('scrolls the arrowed-to option, minimally (block: nearest)', () => {
    openPicker()
    scrollSpy.mockClear()
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    // The listbox height is capped, so without this an arrowed-to row is announced but off-screen.
    // 'nearest' rather than 'center': centring jumps the list under a sighted user's thumb.
    expect(scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1].id)
      .toBe(options()[1].id)
  })

  it('does not scroll anything while the popup is closed', () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    expect(scrollSpy).not.toHaveBeenCalled()
  })
})

describe('claim 3 — committing a choice does not drop the cursor to <body>', () => {
  it('moves focus to the chip-mode Change button, which survives the render-shape swap', async () => {
    render(<ControlledHost />)
    act(() => { field().focus() })
    fireEvent.click(screen.getByTestId('ps-opt-p1'))
    await act(async () => { await new Promise(r => setTimeout(r, 5)) })
    const change = screen.getByRole('button', { name: 'Change' })
    expect(document.activeElement).toBe(change)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('describes that button with the chosen planting, without renaming it', async () => {
    render(<ControlledHost />)
    act(() => { field().focus() })
    fireEvent.click(screen.getByTestId('ps-opt-p1'))
    await act(async () => { await new Promise(r => setTimeout(r, 5)) })
    const change = screen.getByRole('button', { name: 'Change' })
    const described = document.getElementById(change.getAttribute('aria-describedby'))
    expect(described.textContent).toContain('Sunray')
  })

  it('commits by Enter on the active descendant, with the same focus outcome as a tap', async () => {
    render(<ControlledHost />)
    act(() => { field().focus() })
    // Rows sort alphabetically by name: Chili Red, Minnesota Mini, Sunray. One ArrowDown from the
    // opening highlight puts the active descendant on Minnesota Mini.
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    await act(async () => { await new Promise(r => setTimeout(r, 5)) })
    const change = screen.getByRole('button', { name: 'Change' })
    expect(document.activeElement).toBe(change)
    expect(document.getElementById(change.getAttribute('aria-describedby')).textContent)
      .toContain('Minnesota Mini')
  })

  it('leaves focus alone for hosts that never enter chip mode — refocus would re-open the list', async () => {
    // The regression this guards: an unconditional refocus of the <input> fires onFocus, re-opens
    // the picker, and on EventNew an open picker hides the sticky band — taking the post-save
    // confirmation strip out of the a11y tree with it.
    openPicker()                                   // value stays '' (uncontrolled host)
    fireEvent.click(screen.getByTestId('ps-opt-p1'))
    await act(async () => { await new Promise(r => setTimeout(r, 5)) })
    expect(field().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('claim 4 + A5 — Escape closes the popup and nothing more', () => {
  it('closes the popup and KEEPS focus on the combobox', () => {
    openPicker()
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(field())
  })

  it('claims the key while open — preventDefault + stopPropagation, so the host Sheet stays put', () => {
    openPicker()
    const escaped = fireEvent.keyDown(field(), { key: 'Escape' })
    expect(escaped).toBe(false)                    // dispatchEvent false === defaultPrevented
  })

  it('A5 — does NOT claim the key when already closed, so the dismiss registry still sees it', () => {
    // DismissRegistry bails on e.defaultPrevented. An ungated preventDefault here would swallow
    // Escape for the hosting Sheet — and fixing the blur above is exactly what makes
    // "closed + still focused" the normal state, promoting that latent trap into a real one.
    openPicker()
    fireEvent.keyDown(field(), { key: 'Escape' })  // 1st: closes the popup
    const second = fireEvent.keyDown(field(), { key: 'Escape' })
    expect(second).toBe(true)                      // 2nd: falls through untouched
  })

  it('stops propagation to a document listener only while open', () => {
    const docListener = vi.fn()
    document.addEventListener('keydown', docListener)
    try {
      openPicker()
      fireEvent.keyDown(field(), { key: 'Escape' })
      expect(docListener).not.toHaveBeenCalled()
      fireEvent.keyDown(field(), { key: 'Escape' })
      expect(docListener).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', docListener)
    }
  })

  it('re-opens on a tap after Escape — the field must not read as dead', () => {
    openPicker()
    fireEvent.keyDown(field(), { key: 'Escape' })
    // Focus never left, so no focus event fires on the tap; onClick is what re-opens it.
    fireEvent.click(field())
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  it('still marks the field touched, so the required-field error keeps its old behaviour', () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} required aria-label="Planting" />)
    act(() => { field().focus() })
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(screen.getByRole('alert').textContent).toContain('Choose a planting')
  })
})

describe('Tab — the list must not outlive the focus that owns it', () => {
  it('closes the popup without preventing the default focus move', () => {
    openPicker()
    const tabbed = fireEvent.keyDown(field(), { key: 'Tab' })
    expect(tabbed).toBe(true)                      // never preventDefault: Tab must still move focus
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('does not commit the highlighted option — Tab-out is not a write', () => {
    const onChange = vi.fn()
    render(<PlantingSelect value="" onChange={onChange} plants={PLANTS} aria-label="Planting" />)
    act(() => { field().focus() })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Tab' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('A6 — role="listbox" owns only valid children', () => {
  it('keeps the load-failure alert (and its Retry button) OUT of the listbox', () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={[]} loadFailed onRetry={() => {}} aria-label="Planting" />)
    act(() => { field().focus() })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/Couldn’t load your plantings/)
    expect(listbox().contains(alert)).toBe(false)
    expect(listbox().contains(screen.getByTestId('ps-retry'))).toBe(false)
  })

  it('announces the failure exactly once — moved out of the list, not duplicated into it', () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={[]} loadFailed aria-label="Planting" />)
    act(() => { field().focus() })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getAllByText(/Couldn’t load your plantings/)).toHaveLength(1)
  })

  it('contains nothing but role=option once the list loads', () => {
    openPicker()
    const children = [...listbox().children]
    expect(children.every(c => ['option', 'presentation'].includes(c.getAttribute('role')))).toBe(true)
    expect(children.filter(c => c.getAttribute('role') === 'option')).toHaveLength(PLANTS.length)
  })
})

describe('A8 — the option set does not change silently', () => {
  it('renders the live region BEFORE it has anything to say (a region born with its content is mute)', () => {
    const { container } = render(
      <PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />,
    )
    const region = container.querySelector('[aria-live="polite"]')
    expect(region).toBeTruthy()
    expect(region.textContent).toBe('')
  })

  it('reports the count on open and updates it as the typeahead narrows', () => {
    const { container } = render(
      <PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />,
    )
    const region = container.querySelector('[aria-live="polite"]')
    act(() => { field().focus() })
    expect(region.textContent).toBe('3 plantings available')
    fireEvent.change(field(), { target: { value: 'Chili' } })
    expect(region.textContent).toBe('1 planting available')
    fireEvent.change(field(), { target: { value: 'zzzz' } })
    expect(region.textContent).toBe('No plantings available')
  })

  it('does not claim role="status" — hosts render their own, queried singularly', () => {
    openPicker()
    expect(screen.queryAllByRole('status')).toHaveLength(0)
  })
})
