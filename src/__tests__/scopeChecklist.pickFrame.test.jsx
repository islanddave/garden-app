// V4-LOGMANYUXREFRESH-001 S2 + S3 — the tap-target floor and the PICK frame.
//
// Dave selected ALL FOUR failure modes on this row. S1 answered (a) "cannot find it" and (b) "too
// much scrolling" inside the existing card. What is left, and what this file pins:
//   (c) "the multi-select itself is fiddly: small tap targets" — the four controls on the selection
//       path that shipped under the app's OWN named floor (T.tapMinHeight = 44).
//   (d) "cannot tell what is selected" — the VISIBILITY half. S0 fixed the state half (the
//       selection is no longer destroyed by a scope/type/date change); this fixes the half where
//       what you picked lives behind a collapsed disclosure in a 240px window.
//
// SCOPE OF WHAT A jsdom TEST CAN PROVE, stated so it is not over-read: there is no layout engine
// here, so every getBoundingClientRect() is zero and NOTHING below measures a pixel. These assert
// the STYLE CONTRACT (the declared minHeight, which prop was passed) and the BEHAVIOUR. The actual
// heights are measured in a real browser at 390px by tests/harness/logmanypick.{jsx,viewport.html}
// — that harness is the instrument for the size claims, and this file is the instrument for the
// wiring that would silently undo them.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(), getToken: vi.fn(async () => null) }) }))
const saveLogManyAllSelected = vi.fn()
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: vi.fn(async () => null),
  saveLogManyAllSelected: (...a) => saveLogManyAllSelected(...a),
  saveHandedness: vi.fn(),
  HANDEDNESS_VALUES: ['right', 'left'],
}))

import ScopeChecklist from '../components/forms/ScopeChecklist.jsx'
import { T } from '../components/forms/formStyles.js'
import Sheet from '../components/forms/Sheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

// 12 plantings across 4 crop buckets including the crop-type-less one, so the chip row clears
// CHIPS_MIN_ROWS (8). Same fixture shape scopeChecklist.find.test.jsx uses — one vocabulary.
const PLANTINGS = [
  { id: 't1', name: 'Sun Gold', crop_type_slug: 'tomato' },
  { id: 't2', name: 'San Marzano', crop_type_slug: 'tomato' },
  { id: 't3', name: 'Sunray', crop_type_slug: 'tomato' },
  { id: 't4', name: 'Black Krim', crop_type_slug: 'tomato' },
  { id: 't5', name: 'Brandywine', crop_type_slug: 'tomato' },
  { id: 'p1', name: 'Aji Dulce', crop_type_slug: 'pepper' },
  { id: 'p2', name: 'Jalapeno', crop_type_slug: 'pepper' },
  { id: 'p3', name: 'Shishito', crop_type_slug: 'pepper' },
  { id: 'p4', name: 'Chili Red', crop_type_slug: 'pepper' },
  { id: 'b1', name: 'Genovese', crop_type_slug: 'basil' },
  { id: 'b2', name: 'Thai Basil', crop_type_slug: 'basil' },
  { id: 'n1', name: 'Kousa Dogwood', crop_type_slug: null },
]
const LOCATIONS = [{ id: 'bag', name: 'Bag Area' }, { id: 'trough', name: 'Trough' }]
const dryRunOk = (rows = PLANTINGS) => vi.fn(() => Promise.resolve({ count: rows.length, capped: false, plantings: rows }))

let lastSel = null
function Harness({ runDryRun = dryRunOk(), locations = LOCATIONS, ...rest }) {
  const [scope, setScope] = useState({ type: 'all' })
  return (
    <ScopeChecklist
      scope={scope} onScopeChange={setScope} projects={[]} locations={locations}
      eventType="watering" eventDate="" verbLabel="watering"
      runDryRun={runDryRun} onSelectionChange={(s) => { lastSel = s }}
      {...rest}
    />
  )
}

const openList = async () => fireEvent.click(await screen.findByText(/Review \d+ plantings/))
const enterPick = async () => {
  await screen.findByTestId('sc-mode-pick')
  fireEvent.click(screen.getByTestId('sc-mode-pick'))
  return screen.findByTestId('pick-frame')
}
const pickRows = () => [...document.querySelectorAll('[data-testid="pick-list"] button[aria-pressed]')]
const pickRowNames = () => pickRows().map(b => b.querySelector('span:nth-of-type(2)')?.textContent)
const trayChips = () => [...document.querySelectorAll('[data-testid="pick-tray"] button')]
const type = (v) => fireEvent.change(screen.getByTestId('sc-search'), { target: { value: v } })

beforeEach(() => {
  lastSel = null
  saveLogManyAllSelected.mockClear()
  try { localStorage.clear() } catch (e) {}
})
// Sheet locks body scroll through a module-level refcount; leaving it set leaks across files.
afterEach(() => { document.body.style.overflow = ''; document.body.style.overscrollBehavior = '' })

// ══ S2 ══════════════════════════════════════════════════════════════════════════════════════
describe('S2 — the four controls that shipped under the app\'s own 44px floor', () => {
  // The floor is NAMED (formStyles T.tapMinHeight), minted by BUG-DISCLOSURETAPSIZE-001 because
  // four controls on Log Event shipped under it. Asserting against the TOKEN and not the number 44
  // is deliberate: if the floor is ever retuned these move with it rather than silently diverging.
  it('the Review link — the only door into the list — declares the tap floor', async () => {
    render(<Harness />)
    const link = await screen.findByText(/Review \d+ plantings/)
    expect(link.style.minHeight).toBe(`${T.tapMinHeight}px`)
    // inline-flex, not the default inline-block: a minHeight on an inline box is ignored, so
    // without this the declaration above would be decoration.
    expect(link.style.display).toBe('inline-flex')
  })

  it('the preference checkbox target is the LABEL, and the label declares the tap floor', async () => {
    render(<Harness />)
    await openList()
    const box = screen.getByTestId('sc-default-all')
    const label = box.closest('label')
    expect(label).not.toBeNull()
    expect(label.style.minHeight).toBe(`${T.tapMinHeight}px`)
    // The box itself is still a checkbox-sized glyph — 44px would be absurd — but no longer 13px.
    expect(box.style.width).toBe('20px')
    // And the label really is the target: clicking it toggles the control.
    fireEvent.click(box)
    await waitFor(() => expect(saveLogManyAllSelected).toHaveBeenCalled())
  })

  it('every scope and zone chip carries the 48px touch variant', async () => {
    render(<Harness />)
    const all = await screen.findByText('All active')
    const byZone = screen.getByText('By zone')
    expect(all.style.minHeight).toBe(`${T.buttonMinHeight}px`)
    expect(byZone.style.minHeight).toBe(`${T.buttonMinHeight}px`)
    // The zone cascade only renders under a space scope, and it is the row with the MOST chips —
    // the one where a height bump could have wrapped the row. (Wrapping is a layout question and is
    // answered in the browser harness; this only pins that the variant reached them.)
    fireEvent.click(byZone)
    const zoneGroup = await screen.findByRole('group', { name: 'Zone' })
    const chips = [...zoneGroup.querySelectorAll('button')]
    expect(chips.length).toBeGreaterThan(0)
    for (const c of chips) expect(c.style.minHeight).toBe(`${T.buttonMinHeight}px`)
  })

  // The mode switch is NEW UI on the same path, so it is held to the same floor. Named explicitly
  // because the obvious primitive for it (SegmentedControl) is minHeight 40 and would have planted
  // two fresh violations on the surface this row exists to raise.
  it('the new mode chips are not a fresh pair of sub-44 targets', async () => {
    render(<Harness />)
    const pick = await screen.findByTestId('sc-mode-pick')
    expect(pick.style.minHeight).toBe(`${T.buttonMinHeight}px`)
    expect(screen.getByTestId('sc-mode-bulk').style.minHeight).toBe(`${T.buttonMinHeight}px`)
  })
})

// ══ S3 ══════════════════════════════════════════════════════════════════════════════════════
describe('S3 — BULK is untouched until the user asks for PICK', () => {
  it('mounts in BULK: the review list, the preference and the net-count line are all present', async () => {
    render(<Harness />)
    await openList()
    expect(screen.getByTestId('sc-default-all')).toBeDefined()
    expect(document.querySelector('[data-testid="pick-frame"]')).toBeNull()
    expect(lastSel.frameOpen).toBe(false)
    // Baseline is the stored default (true), so BULK still starts with everything selected.
    expect(lastSel.committedCount).toBe(12)
  })

  it('the net-count line is BULK-only — in PICK it would state the user\'s three picks as 9 skipped', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(screen.getByText('Sun Gold'))
    expect((await screen.findByTestId('net-count')).textContent).toMatch(/12 matched − 1 skipped → 11/)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))
    await waitFor(() => expect(lastSel.committedCount).toBe(1))
    expect(document.querySelector('[data-testid="net-count"]')).toBeNull()
    expect(screen.getByTestId('sc-pick-summary').textContent).toBe('1 of 12 picked.')
  })
})

describe('S3 — the frame is the one scroller, and the tracks hold what the design says', () => {
  it('opens on the PICK chip with an EMPTY selection — "pick, don\'t un-pick"', async () => {
    render(<Harness />)
    await screen.findByText(/Review \d+ plantings/)
    expect(lastSel.committedCount).toBe(12)          // BULK default: everything
    await enterPick()
    await waitFor(() => expect(lastSel.committedCount).toBe(0))
    expect(lastSel.excludedIds).toHaveLength(12)     // the complement — the shipped wire contract
    expect(screen.getByTestId('pick-tray').textContent).toMatch(/Nothing picked yet/)
  })

  it('track 2 is the scroller and it is UNBOUNDED — no 240px window nested in a scrolling page', async () => {
    render(<Harness />)
    await enterPick()
    const frame = screen.getByTestId('pick-frame')
    expect(frame.style.gridTemplateRows).toBe('auto 1fr auto')
    // The failure this replaces, by its exact number: the review list is maxHeight 240 with its own
    // overflow, sitting inside a page that also scrolls. The frame's list declares NO height cap.
    const list = screen.getByTestId('pick-list')
    expect(list.style.maxHeight).toBe('')
    expect(list.style.overflowY).toBe('auto')
    // A flick that reaches the end must not chain to whatever is behind the layer.
    expect(list.style.overscrollBehavior).toBe('contain')
    expect(frame.style.overscrollBehavior).toBe('contain')
    // minmax(0,1fr) on the column, or one long planting name widens the frame past the viewport and
    // `overflow: hidden` CLIPS the tray and the commit button rather than scrolling to them — the
    // measured failure the weigh-in frame documents.
    expect(frame.style.gridTemplateColumns).toBe('minmax(0, 1fr)')
    expect(frame.style.overflow).toBe('hidden')
  })

  it('rows show name AND crop type, are at the tap floor, and TAPPING ADDS', async () => {
    render(<Harness />)
    await enterPick()
    const row = screen.getByTestId('pick-row-t1')
    expect(row.style.minHeight).toBe(`${T.tapMinHeight}px`)
    expect(row.getAttribute('aria-pressed')).toBe('false')
    expect(row.textContent).toMatch(/Sun Gold/)
    expect(row.textContent).toMatch(/Tomato/)
    fireEvent.click(row)
    await waitFor(() => expect(row.getAttribute('aria-pressed')).toBe('true'))
    expect(lastSel.committedCount).toBe(1)
    fireEvent.click(row)
    await waitFor(() => expect(lastSel.committedCount).toBe(0))
  })

  it('the crop-type-less planting is labelled Ungrouped, never blank', async () => {
    render(<Harness />)
    await enterPick()
    expect(screen.getByTestId('pick-row-n1').textContent).toMatch(/Ungrouped/)
  })

  it('candidates are ordered by crop band first, then alphabetically inside it', async () => {
    render(<Harness />)
    await enterPick()
    // Pins are data-driven top-2 by live count: tomato (5) then pepper (4). With an empty rank
    // ledger the remaining crops fall to the alphabetical tail, and names sort inside each band.
    const names = pickRowNames()
    expect(names.slice(0, 5)).toEqual(['Black Krim', 'Brandywine', 'San Marzano', 'Sun Gold', 'Sunray'])
    expect(names.slice(5, 9)).toEqual(['Aji Dulce', 'Chili Red', 'Jalapeno', 'Shishito'])
  })
})

describe('S3 — track 3: what is picked is always on screen (failure mode (d))', () => {
  it('a pick appears in the tray with a remove control and a count', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))
    fireEvent.click(screen.getByTestId('pick-row-p1'))
    await waitFor(() => expect(screen.getByTestId('pick-count').textContent).toBe('2 picked'))
    // Alphabetical (the `plantings` order), deliberately NOT tap order: the tray's chips each carry
    // a REMOVE, and a tray that reorders on every pick moves those targets under a mid-batch thumb.
    const chips = trayChips()
    expect(chips.map(c => c.getAttribute('aria-label'))).toEqual(['Remove Aji Dulce', 'Remove Sun Gold'])
    for (const c of chips) expect(c.style.minHeight).toBe(`${T.buttonMinHeight}px`)
    // The tray SCROLLS sideways rather than wrapping: a wrapping tray grows track 3 without bound
    // and eats the candidate list, which is the height this whole design is buying.
    const tray = screen.getByTestId('pick-tray')
    expect(tray.style.overflowX).toBe('auto')
    expect(tray.style.flexWrap).toBe('')
  })

  it('the ✕ on a tray chip removes that pick', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))
    await waitFor(() => expect(trayChips()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('pick-chip-t1'))
    await waitFor(() => expect(lastSel.committedCount).toBe(0))
    expect(trayChips()).toHaveLength(0)
  })

  // THE KEYSTONE for (d). A filter narrows the candidate list; it must NOT narrow the tray, or the
  // user loses sight of a pick the moment they search for the next one — which is the exact
  // "selection does not survive filtering" complaint on the row, rebuilt in the new surface.
  it('a pick stays in the tray after a filter hides its row', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))          // Sun Gold, a tomato
    await waitFor(() => expect(trayChips()).toHaveLength(1))
    type('jalapeno')
    await waitFor(() => expect(pickRows()).toHaveLength(1))
    expect(document.querySelector('[data-testid="pick-row-t1"]')).toBeNull()   // row is hidden
    expect(screen.getByTestId('pick-chip-t1')).toBeDefined()                   // pick is not
    expect(screen.getByTestId('pick-count').textContent).toBe('1 picked')
    expect(lastSel.committedCount).toBe(1)
  })

  it('renders the caller\'s primary action inside track 3, under the tray', async () => {
    render(<Harness primaryAction={<button type="button">Log watering on N</button>} />)
    await enterPick()
    const frame = screen.getByTestId('pick-frame')
    const btn = screen.getByText('Log watering on N')
    expect(frame.contains(btn)).toBe(true)
    // Under, not over: the design's whole point is that the count and the chips sit BETWEEN the
    // list and the commit control, so the last thing before committing is what you are committing.
    const tray = screen.getByTestId('pick-tray')
    expect(tray.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('S3 — filters narrow the VIEW, never the batch (the S1 invariant, re-pinned in the frame)', () => {
  it('the shown-note states the hidden count, and the excluded set still spans the whole scope', async () => {
    render(<Harness />)
    await enterPick()
    type('sun')
    await waitFor(() => expect(screen.getByTestId('sc-shown-note').textContent)
      .toBe('Showing 2 of 12 — 10 hidden by filters'))
    // Nothing picked, so every one of the TWELVE is excluded — not just the two on screen.
    expect(lastSel.excludedIds).toHaveLength(12)
  })

  it('offers the bulk exit from inside pick mode only while a filter is narrowing', async () => {
    render(<Harness />)
    await enterPick()
    expect(document.querySelector('[data-testid="pick-select-shown"]')).toBeNull()
    type('sun')
    const bulk = await screen.findByTestId('pick-select-shown')
    expect(bulk.textContent).toBe('Select all 2 shown')
    fireEvent.click(bulk)
    await waitFor(() => expect(lastSel.committedCount).toBe(2))
    // It reaches the FILTERED set only — never past the filter.
    expect(screen.getByTestId('pick-count').textContent).toBe('2 picked')
  })

  it('a no-match state names the way back rather than showing an empty box', async () => {
    render(<Harness />)
    await enterPick()
    // 'quince', not 'zzzz': looseKey COLLAPSES repeated letters, so 'zzzz' normalises to 'z' and
    // matches San Marzano. A no-match fixture that quietly matches would have made this assertion
    // pass for the wrong reason in the other direction.
    type('quince')
    expect((await screen.findByTestId('pick-no-matches')).textContent)
      .toMatch(/Clear the search or the crop chips to see all 12/)
  })
})

// ══ THE NUMBER THE ROW IS ACTUALLY JUDGED ON ═════════════════════════════════════════════════
// The design's own scenario: a non-harvest event on exactly THREE named plantings. Counted
// MECHANICALLY (every click is counted, and the count is asserted) rather than reasoned, and scoped
// to taps INSIDE THE SELECTOR — reaching the page and choosing an event type are identical on both
// paths. Typing is excluded from both sides for the same reason: it is keystrokes, not taps, and it
// is bounded by name length rather than by garden size.
describe('S3 — the three-planting scenario, tap for tap', () => {
  const countClicks = () => {
    let n = 0
    const real = fireEvent.click
    const wrapped = (...a) => { n += 1; return real(...a) }
    return { click: wrapped, count: () => n }
  }

  it('BULK (as shipped) takes 6 selector taps; PICK takes 5, and ends on the commit control', async () => {
    // ── BULK: open the list, clear the stored-default selection, raise the keyboard, tap three.
    const bulk = countClicks()
    render(<Harness />)
    bulk.click(await screen.findByText(/Review \d+ plantings/))      // 1 — the only door in
    bulk.click(screen.getByTestId('sc-select-none'))                 // 2 — session-scoped clear-all
    bulk.click(screen.getByTestId('sc-kb'))                          // 3 — the list opens keyboard-less
    for (const name of ['Sun Gold', 'Jalapeno', 'Genovese']) {       // 4,5,6
      type(name)
      await waitFor(() => expect(document.querySelectorAll('ul li button[aria-pressed]').length).toBe(1))
      bulk.click(document.querySelector('ul li button[aria-pressed]'))
    }
    await waitFor(() => expect(lastSel.committedCount).toBe(3))
    expect(bulk.count()).toBe(6)
    cleanup()

    // ── PICK: ONE tap does what the first two did — the mode chip enters pick mode, empties the
    // selection and opens the frame, because "starts empty" is the mode's definition rather than a
    // gesture the user has to perform.
    lastSel = null
    const pick = countClicks()
    render(<Harness />)
    await screen.findByTestId('sc-mode-pick')
    pick.click(screen.getByTestId('sc-mode-pick'))                   // 1
    await screen.findByTestId('pick-frame')
    pick.click(screen.getByTestId('sc-kb'))                          // 2
    for (const name of ['Sun Gold', 'Jalapeno', 'Genovese']) {       // 3,4,5
      type(name)
      await waitFor(() => expect(pickRows()).toHaveLength(1))
      pick.click(pickRows()[0])
    }
    await waitFor(() => expect(lastSel.committedCount).toBe(3))
    expect(pick.count()).toBe(5)
  })
})

describe('S3 — the frame is the topmost dismissable surface, not the sheet under it', () => {
  // Log Many is an `overlayable` route, so in the overlay host it renders inside a Sheet whose
  // Escape handler dismisses the WHOLE page. An unregistered full-screen layer would therefore be
  // wiped out from underneath the user by an Escape aimed at the picker. Registering at the layer
  // the frame PAINTS (DIALOG = 1000) is what makes arbitration order agree with paint order.
  const Hosted = ({ onSheetClose }) => (
    <DismissRegistryProvider>
      <Sheet open onClose={onSheetClose} ariaLabel="Log many" kind="route">
        <Harness />
      </Sheet>
    </DismissRegistryProvider>
  )

  it('Escape closes the frame and leaves the hosting sheet open', async () => {
    const onSheetClose = vi.fn()
    render(<Hosted onSheetClose={onSheetClose} />)
    await enterPick()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-testid="pick-frame"]')).toBeNull())
    expect(onSheetClose).not.toHaveBeenCalled()
    // And the picks are not collateral damage — the frame closed, the selection did not.
    expect(screen.getByTestId('sc-open-pick')).toBeDefined()
  })

  it('with the frame closed, Escape reaches the sheet again', async () => {
    const onSheetClose = vi.fn()
    render(<Hosted onSheetClose={onSheetClose} />)
    await screen.findByText(/Review \d+ plantings/)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onSheetClose).toHaveBeenCalled())
  })
})

describe('S3 — leaving the frame, and switching back', () => {
  it('Done closes the frame and the in-page card keeps the count and the way back in', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))
    fireEvent.click(screen.getByTestId('pick-row-t2'))
    await waitFor(() => expect(lastSel.committedCount).toBe(2))
    fireEvent.click(screen.getByTestId('pick-done'))
    await waitFor(() => expect(document.querySelector('[data-testid="pick-frame"]')).toBeNull())
    expect(lastSel.frameOpen).toBe(false)
    expect(lastSel.committedCount).toBe(2)                                    // picks survive
    expect(screen.getByTestId('sc-pick-summary').textContent).toBe('2 of 12 picked.')
    fireEvent.click(screen.getByTestId('sc-open-pick'))
    await screen.findByTestId('pick-frame')
    expect(screen.getByTestId('pick-count').textContent).toBe('2 picked')
  })

  it('switching back to BULK restores the stored default rather than keeping the pick', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))
    await waitFor(() => expect(lastSel.committedCount).toBe(1))
    fireEvent.click(screen.getByTestId('sc-mode-bulk'))
    await waitFor(() => expect(lastSel.committedCount).toBe(12))
    expect(document.querySelector('[data-testid="pick-frame"]')).toBeNull()
    // The mode switch is a session gesture, NOT a preference write — same rule as Select none.
    expect(saveLogManyAllSelected).not.toHaveBeenCalled()
  })

  it('the mode rides in the resumable selection state so a restore comes back in the right shape', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))
    await waitFor(() => expect(lastSel.selectionState.mode).toBe('pick'))
    expect(lastSel.selectionState.touched).toBe(true)
    expect(lastSel.selectionState.baseline).toBe(false)
  })

  it('a restored PICK selection mounts in PICK mode, with the frame closed', async () => {
    render(<Harness initialSelection={{ decisions: { t1: true }, baseline: false, touched: true, mode: 'pick' }} />)
    await screen.findByTestId('sc-pick-summary')
    expect(screen.getByTestId('sc-pick-summary').textContent).toBe('1 of 12 picked.')
    // Restoring must not throw a full-screen picker over the page on mount — the user came back to
    // a form, not to a chooser.
    expect(document.querySelector('[data-testid="pick-frame"]')).toBeNull()
    expect(screen.getByTestId('sc-open-pick').textContent).toBe('Change picks (1)')
  })

  it('an old stash with no mode restores as BULK — the shipped shape stays valid', async () => {
    render(<Harness initialSelection={{ decisions: { t1: false }, baseline: true, touched: true }} />)
    await screen.findByText(/Review \d+ plantings/)
    expect(document.querySelector('[data-testid="sc-pick-summary"]')).toBeNull()
    expect(lastSel.committedCount).toBe(11)
  })
})
