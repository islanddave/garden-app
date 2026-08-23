// VarietyPickerA11y.test.jsx — BUG-VARPICKERARIA-001.
//
// VarietyPicker claimed the ARIA combobox pattern (role="combobox", aria-expanded, aria-controls,
// role="listbox", role="option") but wired only the half that needs no option IDENTITY, and wired
// the half it did have unconditionally. The shipped defects, all confirmed against the source
// before this suite existed:
//   1. aria-controls was emitted on EVERY render of search mode, but the listbox it names renders
//      in only two of the four states — closed, disabled, and the mint-a-crop panel each left a
//      DANGLING IDREF pointing at an element never in the DOM;
//   2. on the mint-a-crop panel the lie compounded: aria-expanded stayed "true" while the thing it
//      claimed was expanded (the listbox) had been replaced by a form;
//   3. no aria-activedescendant anywhere — ArrowDown moved a background colour and named no row;
//   4. options carried no `id`, which makes (3) literally unimplementable;
//   5. aria-selected tracked the HIGHLIGHT rather than the committed variety, so the one attribute
//      that did move said the wrong thing (PlantingSelect.jsx:1129 names this component as the
//      example not to copy).
//
// WHAT THIS SUITE CAN PROVE. The contract a screen reader READS: which attributes exist in which
// state, whether every IDREF resolves to a real element, and which row the active descendant names.
// That is the whole machine-checkable surface.
//
// WHAT IT CANNOT PROVE. That TalkBack on Chrome for Android SPEAKS any of it. There is no screen
// reader in jsdom and no assertion here is evidence of an announcement — same honesty scoping as
// PlantingSelectA11y.test.jsx, which this suite deliberately mirrors so the two pickers are held to
// one contract.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import VarietyPicker from '../components/VarietyPicker.jsx'

const V1 = { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum', common_name: 'tomato' }
const V2 = { id: 'var-2', name: 'Cherokee Purple', species: 'Solanum lycopersicum', common_name: 'tomato' }
const CROPS = [
  { slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
  { slug: 'tomato', display_name: 'Tomato', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
]

// By placeholder, NOT getByRole('combobox'): the mint-a-crop form renders two <select>s, and a
// bare <select> carries an IMPLICIT combobox role — so the role query is ambiguous in exactly the
// state this suite most needs to inspect. The role itself is asserted explicitly below.
const field = () => screen.getByPlaceholderText('Search varieties…')
const listbox = () => screen.queryByRole('listbox')
const options = () => screen.getAllByRole('option')
const activeDescendant = () => field().getAttribute('aria-activedescendant')

// The single invariant the whole ticket reduces to: an IDREF a screen reader is told to follow must
// land on an element that is actually in the document. Absent is fine — dangling is not.
function expectNoDanglingRefs() {
  for (const attr of ['aria-controls', 'aria-activedescendant']) {
    const ref = field().getAttribute(attr)
    if (ref === null) continue
    expect(ref, `${attr} must never be empty — '' reads as "there is a target I cannot find"`).not.toBe('')
    expect(document.getElementById(ref), `${attr}="${ref}" points at no element in the DOM`).toBeTruthy()
  }
}

let scrollSpy
beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path) => {
    if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
    return Promise.resolve([V1, V2])
  })
  // jsdom implements neither layout nor scrollIntoView, so the component's optional call is a no-op
  // there. Installing a spy is what makes the APG "scroll the active descendant into view"
  // requirement observable at all — by CONSTRUCTION, never by a scroll position.
  scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy
})
afterEach(() => { vi.restoreAllMocks() })

async function openPicker(props = {}) {
  const utils = render(<VarietyPicker value={null} onChange={() => {}} {...props} />)
  fireEvent.focus(field())
  await waitFor(() => expect(listbox()).toBeTruthy())
  return utils
}

// Drive the picker to stage 2 (the crop chooser) and then stage 3 (the mint form) — the two states
// the unconditional aria-controls got wrong.
async function toCropStage(name = 'Mahogany Splendor') {
  const utils = await openPicker()
  fireEvent.change(field(), { target: { value: name } })
  const createRow = await screen.findByText(
    (_, el) => el?.tagName === 'LI' && /^＋\s*Create/.test(el.textContent || ''),
  )
  await act(async () => { fireEvent.click(createRow) })
  await waitFor(() => screen.getByText('Pepper'))
  return utils
}

describe('claim 1 — aria-controls names a listbox that exists, or is absent', () => {
  it('is ABSENT while the popup is closed', () => {
    render(<VarietyPicker value={null} onChange={() => {}} />)
    // The shipped bug in one line: the attribute was here, and nothing it named was.
    expect(field().getAttribute('role')).toBe('combobox')
    expect(listbox()).toBeNull()
    expectNoDanglingRefs()
    expect(field().hasAttribute('aria-controls')).toBe(false)
    expect(field().getAttribute('aria-expanded')).toBe('false')
  })

  it('names the open listbox once the popup renders', async () => {
    await openPicker()
    expect(field().getAttribute('aria-controls')).toBe(listbox().id)
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expectNoDanglingRefs()
  })

  it('is ABSENT while disabled — a disabled picker renders no popup to control', () => {
    render(<VarietyPicker value={null} onChange={() => {}} disabled />)
    fireEvent.focus(field())
    expect(listbox()).toBeNull()
    expectNoDanglingRefs()
    expect(field().hasAttribute('aria-controls')).toBe(false)
  })

  it('still names the listbox in the crop-chooser stage — that panel DOES render one', async () => {
    await toCropStage()
    expect(listbox()).toBeTruthy()
    expect(field().getAttribute('aria-controls')).toBe(listbox().id)
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expectNoDanglingRefs()
  })

  it('drops to expanded=false with no aria-controls on the mint-a-crop form', async () => {
    await toCropStage()
    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })
    // The form is rendered INSTEAD of the listbox (a role="listbox" may not contain inputs), so the
    // combobox's popup genuinely is not showing. Claiming otherwise sent a screen reader looking for
    // a list that had been swapped out from under it.
    expect(listbox()).toBeNull()
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expectNoDanglingRefs()
    expect(field().getAttribute('aria-expanded')).toBe('false')
    expect(field().hasAttribute('aria-controls')).toBe(false)
  })
})

describe('claim 2 — option identity, the enabler for everything else', () => {
  it('gives every option a non-empty, unique id', async () => {
    await openPicker()
    const ids = options().map(o => o.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    ids.forEach(id => expect(document.getElementById(id)).toBeTruthy())
  })

  it('namespaces ids per instance — AddSeeds and InventoryAdd can mount two pickers on one page', async () => {
    render(
      <>
        <VarietyPicker value={null} onChange={() => {}} id="vp-a" />
        <VarietyPicker value={null} onChange={() => {}} id="vp-b" />
      </>,
    )
    const [a, b] = screen.getAllByPlaceholderText('Search varieties…')
    fireEvent.focus(a)
    fireEvent.focus(b)
    await waitFor(() => expect(screen.getAllByRole('listbox').length).toBe(2))
    const [listA, listB] = screen.getAllByRole('listbox')
    const idsA = within(listA).getAllByRole('option').map(o => o.id)
    const idsB = within(listB).getAllByRole('option').map(o => o.id)
    // Same varieties, two pickers: duplicate ids would make aria-activedescendant resolve into the
    // WRONG picker's list, which is silent and untraceable from the outside.
    expect(listA.id).not.toBe(listB.id)
    expect(idsA.some(id => idsB.includes(id))).toBe(false)
  })
})

describe('claim 3 — aria-activedescendant tracks the visual highlight', () => {
  it('is ABSENT (not empty) while the popup is closed', () => {
    render(<VarietyPicker value={null} onChange={() => {}} />)
    expect(field().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('names the first option as soon as the popup opens', async () => {
    await openPicker()
    expect(activeDescendant()).toBe(options()[0].id)
  })

  it('moves with ArrowDown / ArrowUp, and always resolves to a real row', async () => {
    await openPicker()
    const ids = options().map(o => o.id)
    expect(ids.length).toBeGreaterThan(1)

    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(activeDescendant()).toBe(ids[1])
    expectNoDanglingRefs()

    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(activeDescendant()).toBe(ids[0])
    expectNoDanglingRefs()
  })

  it('names the row the user can SEE highlighted — not merely some row', async () => {
    // Ties the accessible name to the visual state. Without this the attribute could roam
    // independently of the highlight and every assertion above would still pass.
    await openPicker()
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    const active = document.getElementById(activeDescendant())
    expect(active.textContent).toContain('Cherokee Purple')   // row 1, alphabetical
  })

  it('scrolls the active descendant into view — focus never moves, so nothing else will', async () => {
    await openPicker()
    scrollSpy.mockClear()
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled())
    expect(scrollSpy.mock.calls[0][0]).toEqual({ block: 'nearest' })
  })

  it('tracks the crop-chooser rows too — the mint row, then "No crop type"', async () => {
    await toCropStage()
    // The chooser opens on "No crop type" (row 1), never on the mint row: a stray Enter must not
    // start creating a crop type nobody asked for.
    expect(document.getElementById(activeDescendant()).textContent).toMatch(/No crop type/)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(document.getElementById(activeDescendant()).textContent).toMatch(/New crop type/)
    expectNoDanglingRefs()
  })

  it('is reported by the crop FILTER field as well — focus legitimately sits there', async () => {
    await toCropStage()
    const filter = screen.getByLabelText('Filter crop types')
    expect(filter.getAttribute('aria-activedescendant')).toBe(activeDescendant())
    expect(document.getElementById(filter.getAttribute('aria-controls'))).toBe(listbox())
  })
})

describe('claim 4 — aria-selected means SELECTED, not highlighted', () => {
  it('marks the committed variety, and only it, when the list is reopened over a value', async () => {
    render(<VarietyPicker value={V2} onChange={() => {}} />)
    // Chip mode: "Change" is the documented way back into the list while a value is held.
    fireEvent.click(screen.getByText('Change'))
    await waitFor(() => expect(listbox()).toBeTruthy())
    const selected = options().filter(o => o.getAttribute('aria-selected') === 'true')
    expect(selected.length).toBe(1)
    expect(selected[0].textContent).toContain('Cherokee Purple')
  })

  it('does not follow the highlight — that is what aria-activedescendant is for', async () => {
    render(<VarietyPicker value={V2} onChange={() => {}} />)
    fireEvent.click(screen.getByText('Change'))
    await waitFor(() => expect(listbox()).toBeTruthy())
    // Highlight row 0 (Black Krim) while row 1 (Cherokee Purple) stays the committed value.
    const ids = options().map(o => o.id)
    expect(activeDescendant()).toBe(ids[0])
    expect(document.getElementById(ids[0]).getAttribute('aria-selected')).toBe('false')
    expect(document.getElementById(ids[1]).getAttribute('aria-selected')).toBe('true')
  })

  it('marks nothing selected in the crop chooser — picking a row IS the commit', async () => {
    await toCropStage()
    expect(options().every(o => o.getAttribute('aria-selected') === 'false')).toBe(true)
  })
})
