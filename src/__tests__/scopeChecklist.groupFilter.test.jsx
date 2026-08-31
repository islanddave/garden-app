// V4-LOGMANYUXREFRESH-001 S4 / BD-073 — the combined location × crop filter and crop-type grouping.
//
// BD-073 is three parts and S1 shipped only the first (crop chips). This file pins the other two,
// plus the bucket the row calls out by name:
//   (2) COMBINED FILTERS — "location AND crop type together, his example being 'bag area +
//       tomatoes', i.e. the INTERSECTION". Dave calls it "even better", so the row says to treat it
//       as the target rather than a stretch.
//   (3) GROUPING — "the selections should be parented under their crop types rather than only an
//       alphabetical otherwise ungrouped list."
//   THE NULL BUCKET — "plantings with no crop type must appear under an explicit Other or Ungrouped
//       heading in the grouped list, never be dropped — dropping them is the same silent-omission
//       class as [BUG-LOGMANYPROJECTLESS-001]." Measured on prod: 3 of 239.
//
// Fixture mirrors the measured prod SHAPE rather than a convenient one: a long tomato head, a
// second crop, a 2-tier location tree with a repeated child name across two zones (prod really has
// a Shade under Pasture and a Shade under Drive), plantings placed at BOTH tiers, and exactly three
// crop-type-less rows — the population an inner join or a keys-first grouping deletes silently.
//
// jsdom has no layout engine, so nothing here measures a pixel; the 390px geometry of the extra
// chip row and the group headers is measured in real Chrome by tests/harness/logmanypick.*.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(), getToken: vi.fn(async () => null) }) }))
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: vi.fn(async () => null),
  saveLogManyAllSelected: vi.fn(),
  saveHandedness: vi.fn(),
  HANDEDNESS_VALUES: ['right', 'left'],
}))

import ScopeChecklist from '../components/forms/ScopeChecklist.jsx'

// Pasture > Bag Area, Pasture > Shade, Drive > Shade, Deck (a childless zone).
const LOCATIONS = [
  { id: 'pasture', name: 'Pasture', parent_id: null, sort_order: 1 },
  { id: 'bag', name: 'Bag Area', parent_id: 'pasture', sort_order: 1 },
  { id: 'pshade', name: 'Shade', parent_id: 'pasture', sort_order: 2 },
  { id: 'drive', name: 'Drive', parent_id: null, sort_order: 2 },
  { id: 'dshade', name: 'Shade', parent_id: 'drive', sort_order: 1 },
  { id: 'deck', name: 'Deck', parent_id: null, sort_order: 3 },
]

const PLANTINGS = [
  // tomatoes: 3 in the Bag Area, 1 in Pasture itself, 1 on the Deck
  { id: 't1', name: 'Sun Gold', crop_type_slug: 'tomato', location_id: 'bag' },
  { id: 't2', name: 'San Marzano', crop_type_slug: 'tomato', location_id: 'bag' },
  { id: 't3', name: 'Black Krim', crop_type_slug: 'tomato', location_id: 'bag' },
  { id: 't4', name: 'Brandywine', crop_type_slug: 'tomato', location_id: 'pasture' },
  { id: 't5', name: 'Cherokee Purple', crop_type_slug: 'tomato', location_id: 'deck' },
  // peppers: 2 in the Bag Area, 1 in Drive > Shade
  { id: 'p1', name: 'Aji Dulce', crop_type_slug: 'pepper', location_id: 'bag' },
  { id: 'p2', name: 'Jalapeno', crop_type_slug: 'pepper', location_id: 'bag' },
  { id: 'p3', name: 'Shishito', crop_type_slug: 'pepper', location_id: 'dshade' },
  // basil: 1 in Pasture > Shade
  { id: 'b1', name: 'Genovese', crop_type_slug: 'basil', location_id: 'pshade' },
  // THE THREE. Prod's measured null bucket, reproduced exactly: no crop type at all. Two of them
  // also sit in a real zone, so they cannot be found "by accident" through the location axis only.
  { id: 'n1', name: 'Kousa Dogwood', crop_type_slug: null, location_id: 'deck' },
  { id: 'n2', name: 'Aloe Vera', crop_type_slug: null, location_id: 'bag' },
  { id: 'n3', name: 'Hydrangeas', crop_type_slug: null, location_id: null },
]

const dryRunOk = (rows = PLANTINGS) =>
  vi.fn(() => Promise.resolve({ count: rows.length, capped: false, plantings: rows }))

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

const enterPick = async () => {
  await screen.findByTestId('sc-mode-pick')
  fireEvent.click(screen.getByTestId('sc-mode-pick'))
  return screen.findByTestId('pick-frame')
}
// Every child of the list, in document order, tagged as a header or a row. Reading ORDER is the
// only way to prove "parented under" rather than "a header exists somewhere".
const listItems = () => [...document.querySelectorAll('[data-testid="pick-list"] > *')].map(li => {
  const tid = li.dataset.testid ?? ''
  if (tid.startsWith('pick-group-')) return { header: tid.slice('pick-group-'.length), text: li.textContent }
  const btn = li.querySelector('button[aria-pressed]')
  return btn ? { row: btn.dataset.testid.slice('pick-row-'.length) } : { other: tid }
})
const rowIds = () => listItems().filter(i => i.row).map(i => i.row)
const headers = () => listItems().filter(i => i.header).map(i => i.header)
// S5 — the same three readers, pointed at the BULK review list. Written as a parallel pair rather
// than one parameterised helper on purpose: if the two lists ever diverge, the diff has to be
// visible in the assertions, not hidden inside a shared query.
const openReview = async () => {
  fireEvent.click(await screen.findByText(/Review \d+ plantings/))
  return screen.findByTestId('sc-review-list')
}
const reviewItems = () => [...document.querySelectorAll('[data-testid="sc-review-list"] > *')].map(li => {
  const tid = li.dataset.testid ?? ''
  if (tid.startsWith('sc-group-')) return { header: tid.slice('sc-group-'.length), text: li.textContent }
  const btn = li.querySelector('button[aria-pressed]')
  return btn ? { row: btn.textContent.replace(/^[✓○]/, '') } : { other: tid }
})
const reviewRows = () => reviewItems().filter(i => i.row).map(i => i.row)
const reviewHeaders = () => reviewItems().filter(i => i.header).map(i => i.header)
const zoneChip = (label) => [...document.querySelectorAll('[data-testid="sc-zone-chips"] button')]
  .find(b => b.textContent.replace(/\s+/g, ' ').trim() === label)
const cropChip = (label) => [...document.querySelectorAll('[data-testid="sc-crop-chips"] button')]
  .find(b => b.textContent.replace(/\s+/g, ' ').trim() === label)
// The chip rows collapse behind `More`; expand before looking for a non-pinned chip.
const expandChips = (testid) => {
  const more = [...document.querySelectorAll(`[data-testid="${testid}"] button`)]
    .find(b => /^More/.test(b.textContent))
  if (more) fireEvent.click(more)
}
const type = (v) => fireEvent.change(screen.getByTestId('sc-search'), { target: { value: v } })

beforeEach(() => { lastSel = null; try { localStorage.clear() } catch (e) { /* private mode */ } })
afterEach(() => cleanup())

// ══ BD-073 (3) — GROUPING, and the bucket that must never vanish ═══════════════════════════════
describe('S4 — the candidate list is parented under crop types', () => {
  it('renders a header per crop type, each immediately followed by its own rows', async () => {
    render(<Harness />)
    await enterPick()
    const items = listItems()
    // Walk the list and attribute every row to the header above it. This is the actual claim —
    // "a header exists" and "the rows sit under the right one" are different assertions and only
    // the second one is grouping.
    const under = {}
    let current = null
    for (const it of items) {
      if (it.header) { current = it.header; under[current] = []; continue }
      if (it.row) under[current] = [...(under[current] ?? []), it.row]
    }
    expect(under.tomato).toEqual(['t4', 't3', 't5', 't1', 't2'].sort((a, b) => {
      const name = id => PLANTINGS.find(p => p.id === id).name
      return name(a).localeCompare(name(b))
    }))
    expect(under.pepper.sort()).toEqual(['p1', 'p2', 'p3'])
    expect(under.basil).toEqual(['b1'])
    // No row is ever orphaned above the first header.
    expect(under.null).toBeUndefined()
    expect(under.undefined).toBeUndefined()
  })

  it('every crop-type-less planting lands in an explicit Ungrouped bucket — none is dropped', async () => {
    render(<Harness />)
    await enterPick()
    const items = listItems()
    const i = items.findIndex(x => x.header === '__ungrouped__')
    expect(i, 'no Ungrouped header rendered').toBeGreaterThan(-1)
    expect(items[i].text).toMatch(/^Ungrouped/)
    // All three, and only the three.
    const after = items.slice(i + 1).filter(x => x.row).map(x => x.row)
    expect(after.sort()).toEqual(['n1', 'n2', 'n3'])
    // The number that matters: the list still holds EVERY planting the preview returned.
    expect(rowIds()).toHaveLength(PLANTINGS.length)
  })

  it('Ungrouped sorts LAST even when its crop band would put it first', async () => {
    // A single-crop-type garden plus the null bucket: `bandRank` has no entry for the Ungrouped
    // pseudo-slug, and a naive comparator that fell back to alphabetical would put "Ungrouped"
    // before "Tomato". A fallback bucket at the top of a chooser is noise where the answer is.
    const rows = [
      ...PLANTINGS.filter(p => p.crop_type_slug === 'tomato'),
      ...PLANTINGS.filter(p => p.crop_type_slug === null),
      { id: 'z1', name: 'Zucchini One', crop_type_slug: 'zucchini', location_id: 'deck' },
      { id: 'a1', name: 'Arugula One', crop_type_slug: 'arugula', location_id: 'deck' },
    ]
    render(<Harness runDryRun={dryRunOk(rows)} />)
    await enterPick()
    expect(headers().at(-1)).toBe('__ungrouped__')
  })

  it('the header states the group size, so 46 tomatoes announce themselves', async () => {
    render(<Harness />)
    await enterPick()
    expect(screen.getByTestId('pick-group-tomato').textContent).toMatch(/Tomato\s*5/)
    expect(screen.getByTestId('pick-group-__ungrouped__').textContent).toMatch(/Ungrouped\s*3/)
  })

  it('a header is not a list item to a screen reader', async () => {
    render(<Harness />)
    await enterPick()
    expect(screen.getByTestId('pick-group-tomato').getAttribute('role')).toBe('presentation')
  })

  it('groups follow the FILTER — an empty crop group disappears rather than showing a bare header', async () => {
    render(<Harness />)
    await enterPick()
    type('jalapeno')
    expect(headers()).toEqual(['pepper'])
    expect(rowIds()).toEqual(['p2'])
  })
})

// ══ S5 — THE SAME GROUPING ON THE BULK REVIEW LIST ═════════════════════════════════════════════
// S4 grouped the PICK list and deliberately left this one flat, on a measured density argument: the
// review list is a `maxHeight: 240` panel and 28px headers eat a large share of it. Dave was given
// that measurement and overruled it — "Group it too — I want consistency" — so the cost is accepted
// and these pin the ruling. Every test here FAILS against S4's code; that is the point of the file.
describe('S5 — the BULK review list is grouped by the same rule as the pick list', () => {
  it('renders a header per crop type, each immediately followed by its own rows', async () => {
    render(<Harness />)
    await openReview()
    const under = {}
    let current = null
    for (const it of reviewItems()) {
      if (it.header) { current = it.header; under[current] = []; continue }
      if (it.row) under[current] = [...(under[current] ?? []), it.row]
    }
    expect(under.tomato).toEqual(['Black Krim', 'Brandywine', 'Cherokee Purple', 'San Marzano', 'Sun Gold'])
    expect(under.pepper).toEqual(['Aji Dulce', 'Jalapeno', 'Shishito'])
    expect(under.basil).toEqual(['Genovese'])
    // Nothing orphaned above the first header — the shape a `{shown.map()}` left in place beside a
    // grouped block would produce, and the one that still LOOKS grouped in a screenshot.
    expect(under.null).toBeUndefined()
    expect(under.undefined).toBeUndefined()
  })

  it('the three crop-type-less plantings land in an explicit Ungrouped bucket here too', async () => {
    render(<Harness />)
    await openReview()
    const items = reviewItems()
    const i = items.findIndex(x => x.header === '__ungrouped__')
    expect(i, 'no Ungrouped header in the review list').toBeGreaterThan(-1)
    expect(items[i].text).toMatch(/^Ungrouped/)
    expect(items.slice(i + 1).filter(x => x.row).map(x => x.row).sort())
      .toEqual(['Aloe Vera', 'Hydrangeas', 'Kousa Dogwood'])
    // The number that matters on BOTH lists: every planting the preview returned is still here.
    expect(reviewRows()).toHaveLength(PLANTINGS.length)
  })

  it('a header is not a list item to a screen reader', async () => {
    render(<Harness />)
    await openReview()
    expect(screen.getByTestId('sc-group-tomato').getAttribute('role')).toBe('presentation')
    expect(screen.getByTestId('sc-group-tomato').textContent).toMatch(/Tomato\s*5/)
  })

  // THE COST PIN — grafted from the parallel lane-bd073group-20260831 build of this same ruling,
  // which is the one thing that branch had and this one did not (OPS-BD073GROUPING-001).
  //
  // Dave ruled FOR grouping against a quoted ~40% of the review panel, and the measured cost came in
  // at 11.7% at the top / 35.0% in the densest window. That trade is only honoured while the window
  // stays 240px. The obvious future "fix" for a review list that feels cramped is to grow the
  // scrollport — which silently converts the cost he accepted into a different one he never saw, and
  // leaves every prose record of the decision still reading true. A comment cannot stop that edit;
  // this assertion can. The headings must come OUT of the 240px, not be paid for by enlarging it.
  it('the 240px window is unchanged — the headings come out of it, which is the accepted cost', async () => {
    render(<Harness />)
    const list = await openReview()
    expect(list.style.maxHeight).toBe('240px')
    expect(list.style.overflowY).toBe('auto')
    expect(list.querySelectorAll('[data-testid^="sc-group-"]').length).toBeGreaterThan(0)
  })

  // THE ANTI-DRIFT PIN, and the reason the grouping is one shared component rather than two
  // implementations. Dave's word was "consistency": these two lists are one tap apart, so a
  // difference in the header set, its order, or the row order underneath it is visible in the same
  // sitting. Two independent copies would agree on the day they were written and not much after.
  it('the review list and the pick list agree on the headers AND on the rows under them', async () => {
    render(<Harness />)
    await openReview()
    const bulkHeaders = reviewHeaders()
    const bulkRows = reviewRows()
    fireEvent.click(screen.getByTestId('sc-mode-pick'))
    await screen.findByTestId('pick-frame')
    expect(headers()).toEqual(bulkHeaders)
    expect(rowIds().map(id => PLANTINGS.find(p => p.id === id).name)).toEqual(bulkRows)
  })

  it('groups follow the filter — an empty crop group disappears rather than showing a bare header', async () => {
    render(<Harness />)
    await openReview()
    fireEvent.change(screen.getByTestId('sc-search'), { target: { value: 'jalapeno' } })
    expect(reviewHeaders()).toEqual(['pepper'])
    expect(reviewRows()).toEqual(['Jalapeno'])
  })

  // Grouping is PRESENTATION. The one thing it must not touch is the batch — the invariant S1
  // established and the class BUG-LOGMANYPROJECTLESS-001 was filed under.
  it('grouping changes what the list looks like, never what is committed', async () => {
    render(<Harness />)
    await openReview()
    expect(lastSel.committedCount).toBe(PLANTINGS.length)
    expect(lastSel.excludedIds).toEqual([])
    fireEvent.click(screen.getByText('Aloe Vera'))          // a row inside the Ungrouped bucket
    expect(lastSel.excludedIds).toEqual(['n2'])
    expect(lastSel.committedCount).toBe(PLANTINGS.length - 1)
  })
})

// ══ BD-073 (2) — THE COMBINED FILTER ═══════════════════════════════════════════════════════════
describe('S4 — location × crop type, ANDed', () => {
  it('offers zone chips built from where the candidates actually are', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    const labels = [...document.querySelectorAll('[data-testid="sc-zone-chips"] button')]
      .map(b => b.textContent.replace(/\s+/g, ' ').trim())
    // Zones AND sub-locations, each disambiguated by its zone — prod has two different "Shade"s
    // and a bare child name would render one chip for two places.
    // A unique child name stands alone; the two "Shade"s carry their zone. Prefixing everything
    // cost the candidate list 3 lines of chip row at 390px — see locLabelOf's comment.
    expect(labels).toEqual(expect.arrayContaining([
      'Pasture', 'Bag Area', 'Pasture > Shade', 'Drive', 'Drive > Shade', 'Deck',
    ]))
    expect(labels).not.toContain('Pasture > Bag Area')
    // The location axis has its own null bucket for the same reason the crop axis does.
    expect(labels).toEqual(expect.arrayContaining(['No zone']))
  })

  it('DAVE\'S EXAMPLE: bag area + tomatoes returns the intersection, not the union', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Bag Area'))
    expandChips('sc-crop-chips')
    fireEvent.click(cropChip('Tomato'))
    // 3 tomatoes in the Bag Area. NOT the 5 tomatoes, NOT the 6 things in the Bag Area, and not
    // the 8 that are either — a union would be the natural bug and would look plausible on screen.
    expect(rowIds().sort()).toEqual(['t1', 't2', 't3'])
    expect(headers()).toEqual(['tomato'])
  })

  it('a ZONE chip keeps its sub-locations\' plantings (the descendant cascade, client side)', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Pasture'))
    // Pasture itself (t4), Bag Area (t1,t2,t3,p1,p2,n2) and Pasture > Shade (b1). NOT Drive >
    // Shade's pepper, which is the mutation an ancestor walk that stopped at one level would make.
    expect(rowIds().sort()).toEqual(['b1', 'n2', 'p1', 'p2', 't1', 't2', 't3', 't4'])
  })

  it('two zone chips are ORed within the axis while still ANDing against crop', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Deck'))
    // FilterChipRow COLLAPSES its tray on selecting a tray-only chip (its own BD-011 rider), so a
    // second chip on the same axis needs a second expand. Reproduced here rather than worked
    // around, because it is the real cost of a second axis on this row and it is what Dave will
    // feel: "bag area + tomatoes" is expand, tap, expand, tap.
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Drive > Shade'))
    expect(rowIds().sort()).toEqual(['n1', 'p3', 't5'])
    expandChips('sc-crop-chips')
    fireEvent.click(cropChip('Tomato'))
    expect(rowIds()).toEqual(['t5'])
  })

  it('the two Shades are two chips — the disambiguating prefix is load-bearing, not cosmetic', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Drive > Shade'))
    expect(rowIds()).toEqual(['p3'])       // and NOT b1, which is in Pasture > Shade
  })

  it('a location-less planting stays reachable through an explicit No zone chip', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('No zone'))
    expect(rowIds()).toEqual(['n3'])
  })

  it('the hidden-count note counts the zone filter too — no filter narrows silently', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Deck'))
    expect(screen.getByTestId('sc-shown-note').textContent)
      .toBe(`Showing 2 of ${PLANTINGS.length} — ${PLANTINGS.length - 2} hidden by filters`)
  })

  // The filters narrow the VIEW, never the batch — the safety property S1 established and the one
  // an added axis is most likely to break.
  it('a zone filter does not deselect anything', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t5'))       // Cherokee Purple, on the Deck
    fireEvent.click(screen.getByTestId('pick-row-b1'))       // Genovese, in Pasture > Shade
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Deck'))
    expect(lastSel.committedCount).toBe(2)
    expect(lastSel.includedIds.sort()).toEqual(['b1', 't5'])
    // …and the hidden one is still in the tray, which is the (d) guarantee on the new axis.
    expect(document.querySelector('[data-testid="pick-chip-b1"]')).not.toBeNull()
  })

  it('switching back to BULK clears the zone filter — it has no control there to undo it', async () => {
    render(<Harness />)
    await enterPick()
    expandChips('sc-zone-chips')
    fireEvent.click(zoneChip('Deck'))
    fireEvent.click(screen.getByTestId('pick-done'))
    fireEvent.click(screen.getByTestId('sc-mode-bulk'))
    fireEvent.click(screen.getByText(/Review \d+ plantings/))
    expect(screen.getByTestId('sc-shown-note').textContent).toBe(`Showing all ${PLANTINGS.length}`)
  })

  it('no zone chips when the candidates share one place — a one-chip filter only removes rows', async () => {
    const rows = PLANTINGS.map(p => ({ ...p, location_id: 'deck' }))
    render(<Harness runDryRun={dryRunOk(rows)} />)
    await enterPick()
    expect(document.querySelector('[data-testid="sc-zone-chips"]')).toBeNull()
  })

  it('survives a location tree the client never loaded — the rows are still all there', async () => {
    // The zone axis is the one thing here that depends on a SECOND fetch (/api/locations). If it
    // fails or lags, chainOf returns [] for every planting and the filter must degrade to absent,
    // never to an empty list.
    render(<Harness locations={[]} />)
    await enterPick()
    expect(document.querySelector('[data-testid="sc-zone-chips"]')).toBeNull()
    expect(rowIds()).toHaveLength(PLANTINGS.length)
    expect(headers()).toContain('__ungrouped__')
  })
})

// ══ The positive selection, lifted to the parent ═══════════════════════════════════════════════
describe('S4 — includedIds is the exact complement of excludedIds', () => {
  it('the two halves partition the preview and neither is derived from the other', async () => {
    render(<Harness />)
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-t1'))
    fireEvent.click(screen.getByTestId('pick-row-p3'))
    expect(lastSel.includedIds.sort()).toEqual(['p3', 't1'])
    expect(lastSel.includedIds.length + lastSel.excludedIds.length).toBe(PLANTINGS.length)
    expect(lastSel.includedIds.some(id => lastSel.excludedIds.includes(id))).toBe(false)
    // The number on the commit button is total − excluded; includedIds is what will actually be
    // POSTed. If those two ever disagree the button lies about the batch.
    expect(lastSel.committedCount).toBe(lastSel.includedIds.length)
  })

  it('BULK produces it too — everything kept, minus what was skipped', async () => {
    render(<Harness />)
    fireEvent.click(await screen.findByText(/Review \d+ plantings/))
    fireEvent.click(screen.getByText('Sun Gold'))
    expect(lastSel.excludedIds).toEqual(['t1'])
    expect(lastSel.includedIds).toHaveLength(PLANTINGS.length - 1)
    expect(lastSel.includedIds).not.toContain('t1')
  })
})
