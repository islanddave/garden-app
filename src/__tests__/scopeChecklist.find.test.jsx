// V4-LOGMANYUXREFRESH-001 S1 — finding a planting in Log Many.
//
// Dave, verbatim on the ledger row: "the planting selector is terrible and hard to use NOT JUST THE
// ORDERING/GROUPING ISSUE", and he selected all four failure modes, of which (a) is "he knows what
// he wants and cannot get to it". The mechanical cause: ScopeChecklist contained NO TEXT INPUT AT
// ALL and exactly one narrowing axis (zone). 239 alphabetical names in a 240px scrollport.
//
// This file pins the three additions and, more importantly, the ONE INVARIANT they must not break:
// the filters narrow WHAT IS SHOWN, never what is committed. A filter that also changed the batch
// would be the silent-omission class (BUG-LOGMANYPROJECTLESS-001, V4-LOGMANYCROPFILTER-001) rebuilt
// on a new surface.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(), getToken: vi.fn(async () => null) }) }))
// Spied, not stubbed away: "Select none must not write the stored preference" is only assertable if
// something is watching the write.
const saveLogManyAllSelected = vi.fn()
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: vi.fn(async () => null),
  saveLogManyAllSelected: (...a) => saveLogManyAllSelected(...a),
  saveHandedness: vi.fn(),
  HANDEDNESS_VALUES: ['right', 'left'],
}))

import ScopeChecklist from '../components/forms/ScopeChecklist.jsx'

// 12 plantings so the chip row clears CHIPS_MIN_ROWS (8), across 4 buckets including the
// crop-type-less one. Proportions echo prod: tomato and pepper dominate, a long thin tail.
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
const dryRunOk = (rows = PLANTINGS) => vi.fn(() => Promise.resolve({ count: rows.length, capped: false, plantings: rows }))

let lastSel = null
function Harness({ runDryRun = dryRunOk(), ...rest }) {
  const [scope, setScope] = useState({ type: 'all' })
  return (
    <ScopeChecklist
      scope={scope} onScopeChange={setScope} projects={[]} locations={[]}
      eventType="watering" eventDate="" verbLabel="watering"
      runDryRun={runDryRun} onSelectionChange={(s) => { lastSel = s }}
      {...rest}
    />
  )
}

const openList = async () => fireEvent.click(await screen.findByText(/Review \d+ plantings/))
const rowNames = () => [...document.querySelectorAll('ul li button[aria-pressed]')].map(b => b.textContent.replace(/^[✓○]/, ''))
const type = (v) => fireEvent.change(screen.getByTestId('sc-search'), { target: { value: v } })
// S5 — SCOPED to the chip row, where these used to be a bare getByText. Grouping the review list
// (Dave's call over S4's density recommendation) puts a "Pepper" header in the same document as the
// "Pepper" chip, so an unscoped query now finds two nodes and throws. Same shape as the helper
// scopeChecklist.groupFilter.test.jsx already uses for the PICK frame, which has had the collision
// since S4 — the query was ambiguous by luck, not by design.
const cropChip = (label) => {
  const btn = [...document.querySelectorAll('[data-testid="sc-crop-chips"] button')]
    .find(b => b.textContent.replace(/\s+/g, ' ').trim() === label)
  if (!btn) throw new Error(`no crop chip labelled "${label}"`)
  return btn
}

beforeEach(() => {
  lastSel = null
  saveLogManyAllSelected.mockClear()
  try { localStorage.clear() } catch (e) {}
})

describe('S1 — text search (the missing control)', () => {
  it('renders a search field inside the open list — there was none at all before', async () => {
    render(<Harness />)
    await openList()
    expect(screen.getByTestId('sc-search')).toBeDefined()
    expect(screen.getByLabelText('Search these plantings')).toBeDefined()
  })

  it('narrows the rows as you type', async () => {
    render(<Harness />)
    await openList()
    type('krim')
    await waitFor(() => expect(rowNames()).toEqual(['Black Krim']))
  })

  // looseIncludes, not toLowerCase().includes(). This is the case that makes the mic worth having:
  // Web Speech returns "sun ray" for "Sunray" and "chilli" for "Chili" — the V4-PICKERVOICE-001
  // normalization (whitespace stripped, repeated letters collapsed) is what makes both land.
  it('matches voice-shaped input: "sun ray" finds Sunray, "chilli" finds Chili Red', async () => {
    render(<Harness />)
    await openList()
    type('sun ray')
    await waitFor(() => expect(rowNames()).toEqual(['Sunray']))
    type('chilli')
    await waitFor(() => expect(rowNames()).toEqual(['Chili Red']))
  })

  // The crop slug is in the haystack, so a crop word narrows even where no planting NAME carries it.
  // Not one of these five tomato names contains the string "tomato".
  it('the crop slug is searchable even when no planting name contains it', async () => {
    render(<Harness />)
    await openList()
    type('tomato')
    await waitFor(() => expect(rowNames().length).toBe(5))
    expect(rowNames()).toContain('Sun Gold')
  })

  it('ships the keyboard-less open and the ⌨ toggle the other pickers already have', async () => {
    render(<Harness />)
    await openList()
    // V4-PICKERALL-001: the list opens for READING, so the Android keyboard stays down…
    expect(screen.getByTestId('sc-search').getAttribute('inputmode')).toBe('none')
    // …and the toggle is the way up, announcing the action it performs plus the mode it is in.
    const kb = screen.getByTestId('sc-kb')
    expect(kb.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(kb)
    await waitFor(() => expect(screen.getByTestId('sc-search').getAttribute('inputmode')).toBe('text'))
    expect(screen.getByTestId('sc-kb').getAttribute('aria-pressed')).toBe('true')
  })

  it('states what is hidden, always — a filter is never silent', async () => {
    render(<Harness />)
    await openList()
    expect(screen.getByTestId('sc-shown-note').textContent).toMatch(/Showing all 12/)
    type('krim')
    await waitFor(() => expect(screen.getByTestId('sc-shown-note').textContent)
      .toMatch(/Showing 1 of 12 — 11 hidden by filters/))
  })

  it('a search that matches nothing says so, and says how to get back', async () => {
    render(<Harness />)
    await openList()
    // 'qqq' and not 'zzz': looseKey COLLAPSES repeated letters, so 'zzz' is the needle 'z' — which
    // San Marzano matches. The normalization is doing its job; a no-match probe just has to respect
    // it. (Worth knowing at a glance: this is what makes "chilli" find "Chili Red".)
    type('qqq')
    const empty = await screen.findByTestId('sc-no-matches')
    expect(empty.textContent).toMatch(/Clear the search or the crop chips to see all 12/)
  })
})

describe('S1 — crop chips', () => {
  it('pins the top-2 crops by live count, derived from the data and not hardcoded', async () => {
    render(<Harness />)
    await openList()
    const row = screen.getByTestId('sc-crop-chips')
    // tomato (5) and pepper (4) are the pins; basil (2) and Ungrouped (1) sit behind More ▾.
    expect([...row.querySelectorAll('button[aria-pressed]')].map(b => b.textContent))
      .toEqual(['Tomato', 'Pepper'])
  })

  it('a chip narrows the list to that crop', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(cropChip('Pepper'))
    await waitFor(() => expect(rowNames().length).toBe(4))
    expect(rowNames()).toContain('Jalapeno')
  })

  it('two chips are OR, and a chip ANDs with the text search', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(cropChip('Tomato'))
    fireEvent.click(cropChip('Pepper'))
    await waitFor(() => expect(rowNames().length).toBe(9))
    type('sun')
    await waitFor(() => expect(rowNames()).toEqual(['Sun Gold', 'Sunray']))
  })

  // V4-LOGMANYCROPFILTER-001 names dropping the crop-type-less plantings as the same defect class as
  // BUG-LOGMANYPROJECTLESS-001. They get a bucket, not silence — 3 such plantings live on prod.
  it('a planting with no crop type gets an Ungrouped chip and is never unreachable', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(screen.getByText('More ▾'))
    fireEvent.click(cropChip('Ungrouped'))
    await waitFor(() => expect(rowNames()).toEqual(['Kousa Dogwood']))
  })

  it('no chip row when scanning beats filtering (≤7 rows) or when one crop cannot discriminate', async () => {
    const { unmount } = render(<Harness runDryRun={dryRunOk(PLANTINGS.slice(0, 5))} />)
    await openList()
    expect(screen.queryByTestId('sc-crop-chips')).toBeNull()
    unmount()
    render(<Harness runDryRun={dryRunOk(PLANTINGS.filter(p => p.crop_type_slug === 'tomato'))} />)
    await openList()
    expect(screen.queryByTestId('sc-crop-chips')).toBeNull()
  })
})

describe('S1 — the filters narrow the VIEW, never the batch', () => {
  // THE KEYSTONE. If a filter could remove a planting from the committed set, Log Many would write
  // fewer events than the headline promised — the exact failure BUG-LOGMANYPROJECTLESS-001 was filed
  // about, re-created client-side and invisible to every server-side guard.
  it('filtering the list does not change the committed count or the excluded ids', async () => {
    render(<Harness />)
    await openList()
    await waitFor(() => expect(lastSel.committedCount).toBe(12))
    fireEvent.click(cropChip('Pepper'))
    type('jala')
    await waitFor(() => expect(rowNames()).toEqual(['Jalapeno']))
    expect(lastSel.committedCount).toBe(12)
    expect(lastSel.excludedIds).toEqual([])
  })

  // The sharper form of the same claim, and the one that fails if excludedIds is ever computed over
  // the filtered view instead of the whole preview: a skip made on a row that is then FILTERED OUT
  // OF SIGHT must still ride in the POST body. Computing over `shown` reads as a tidy-up and would
  // silently start logging a planting the user skipped.
  it('a skip stays in excludedIds after the row is filtered out of view', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(screen.getByText('Shishito'))
    await waitFor(() => expect(lastSel.excludedIds).toEqual(['p3']))
    fireEvent.click(cropChip('Tomato'))       // Shishito is a pepper — now hidden
    await waitFor(() => expect(rowNames().length).toBe(5))
    expect(screen.queryByText('Shishito')).toBeNull()
    expect(lastSel.excludedIds).toEqual(['p3'])
    expect(lastSel.committedCount).toBe(11)
  })

  it('a skip made under a filter survives clearing the filter', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(cropChip('Pepper'))
    fireEvent.click(await screen.findByText('Shishito'))
    await waitFor(() => expect(lastSel.excludedIds).toEqual(['p3']))
    fireEvent.click(cropChip('Pepper'))     // deselect the chip
    await waitFor(() => expect(rowNames().length).toBe(12))
    expect(screen.getByText('Shishito').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('S1 — session-scoped Select none / Select all shown', () => {
  // The defect this closes: the ONLY clear-all on this screen was the "Start with everything
  // selected" checkbox, and flipping it fires saveLogManyAllSelected at the server — so using it to
  // clear a single batch permanently changed the default for every future batch.
  it('Select none clears the whole selection and writes NO preference', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(screen.getByTestId('sc-select-none'))
    await waitFor(() => expect(lastSel.committedCount).toBe(0))
    expect(saveLogManyAllSelected).not.toHaveBeenCalled()
    expect(localStorage.getItem('quicklog.defaultAllSelected')).toBeNull()
    // …and the checkbox that DOES own the preference is untouched by it.
    expect(screen.getByLabelText('Start with everything selected').checked).toBe(true)
  })

  it('the preference checkbox still writes the preference — the contrast that makes the above meaningful', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(screen.getByLabelText('Start with everything selected'))
    await waitFor(() => expect(saveLogManyAllSelected).toHaveBeenCalledWith(expect.objectContaining({ value: false })))
  })

  it('Select none then tapping rows builds a selection UP — the mode the exclusion list could not express', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(screen.getByTestId('sc-select-none'))
    await waitFor(() => expect(lastSel.committedCount).toBe(0))
    fireEvent.click(screen.getByText('Sun Gold'))
    fireEvent.click(screen.getByText('Jalapeno'))
    await waitFor(() => expect(lastSel.committedCount).toBe(2))
    expect(lastSel.excludedIds).not.toContain('t1')
    expect(lastSel.excludedIds).not.toContain('p2')
  })

  it('Select all shown reaches only the shown rows, never past the filter', async () => {
    render(<Harness />)
    await openList()
    fireEvent.click(screen.getByTestId('sc-select-none'))
    fireEvent.click(cropChip('Pepper'))
    await waitFor(() => expect(screen.getByTestId('sc-select-shown').textContent).toBe('Select all 4 shown'))
    fireEvent.click(screen.getByTestId('sc-select-shown'))
    await waitFor(() => expect(lastSel.committedCount).toBe(4))
  })

  // Select none moves the BASELINE, so plantings that arrive later from a widened scope also start
  // off. Without that, hand-picking three and then widening the zone would silently re-select the
  // whole new scope.
  it('after Select none, plantings that appear in a WIDER scope start unselected too', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ count: 4, capped: false, plantings: PLANTINGS.slice(5, 9) })
      .mockResolvedValue({ count: 12, capped: false, plantings: PLANTINGS })
    function Wide() {
      const [scope, setScope] = useState({ type: 'space', location_id: 'z1' })
      return (
        <ScopeChecklist
          scope={scope} onScopeChange={setScope} projects={[]}
          locations={[{ id: 'z1', name: 'Bag Area' }]}
          eventType="watering" eventDate="" verbLabel="watering"
          runDryRun={run} onSelectionChange={(s) => { lastSel = s }}
        />
      )
    }
    render(<Wide />)
    await openList()
    fireEvent.click(screen.getByTestId('sc-select-none'))
    fireEvent.click(screen.getByText('Jalapeno'))
    await waitFor(() => expect(lastSel.committedCount).toBe(1))
    fireEvent.click(screen.getByText('All active'))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(lastSel.committedCount).toBe(1))
  })
})

// The row's acceptance criterion is a NUMBER, so it is measured here rather than asserted in prose.
// Counts TAPS INSIDE THE SELECTOR ONLY (opening the page and choosing an event type are the same on
// both paths and are excluded from both sides), against the same 12-planting fixture.
describe('S1 — measured tap cost of logging three named plantings', () => {
  const countTaps = async (script) => {
    let taps = 0
    const tap = (el) => { taps += 1; fireEvent.click(el) }
    await script(tap)
    return taps
  }

  it('BEFORE (the shipped exclusion path): 1 + N-3 taps, no way to search', async () => {
    // The path that exists on origin/dev: open the list, then un-tick everything you do NOT want.
    // 12 plantings ⇒ 1 + 9 = 10. At the real garden size (239) it is 1 + 236 = 237.
    render(<Harness />)
    const taps = await countTaps(async (tap) => {
      tap(await screen.findByText(/Review \d+ plantings/))
      const keep = new Set(['Sun Gold', 'Jalapeno', 'Genovese'])
      for (const name of rowNames()) if (!keep.has(name)) tap(screen.getByText(name))
    })
    await waitFor(() => expect(lastSel.committedCount).toBe(3))
    expect(taps).toBe(10)
  })

  it('AFTER (search + Select none): 1 + 1 + 1 + 3 = 6 taps, and the count does not grow with the garden', async () => {
    // open list · Select none · ⌨ · then per planting: type (0 taps) + tap the row.
    // The only term that scales with garden size is the typing, and it is bounded by name length —
    // NOT by the 236 un-ticks the path above needs at 239 plantings. Zero scrolling: every step
    // leaves 1-2 rows on screen.
    render(<Harness />)
    const taps = await countTaps(async (tap) => {
      tap(await screen.findByText(/Review \d+ plantings/))
      tap(screen.getByTestId('sc-select-none'))
      tap(screen.getByTestId('sc-kb'))
      for (const [q, name] of [['sun gold', 'Sun Gold'], ['jala', 'Jalapeno'], ['genov', 'Genovese']]) {
        type(q)
        await waitFor(() => expect(rowNames()).toEqual([name]))
        tap(screen.getByText(name))
      }
    })
    await waitFor(() => expect(lastSel.committedCount).toBe(3))
    expect(taps).toBe(6)
    expect([...lastSel.excludedIds].sort()).toEqual(['b2', 'n1', 'p1', 'p3', 'p4', 't2', 't3', 't4', 't5'])
  })
})
