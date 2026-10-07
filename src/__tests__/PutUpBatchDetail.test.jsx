// V5-KBCLOSE-001 — one batch, opened: what went in, what happened to it, what came out.
//
// ⚠ THIS FILE IS THE NEW SURFACE'S OWN SWEEP, and that is the point. Every food-safety and readiness
// sweep this repo ships is scoped to `screen.getByTestId('going-now-view')`; copy that moves here is
// unguarded by all of them AND they stay green, so nothing signals it. The sweeps below run over
// `batch-detail-view` and every arm carries a green control on the SAME render.
//
// ⚠ THE STAGE-LOG RULING, which is narrower than "render the log" and easy to get wrong:
//   Every pH reading is written as stage_kind='tended', so labelling a row by its kind renders a
//   ferment checked eight times as eight identical "Tended" lines — an unbroken run of absent
//   failure signs, drawn as a list instead of counted. A row carrying a reading therefore leads with
//   THE READING and the time it was READ. And: no count, no "N stages" header, no tick or check
//   glyph, no filtered pH-only sub-view — four pH numbers alone in a column is a series, and a
//   series is a trend.
//
// ⚠ THE `spoil` ARM FROM THE CARD'S SWEEP IS DELIBERATELY NOT COPIED. "It spoiled — threw it out" is
// the FINAL adjudicated label for `discarded_spoiled` and reading a closed batch back is this
// surface's job. The arm that replaces it is stricter and is the one that matters: no RAW OUTCOME
// VALUE reaches the DOM.
//
// TEST-SHAPE RULES: `now` INJECTED, never the wall clock. FIXED ZONELESS LOCAL LITERALS through
// `local()`, and timestamptz instants at NOON UTC — 16:00Z looked safe, covered both CI lanes, and
// flipped a day in Tokyo. FULL LITERALS on every joined line.
//
// CI LANE: `npm test` (vitest run --coverage) plus the blocking TZ=America/New_York re-run, which
// has real assertions to bite on here (every rendered date).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import { P } from '../lib/constants.js'
import BatchDetailView, { inputRowText, stageRowText, stageRowDetail, outputRowText } from '../components/putup/BatchDetailView.jsx'
import { CLOSE_OUTCOMES } from '../components/putup/batchClose.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')
const read = (rel) => readFileSync(resolve(REPO, rel), 'utf8')

const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const ALARM_INKS = [P.terra, P.warnBorder, P.severityUrgent].map(toRgb)
const hasNoAlarmInk = (el) => ALARM_INKS.every(ink => !el.outerHTML.includes(ink))

const NOW = new Date('2026-09-04T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const FIRST_RECORDED_SEP_3 = '2026-09-03T12:00:00.000Z'

// The pepper mash that drove the schema: no start anyone remembers, NEVER ASKED, kind null, and the
// measured fan-in of 139 harvest_log rows.
const MASH = {
  id: 'kb-mash', user_id: 'user_dave', label: 'Pepper mash', kind: null, kind_other: null,
  started_at: null, start_precision: null, first_recorded_at: FIRST_RECORDED_SEP_3,
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null,
  current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: FIRST_RECORDED_SEP_3, input_count: '139', output_count: '0',
}
const CANDY = {
  ...MASH, id: 'kb-candy', label: 'Candied ginger', kind: 'candy',
  started_at: local('2026-08-23T09:00:00'), start_precision: 'day',
  current_stage_kind: 'tended', current_stage_label: 'Syrup rung 2',
  current_stage_entered_at: local('2026-09-02T09:00:00'),
}
const PAUSED = { ...MASH, id: 'kb-paused', label: 'Frozen candy parent', suspended_at: FIRST_RECORDED_SEP_3 }
// Every close now writes a `finished` stage row server-side, so a closed batch ALWAYS carries
// current_stage_kind 'finished' — and it keeps it through a reopen, because stage order is
// deliberately non-monotonic and nothing rewrites history. Both fixtures below therefore carry it;
// open-vs-closed is read from closed_at and from nothing else.
const CLOSED_SPOILED = {
  ...MASH, id: 'kb-spoiled', label: 'Reaper mash', kind: 'ferment',
  closed_at: '2026-09-04T12:00:00.000Z', outcome: 'discarded_spoiled', outcome_note: 'went furry on top',
  current_stage_kind: 'finished', current_stage_entered_at: '2026-09-04T12:00:00.000Z',
}
const REOPENED = {
  ...MASH, id: 'kb-reopened', label: 'Reaper mash', kind: 'ferment',
  closed_at: null, outcome: null, outcome_note: null,
  current_stage_kind: 'finished', current_stage_entered_at: '2026-09-04T12:00:00.000Z',
}
const CLOSED_UNKNOWN_OUTCOME = {
  ...MASH, id: 'kb-future', closed_at: '2026-09-04T12:00:00.000Z', outcome: 'became_a_second_batch',
}
// The two-user pair. A single-owner fixture cannot fail an ownership bug in a two-person household.
const JEN_CLOSED = {
  ...MASH, id: 'kb-jen', user_id: 'user_jen', label: "Jen's plum butter", kind: 'candy',
  closed_at: '2026-09-04T12:00:00.000Z', outcome: 'put_up', outcome_note: null, output_count: '2',
}

const INPUT_HARVEST = {
  id: 'kbi-1', batch_id: 'kb-mash', input_kind: 'harvest', harvest_log_id: 'hl-1',
  label: null, qty: null, qty_unit: null, is_byproduct: false, added_at: FIRST_RECORDED_SEP_3,
}
const INPUT_PANTRY = {
  id: 'kbi-2', batch_id: 'kb-mash', input_kind: 'pantry', harvest_log_id: null,
  label: 'Kosher salt', qty: '40', qty_unit: 'g', is_byproduct: false, added_at: FIRST_RECORDED_SEP_3,
}
const INPUT_OFFCUT = {
  id: 'kbi-3', batch_id: 'kb-mash', input_kind: 'harvest', harvest_log_id: 'hl-2',
  label: null, qty: null, qty_unit: null, is_byproduct: true, added_at: FIRST_RECORDED_SEP_3,
}

const STAGE_PH = {
  id: 'ksl-1', batch_id: 'kb-mash', stage_kind: 'tended', label: null, cue_observed: null,
  entered_at: '2026-09-03T12:00:00.000Z', ph_reading: '4.60', ph_read_at: '2026-09-02T12:00:00.000Z', note: null,
}
const STAGE_PH_2 = {
  ...STAGE_PH, id: 'ksl-2', ph_reading: '5.20', ph_read_at: '2026-09-01T12:00:00.000Z',
  entered_at: '2026-09-01T12:00:00.000Z',
}
const STAGE_FINISHED = {
  id: 'ksl-3', batch_id: 'kb-mash', stage_kind: 'finished', label: null,
  cue_observed: 'snapped clean', entered_at: '2026-09-04T12:00:00.000Z',
  ph_reading: null, ph_read_at: null, note: null,
}
const STAGE_STARTED = {
  id: 'ksl-4', batch_id: 'kb-mash', stage_kind: 'started', label: null, cue_observed: null,
  entered_at: FIRST_RECORDED_SEP_3, ph_reading: null, ph_read_at: null, note: null,
}

// THE REAL PROJECTION, column for column, from GET /:id's explicit SELECT — use_by_target and
// use_by_status are deliberately absent from it, on the same shelf-stability-endorsement reasoning
// that keeps them off the jar picker.
const OUTPUT_JAR = {
  id: 'pl-1', batch_id: 'kb-mash', user_id: 'user_dave', crop_type_slug: 'pepper', variety_id: null,
  plant_id: null, harvest_log_id: null, preserved_at: '2026-08-12', preserved_at_approx: null,
  method: 'hot_sauce', method_other_text: null, quantity_value: '3', quantity_unit: 'pint',
  package_count: 3, storage_location_id: null, remaining_count: 3, consumed_at: null, notes: null,
  photo_id: null, created_at: '2026-08-12T12:00:00.000Z', updated_at: '2026-08-12T12:00:00.000Z',
}
// The same jar as it would arrive if a future widening put the two suppressed columns back on the
// projection. The surface must still refuse to render them — a suppression that only holds because
// the data is absent is not a suppression, it is a coincidence.
const OUTPUT_JAR_WIDENED = { ...OUTPUT_JAR, use_by_target: '2026-11-12', use_by_status: 'use_soon' }

const detailEl = (props = {}) => (
  <BatchDetailView
    batch={MASH} inputs={[]} stages={[]} outputs={[]}
    loading={false} error={false} nowMs={NOW} onChanged={vi.fn()}
    {...props}
  />
)
function renderDetail(props = {}) {
  return render(detailEl(props))
}

// THE ONE CALL THE CONTROLLED CONTRACT FORBIDS: `/api/kitchen-batches/{id}` with no suffix, which is
// the page's own read. Deliberately narrower than "the spy was never called" — the hosted inputs
// field fetches the crop vocabulary its add flow offers, and a child reading for its own ACTION is
// not this surface re-reading its own DATA. The over-broad form would have to be deleted the first
// time any child grew a door, which is how a guard stops being about anything.
// Release F: `line-search` is a LITERAL route the Lambda matches before any :id capture (contract-F
// §2.2), never a batch id — so it is not the page's read, and the pattern says so.
const batchGets = () => fetchMock.mock.calls.filter(
  ([path, opts]) => /^\/api\/kitchen-batches\/(?!line-search\b)[^/?]+$/.test(String(path)) && (opts?.method ?? 'GET') === 'GET',
)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ group_by: 'crop', groups: [] })
})

describe('BatchDetailView — the three non-batch states', () => {
  it('says it is opening rather than rendering an empty shell', () => {
    renderDetail({ loading: true })
    expect(screen.getByTestId('batch-detail-loading').textContent).toBe('Opening that batch…')
    expect(screen.queryByTestId('batch-detail-title')).toBeNull()
  })

  it('surfaces a load failure as an alert', () => {
    renderDetail({ error: true })
    expect(screen.getByTestId('batch-detail-error').textContent).toBe('Couldn’t open that batch.')
  })

  it('says a missing batch is gone, and does not blame the reader for it', () => {
    renderDetail({ batch: null })
    expect(screen.getByTestId('batch-detail-missing').textContent).toBe('That batch isn’t here any more.')
  })
})

describe('BatchDetailView — the header', () => {
  it('leads with the honest floor when nobody ever recorded a start', () => {
    renderDetail()
    expect(screen.getByTestId('batch-detail-title').textContent).toBe('Pepper mash')
    expect(screen.getByTestId('batch-detail-meta').textContent).toBe('first recorded Sep 3')
  })

  // AMENDED FOR THE PUT-UP UX PASS R1 (D15) in the same commit as the change: the kind leads the line, in
  // its chip's word. A batch with no kind (the mash above) reads exactly as it did.
  it('leads with the kind, then elapsed time and the last touch, when there IS a start', () => {
    renderDetail({ batch: CANDY })
    expect(screen.getByTestId('batch-detail-meta').textContent)
      .toBe('Candy · 12 days · Syrup rung 2 · last touched 2 days ago')
  })

  it('renders paused as a different answer, not a worse one', () => {
    renderDetail({ batch: PAUSED })
    expect(screen.getByTestId('batch-detail-paused').textContent).toBe('Paused since Sep 3')
    expect(hasNoAlarmInk(screen.getByTestId('batch-detail-paused'))).toBe(true)
  })

  // AMENDED FOR THE PUT-UP UX PASS R1 (D3) in the same commit as the change, here and in the four arms
  // below it: the outcome line is the SAME string the closed list's row says for the batch — the date
  // first, then the ending (closedEnding). Every label is unchanged; only "Put it up" is left out, and
  // only where a count beside it already says so.
  it('reads a closed batch back as a past fact, with its date and its note', () => {
    renderDetail({ batch: CLOSED_SPOILED })
    expect(screen.getByTestId('batch-detail-outcome').textContent).toBe('closed Sep 4 · It spoiled — threw it out')
    expect(screen.getByTestId('batch-detail-outcome-note').textContent).toBe('went furry on top')
  })

  it('renders a peer\'s closed batch identically — scoping is the server\'s job', () => {
    renderDetail({ batch: JEN_CLOSED })
    expect(screen.getByTestId('batch-detail-title').textContent).toBe("Jen's plum butter")
    expect(screen.getByTestId('batch-detail-outcome').textContent).toBe('closed Sep 4 · 2 put-ups')
    expect(screen.queryByTestId('batch-detail-outcome-note')).toBeNull()
    // GREEN CONTROL for that absence, one render apart: the note DOES render when there is one.
    renderDetail({ batch: CLOSED_SPOILED })
    expect(screen.getByTestId('batch-detail-outcome-note').textContent).toBe('went furry on top')
  })

  it('says nothing about an outcome while the batch is still going', () => {
    renderDetail()
    expect(screen.queryByTestId('batch-detail-outcome')).toBeNull()
    expect(screen.queryByTestId('batch-detail-paused')).toBeNull()
  })

  it('falls back without echoing an outcome value this bundle has never seen', () => {
    renderDetail({ batch: CLOSED_UNKNOWN_OUTCOME })
    expect(screen.getByTestId('batch-detail-outcome').textContent).toBe('closed Sep 4 · Closed')
    expect(screen.getByTestId('batch-detail-view').innerHTML).not.toContain('became_a_second_batch')
  })
})

// ⚠ L4's BatchInputsField OWNS this section since 20260904, so every arm below asserts over ITS
// testids. The two lanes each built the read-only half — a count, a reveal, a list — and mounting
// both shipped two of each on one screen. L4's is the superset (it also removes a row and adds one),
// so the subset went and these tests follow the surviving surface rather than being deleted with it.
// ⚠ AMENDED FOR RELEASE F in the same commit as the change (06 §4 item 3; V4 §8.3). What went in is the
// reworked field (WhatWentIn.jsx): every line written from F on is ALWAYS visible, and the count-and-
// reveal stays only for LEGACY bulk pick rows (a 'harvest' line with no ordinal — the shipped predicate
// path's "whole pick"). The rulings these tests were written for still hold and are still asserted: one
// surface, one list, no roll-up over qty, controlled (no re-read of the batch), shape-tolerant.
// Fixtures: INPUT_PANTRY is not a pick, so it is a visible line; INPUT_HARVEST and INPUT_OFFCUT are
// legacy picks (no ordinal).
describe('BatchDetailView — what went in', () => {
  it('shows every line, and keeps 139-row legacy picks behind a count until asked for', () => {
    renderDetail({ inputs: [INPUT_HARVEST, INPUT_PANTRY, INPUT_OFFCUT] })
    expect(within(screen.getByTestId('what-went-in-list')).getAllByTestId('line-row-text').map(n => n.textContent)).toEqual(['Kosher salt · 40 g'])
    expect(screen.getByTestId('batch-inputs-count').textContent).toBe('2 picks added before — each counts the whole pick.')
    expect(screen.queryByTestId('batch-inputs-list')).toBeNull()
    // GREEN CONTROL: the same render carries the door, so the absence is "behind a tap", not "absent".
    expect(screen.getByTestId('batch-inputs-reveal').textContent).toBe('Show all 2')
  })

  it('says so when nothing is written down, and offers no legacy door when there are no legacy picks', () => {
    renderDetail({ inputs: [INPUT_PANTRY] })
    expect(screen.queryByTestId('batch-inputs-count')).toBeNull()
    expect(screen.queryByTestId('batch-inputs-reveal')).toBeNull()
    renderDetail({ inputs: [] })
    expect(screen.getByTestId('what-went-in-empty').textContent).toBe('Nothing written down yet.')
  })

  it('opens the legacy picks on a second tap, and a bare pick says it claims the whole thing', () => {
    renderDetail({ inputs: [INPUT_HARVEST, INPUT_PANTRY, INPUT_OFFCUT] })
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    const rows = within(screen.getByTestId('batch-inputs-list')).getAllByRole('listitem').map(n => n.textContent)
    // A NULL qty pair is not zero — the DDL idiom is "unrecorded, assume THE WHOLE THING" — and it is
    // said on the row itself.
    expect(rows).toEqual([
      'A pick from the garden — the whole pickTake it out',
      'A pick from the garden — the whole pick · trimmings, counted elsewhereTake it out',
    ])
    expect(screen.getByTestId('batch-inputs-reveal').textContent).toBe('Hide the list')
  })

  it('renders no roll-up over qty — inputs[] carries no weight and the units do not add up', () => {
    renderDetail({ inputs: [INPUT_HARVEST, INPUT_PANTRY, INPUT_OFFCUT] })
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    const html = screen.getByTestId('batch-detail-inputs').innerHTML
    expect(html).not.toMatch(/\btotal\b/i)
    expect(html).not.toContain('40 g total')
    // GREEN CONTROL: the per-row amount IS on screen, so the arms above are about the aggregate.
    expect(html).toContain('40 g')
  })

  it('follows the page when it re-reads after a write, and still never reads the batch itself', () => {
    const LINE = { ...INPUT_PANTRY, id: 'kbi-9', input_kind: 'other', label: 'Water', qty: '250', qty_unit: 'ml', role: 'water', ordinal: 1 }
    const { rerender } = renderDetail({ inputs: [INPUT_PANTRY] })
    expect(screen.getAllByTestId('line-row-text')).toHaveLength(1)
    rerender(detailEl({ inputs: [INPUT_PANTRY, LINE] }))
    expect(screen.getAllByTestId('line-row-text').map(n => n.textContent)).toEqual(['Kosher salt · 40 g', 'Water · 250 ml'])
    expect(batchGets()).toEqual([])
  })

  it('renders the inputs surface exactly ONCE — one list of lines, one legacy count, one door', () => {
    renderDetail({ inputs: [INPUT_HARVEST, INPUT_PANTRY, INPUT_OFFCUT] })
    const section = screen.getByTestId('batch-detail-inputs')
    const ids = [...section.querySelectorAll('[data-testid]')].map(n => n.dataset.testid)
    expect(ids.filter(id => /(inputs-(count|toggle|reveal|list)|what-went-in-list)$/.test(id)))
      .toEqual(['what-went-in-list', 'batch-inputs-count', 'batch-inputs-reveal'])
    expect(section.textContent.match(/(?<!\d)\d+ (things?|picks?) (went in|written down|added before)/g))
      .toEqual(['2 picks added before'])
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    expect(within(section).getAllByRole('list')).toHaveLength(2)
  })

  it('names every input kind the schema allows', () => {
    expect(inputRowText({ input_kind: 'harvest' })).toBe('Pick')
    expect(inputRowText({ input_kind: 'purchased', label: 'Bag of limes' })).toBe('Bought · Bag of limes')
    expect(inputRowText({ input_kind: 'pantry', label: 'Salt' })).toBe('Pantry · Salt')
    expect(inputRowText({ input_kind: 'other', label: 'Starter' })).toBe('Other · Starter')
    expect(inputRowText({ input_kind: 'a_kind_from_the_future' })).toBe('Input')
    expect(inputRowText(null)).toBe('')
  })
})

describe('BatchDetailView — the log is a log', () => {
  it('leads a reading row with THE READING and when it was read, never with the stage kind', () => {
    renderDetail({ stages: [STAGE_PH] })
    const row = screen.getByTestId('batch-detail-stage')
    expect(row.textContent).toBe('pH 4.60 · read Sep 2')
    expect(row.textContent).not.toContain('Tended')
    // GREEN CONTROL: a non-reading row on the same component DOES render its kind, so the absence
    // above is the rule and not a component that never labels anything.
    renderDetail({ stages: [STAGE_STARTED] })
    expect(screen.getAllByTestId('batch-detail-stage')[1].textContent).toBe('Started · Sep 3')
  })

  it('keeps the reading verbatim — a trailing zero the meter showed survives', () => {
    renderDetail({ stages: [STAGE_PH] })
    expect(screen.getByTestId('batch-detail-stage').textContent).toContain('4.60')
    expect(screen.getByTestId('batch-detail-stage').textContent).not.toContain('4.6 ')
  })

  it('renders ONE interleaved chronology in the server\'s order, never a pH-only sub-view', () => {
    renderDetail({ stages: [STAGE_FINISHED, STAGE_PH, STAGE_PH_2, STAGE_STARTED] })
    expect(screen.getAllByTestId('batch-detail-stage').map(n => n.textContent)).toEqual([
      'Finished · Sep 4snapped clean',
      'pH 4.60 · read Sep 2',
      'pH 5.20 · read Sep 1',
      'Started · Sep 3',
    ])
  })

  it('carries no count, no summary header, and no tick over the log', () => {
    renderDetail({ stages: [STAGE_FINISHED, STAGE_PH, STAGE_PH_2, STAGE_STARTED] })
    // textContent, not innerHTML, and deliberately — the sibling sweep in PutUpPhReading.test.jsx
    // makes the same choice for the same reason: a testid is a machine value, not a claim, and
    // `batch-detail-stages-list` is not the app telling anyone there are four stages.
    const text = screen.getByTestId('batch-detail-stages').textContent
    expect(text).not.toMatch(/\b\d+ stages\b|\bstages\b|\bchecks\b|\bstreak\b|\bin a row\b/i)
    expect(text).not.toMatch(/[✓✔☑√]/)
    // GREEN CONTROLS: the four rows ARE on screen and the section IS titled, so the arms above swept
    // a populated log rather than an empty one.
    expect(screen.getAllByTestId('batch-detail-stage')).toHaveLength(4)
    expect(text).toContain('Log')
  })

  it('says so plainly when nothing has been logged', () => {
    renderDetail({ stages: [] })
    expect(screen.getByTestId('batch-detail-stages-empty').textContent).toBe('Nothing logged yet.')
  })

  it('shows the cue and the note under the row that carries them', () => {
    renderDetail({ stages: [{ ...STAGE_FINISHED, note: 'third tray went back in' }] })
    expect(screen.getByTestId('batch-detail-stage-detail').textContent)
      .toBe('snapped clean · third tray went back in')
  })

  // Put-Up 1a item 3: a check-in is ONE row, so reading the pH and moving the crock in one visit is a
  // single `moved` row that carries both. The reading stays the row's subject; the move is read back
  // on the line beneath it. MUTATION: drop the label arm from stageRowDetail -> the move vanishes.
  it('reads back BOTH halves of a check-in that measured and moved the batch', () => {
    const MOVED_AND_READ = {
      ...STAGE_PH, id: 'ksl-moved', stage_kind: 'moved', label: 'Moved to Fridge', storage_location_id: 'loc-fridge',
      ph_reading: '3.40', ph_read_at: '2026-09-03T12:00:00.000Z', cue_observed: 'All under', note: 'into the fridge',
    }
    renderDetail({ stages: [MOVED_AND_READ] })
    // Release F: the row is one tappable button (06 §4 item 6); its first line is still the reading.
    expect(screen.getByTestId('batch-detail-stage-edit').firstElementChild.textContent).toBe('pH 3.40 · read Sep 3')
    expect(screen.getByTestId('batch-detail-stage-detail').textContent).toBe('Moved to Fridge · All under · into the fridge')
    // …and a row whose subject IS its label does not repeat it underneath.
    expect(stageRowDetail({ stage_kind: 'moved', label: 'Moved to Fridge', ph_reading: null, note: 'x' })).toBe('x')
    expect(stageRowDetail(null)).toBe('')
  })

  it('degrades a row it cannot date rather than rendering half a line', () => {
    expect(stageRowText({ stage_kind: 'tended', entered_at: null })).toBe('Tended')
    expect(stageRowText({ stage_kind: 'tended', entered_at: 'not a date' })).toBe('Tended')
    expect(stageRowText({ ph_reading: '4.60', ph_read_at: null })).toBe('pH 4.60')
    expect(stageRowText({ stage_kind: 'from_the_future', entered_at: null })).toBe('Logged')
    expect(stageRowText({ stage_kind: 'moved', label: 'Chest freezer 2', entered_at: null })).toBe('Chest freezer 2')
    expect(stageRowText(null)).toBe('')
  })
})

describe('BatchDetailView — what came out', () => {
  // Amended with contract-F A3 in the same commit as the change (V4 §8.3): quantity_value is the jar
  // row's TOTAL, so "3 pint · 3 packages" (read as three pints each) is now "3 containers · 3 pint in all".
  it('lists the jars as identity only, against the real projection', () => {
    renderDetail({ outputs: [OUTPUT_JAR] })
    // Amended with BUG-BATCHREMOVEDEADEND-001: a picked jar's row also carries its door now, so the row is
    // its identity and "Take it off this batch", and nothing else.
    expect(screen.getByTestId('batch-detail-output-text').textContent).toBe('3 containers · 3 pint in all · Aug 12')
    expect(screen.getByTestId('batch-detail-output').textContent).toBe('3 containers · 3 pint in all · Aug 12Take it off this batch')
    // The server's own SELECT omits both use-by columns, so this arm is about the projection holding.
    expect(OUTPUT_JAR.use_by_target).toBeUndefined()
    expect(OUTPUT_JAR.use_by_status).toBeUndefined()
  })

  it('still refuses the use-by fields if a future projection widens and hands them over', () => {
    // TWO fixtures, and the second is the load-bearing one: with the real projection the absence is
    // guaranteed by the server, which means the CLIENT guard would pass over data it never saw. This
    // render hands it the data and asserts it drops it anyway.
    renderDetail({ outputs: [OUTPUT_JAR_WIDENED] })
    const html = screen.getByTestId('batch-detail-outputs').innerHTML
    expect(html).not.toMatch(/Use soon|Past use-by|use by/i)
    expect(html).not.toContain('2026-11-12')
    // GREEN CONTROLS: the row DID carry both fields, and the identity line IS on screen — so this is
    // a suppression the client performs, not an accident of the fixture.
    expect(OUTPUT_JAR_WIDENED.use_by_status).toBe('use_soon')
    expect(html).toContain('3 containers · 3 pint in all · Aug 12')
  })

  it('answers "which jars came from that mash" with a plain nothing when there are none', () => {
    renderDetail({ outputs: [] })
    expect(screen.getByTestId('batch-detail-outputs-empty').textContent).toBe('No put-ups linked to this batch.')
  })

  it('degrades a jar with nothing recorded on it rather than rendering a blank row', () => {
    expect(outputRowText({ id: 'pl-x' })).toBe('A put-up')
    expect(outputRowText({ package_count: 1, preserved_at: '2026-08-12' })).toBe('1 container · Aug 12')
    expect(outputRowText(null)).toBe('')
  })

  it('reads a shape it was not given as an empty section, never a crash', () => {
    renderDetail({ inputs: null, stages: undefined, outputs: 'nope' })
    expect(screen.getByTestId('what-went-in-empty').textContent).toBe('Nothing written down yet.')
    expect(screen.getByTestId('batch-detail-stages-empty')).toBeTruthy()
    expect(screen.getByTestId('batch-detail-outputs-empty')).toBeTruthy()
    // …and a null `inputs` degrades to an empty section rather than becoming a network read: the
    // prop is normalised to [] before it reaches the field, so a shape the page never had cannot
    // flip the child back into fetching the batch for itself.
    expect(batchGets()).toHaveLength(0)
  })
})

describe('BatchDetailView — the close door', () => {
  it('mounts the close field on a batch that is still going', () => {
    renderDetail()
    expect(screen.getByTestId('batch-close-open').textContent).toBe('What happened to it? →')
  })

  it('does not offer it on a batch that is already closed', () => {
    renderDetail({ batch: CLOSED_SPOILED })
    expect(screen.queryByTestId('batch-close-open')).toBeNull()
    // GREEN CONTROL, one render apart on the same component: an open batch DOES offer it.
    renderDetail()
    expect(screen.getByTestId('batch-close-open')).toBeTruthy()
  })

  // ⚠ Every close writes a `finished` stage row, so current_stage_kind === 'finished' is now TRUE of
  // every closed batch — AND it stays true after a reopen, because stage order is non-monotonic and
  // a reopen NULLs only the three close columns. Deriving open/closed from the stage kind would
  // therefore leave a reopened batch permanently un-closeable, with no error and nothing on screen
  // to explain it. closed_at is the only discriminator.
  it('reads open-vs-closed from closed_at, never from the finished stage kind', () => {
    // A REOPENED batch: closed_at null, outcome null, current_stage_kind still 'finished'.
    renderDetail({ batch: REOPENED })
    expect(REOPENED.current_stage_kind).toBe('finished')
    expect(screen.getByTestId('batch-close-open')).toBeTruthy()
    expect(screen.queryByTestId('batch-detail-outcome')).toBeNull()

    // GREEN CONTROL, same stage kind, one column different: the CLOSED batch does hide the door and
    // does render its outcome — so the pass above is about closed_at and not about a broken gate.
    renderDetail({ batch: CLOSED_SPOILED })
    expect(CLOSED_SPOILED.current_stage_kind).toBe('finished')
    expect(screen.getAllByTestId('batch-close-open')).toHaveLength(1)
    expect(screen.getByTestId('batch-detail-outcome').textContent).toBe('closed Sep 4 · It spoiled — threw it out')
  })

  it('issues no GET for its OWN data — the surface is controlled', async () => {
    renderDetail({ inputs: [INPUT_PANTRY], stages: [STAGE_PH], outputs: [OUTPUT_JAR] })
    // The page fetched GET /:id once and handed the four arrays down; nothing under this root reads
    // that route again. Before the lanes were composed the inputs field fetched it a second time on
    // mount, which gave one screen two copies of inputs[] that could disagree.
    expect(batchGets()).toEqual([])
    // GREEN CONTROLS. The rows it was HANDED are on screen, from BOTH the arrays it renders itself
    // and the one it passes down…
    expect(screen.getByTestId('batch-detail-stage').textContent).toBe('pH 4.60 · read Sep 2')
    expect(screen.getByTestId('line-row-text').textContent).toBe('Kosher salt · 40 g')
    // …and the spy CAN see a call on this very surface (release F: the line search reads for its OWN
    // action once a name is typed), so "none of THAT route" is a measurement and not a dead mock.
    // (Put-Up UX pass R1: this batch has a line, so the add row is behind its door — opened first.)
    fireEvent.click(screen.getByTestId('line-add-open'))
    fireEvent.change(screen.getByTestId('line-add-name'), { target: { value: 'megatron' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/line-search?q=megatron'))
    expect(batchGets()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Put-Up 1a item 2 (V4 §2.3): "Pause and start-date setting live on batch detail." Both controls
// MOVED here from the Going-now card, and their component tests moved with them from
// PutUpGoingNow.test.jsx in the same commit — same assertions, this surface's testids.
const UNKNOWN_START = { ...MASH, id: 'kb-unk', start_precision: 'unknown' }

describe('BatchDetailView — the start-date door lives on the batch\'s own surface', () => {
  it('offers it on a going batch nobody was ever asked about', () => {
    renderDetail()
    expect(screen.getByTestId('batch-set-start').textContent).toBe('Set a start date →')
    // Amended with the Put-Up UX pass R1 (F16): a quiet action is 48px tall on a Put-Up surface.
    expect(screen.getByTestId('batch-set-start').style.minHeight).toBe('48px')
  })

  // The terminal-state ruling, now on this surface: "an unknown one must never prompt again".
  it('never prompts again once the answer is "unknown", nor on a batch with a start', () => {
    renderDetail({ batch: UNKNOWN_START })
    renderDetail({ batch: CANDY })
    expect(screen.getAllByTestId('batch-detail-view')).toHaveLength(2)   // instrument: two renders
    expect(screen.queryByTestId('batch-set-start')).toBeNull()
    expect(hasNoAlarmInk(screen.getAllByTestId('batch-detail-view')[0])).toBe(true)
  })

  // ⚠ FLIPPED FOR RELEASE F (06 §3.13, named there as a characterization that flips; Dave 15:55 "as we
  // go", including after bottling): the merge PUT takes content writes on a finished batch, so the
  // start-date door is offered on a closed batch nobody was ever asked about. It was hidden because a
  // door that could only fail was noise; it can land now.
  it('offers it on a finished batch nobody was ever asked about, too (release F)', () => {
    renderDetail({ batch: { ...CLOSED_SPOILED, start_precision: null, started_at: null } })
    expect(screen.getByTestId('batch-set-start').textContent).toBe('Set a start date →')
  })

  it('PUTs exactly the three start keys and nothing else on the allowlist', async () => {
    fetchMock.mockResolvedValue({ ...MASH, started_at: local('2026-08-17T09:00:00'), start_precision: 'week' })
    const onChanged = vi.fn()
    renderDetail({ onChanged })
    fireEvent.click(screen.getByTestId('batch-set-start'))
    fireEvent.click(screen.getByTestId('batch-start-chip-few_weeks'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const [path, opts] = fetchMock.mock.calls.find(([, o]) => o?.method === 'PUT')
    expect(path).toBe('/api/kitchen-batches/kb-mash')
    expect(Object.keys(JSON.parse(opts.body)).sort())
      .toEqual(['start_anchor_kind', 'start_precision', 'started_at'])
  })

  it('"Longer / not sure" writes the terminal grade with a null instant', async () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('batch-set-start'))
    fireEvent.click(screen.getByTestId('batch-start-chip-unsure'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true))
    const put = fetchMock.mock.calls.find(([, o]) => o?.method === 'PUT')
    expect(JSON.parse(put[1].body)).toEqual({ started_at: null, start_precision: 'unknown', start_anchor_kind: 'memory' })
  })

  it('keeps the row and says so when the write fails', async () => {
    fetchMock.mockImplementation((path, o) => (o?.method === 'PUT'
      ? Promise.reject(new Error('boom')) : Promise.resolve({ group_by: 'crop', groups: [] })))
    renderDetail()
    fireEvent.click(screen.getByTestId('batch-set-start'))
    fireEvent.click(screen.getByTestId('batch-start-chip-today'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't save that — try again."))
    expect(screen.getByTestId('batch-start-chips')).toBeTruthy()
  })
})

describe('BatchDetailView — pause lives on the batch\'s own surface', () => {
  // Amended for release 1b in the same commit as the change (V4 Appendix A, §8.3): a pause is ONE write
  // through the stages route, which moves suspended_at and writes the history row in one statement (the
  // 1b Lambda's stateStage). The merge PUT is no longer sent — and the server stamps the instant.
  const writes = () => fetchMock.mock.calls.filter(([, o]) => o?.method && o.method !== 'GET')

  it('POSTs exactly one `paused` stage row, and nothing else', async () => {
    const onChanged = vi.fn()
    renderDetail({ batch: CANDY, onChanged })
    expect(screen.getByTestId('batch-pause').textContent).toBe('Pause this batch')
    fireEvent.click(screen.getByTestId('batch-pause'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(writes()).toEqual([['/api/kitchen-batches/kb-candy/stages', {
      method: 'POST', body: JSON.stringify({ stage_kind: 'paused' }),
    }]])
  })

  it('offers the way back on a paused batch as one `resumed` row', async () => {
    const onChanged = vi.fn()
    renderDetail({ batch: PAUSED, onChanged })
    expect(screen.getByTestId('batch-pause').textContent).toBe('Pick it back up')
    fireEvent.click(screen.getByTestId('batch-pause'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(writes()).toEqual([['/api/kitchen-batches/kb-paused/stages', {
      method: 'POST', body: JSON.stringify({ stage_kind: 'resumed' }),
    }]])
  })

  it('keeps the batch as it was and says so when the write fails — as an error, not a body alarm', async () => {
    fetchMock.mockImplementation((path, o) => (o?.method === 'POST'
      ? Promise.reject(new Error('boom')) : Promise.resolve({ group_by: 'crop', groups: [] })))
    renderDetail({ batch: CANDY })
    fireEvent.click(screen.getByTestId('batch-pause'))
    await waitFor(() => expect(screen.getByTestId('batch-pause-error').textContent).toBe("Couldn't save that — try again."))
    expect(screen.getByTestId('batch-pause').textContent).toBe('Pause this batch')
    expect(screen.getByTestId('batch-pause-error').getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('batch-pause-error').getAttribute('data-alarm-ink-exempt')).toBe('error')
  })

  it('a refused pause (already paused elsewhere) says why in the server\'s words', async () => {
    fetchMock.mockImplementation((path, o) => (o?.method === 'POST'
      ? Promise.reject(Object.assign(new Error('409'), { status: 409, body: { code: 'not_paused_able', error: 'This batch is already paused or finished.' } }))
      : Promise.resolve(null)))
    renderDetail({ batch: CANDY })
    fireEvent.click(screen.getByTestId('batch-pause'))
    await waitFor(() => expect(screen.getByTestId('batch-pause-error').textContent).toBe('This batch is already paused or finished.'))
  })

  it('is not offered on a closed batch — reopening is a different act on a different surface', () => {
    renderDetail({ batch: CLOSED_SPOILED })
    expect(screen.queryByTestId('batch-pause')).toBeNull()
    renderDetail({ batch: REOPENED })   // GREEN CONTROL: the reopened twin DOES offer it
    expect(screen.getByTestId('batch-pause')).toBeTruthy()
  })
})

describe('BatchDetailView — the inherited rulings, on this surface\'s own root', () => {
  const FOOD_SAFETY = /acidif|shelf.stab|\bsafe\b|\bsafety\b|botul/i
  const READINESS = /\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i

  it('says nothing about acidification, safety, shelf stability or readiness — on a full render', () => {
    renderDetail({
      batch: CLOSED_SPOILED,
      inputs: [INPUT_HARVEST, INPUT_PANTRY, INPUT_OFFCUT],
      stages: [STAGE_FINISHED, STAGE_PH, STAGE_PH_2, STAGE_STARTED],
      outputs: [OUTPUT_JAR],
    })
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    const view = screen.getByTestId('batch-detail-view')
    const html = view.innerHTML
    expect(html).not.toMatch(FOOD_SAFETY)
    expect(html).not.toMatch(READINESS)
    expect(html).not.toMatch(/role="progressbar"/)
    expect(view.querySelector('progress')).toBeNull()
    // GREEN CONTROLS: every section rendered content on this exact render, so the four arms above
    // swept a fully-populated surface rather than an empty div.
    expect(html).toContain('It spoiled — threw it out')
    expect(html).toContain('pH 4.60 · read Sep 2')
    expect(html).toContain('Kosher salt · 40 g')
    expect(html).toContain('3 containers · 3 pint in all · Aug 12')
  })

  it('never puts a raw outcome value in the DOM, in any attribute or text node', () => {
    renderDetail({ batch: CLOSED_SPOILED })
    const html = screen.getByTestId('batch-detail-view').innerHTML
    for (const o of CLOSE_OUTCOMES) expect(html).not.toContain(o.value)
    // GREEN CONTROL: the LABEL for the very value under test is on screen.
    expect(html).toContain('It spoiled — threw it out')
  })

  it('paints no alarm ink anywhere on the body', () => {
    renderDetail({
      batch: PAUSED,
      inputs: [INPUT_HARVEST],
      stages: [STAGE_PH, STAGE_FINISHED],
      outputs: [OUTPUT_JAR],
    })
    expect(hasNoAlarmInk(screen.getByTestId('batch-detail-view'))).toBe(true)
    // GREEN CONTROL for the helper: it CAN see an alarm ink when one is on screen (jsdom normalises
    // inline colour to rgb(), which is how two shipped colour assertions passed over nothing).
    renderDetail({ error: true })
    expect(hasNoAlarmInk(screen.getAllByTestId('batch-detail-view')[1])).toBe(false)
    expect(screen.getByTestId('batch-detail-error').style.color).toBe(toRgb(P.terra))
  })
})

describe('BatchDetailView — the two hand-copied vocabularies are bound to their sources', () => {
  const KB = read('lambda/preservation/kitchenBatch.js')
  const quoted = (s) => [...s.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
  const keysOf = (src, name) => {
    const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\}`).exec(src)
    expect(block).not.toBeNull()
    return [...block[1].matchAll(/(\w+):/g)].map(m => m[1])
  }

  // Release F (amended in the same commit): the Log's table covers EVERY kind a stage row can carry —
  // KITCHEN_STAGE_KINDS_ALL, the 1b history kinds folded in — and still agrees word-for-word with
  // goingNow.js's copy on the five the card reads (the view's current_stage LATERAL reads only those).
  it('STAGE_KIND_LABELS covers exactly KITCHEN_STAGE_KINDS_ALL, and matches goingNow.js\'s copy on the five', () => {
    const shipped = quoted(/export const KITCHEN_STAGE_KINDS = \[([\s\S]*?)\]/.exec(KB)[1])
    expect(shipped).toEqual(['started', 'tended', 'moved', 'finished', 'failed'])
    const all = quoted(/export const KITCHEN_STAGE_KINDS_ALL = \[([\s\S]*?)\]/.exec(KB)[1])
    const mine = keysOf(read('src/components/putup/BatchDetailView.jsx'), 'STAGE_KIND_LABELS')
    const theirs = keysOf(read('src/components/putup/goingNow.js'), 'STAGE_KIND_LABELS')
    expect([...mine].sort()).toEqual([...all].sort())
    expect([...theirs].sort()).toEqual([...shipped].sort())
    for (const k of shipped) expect(stageRowText({ stage_kind: k, entered_at: null })).not.toBe('Logged')
  })

  it('INPUT_KIND_LABELS covers exactly KITCHEN_INPUT_KINDS', () => {
    const fromLambda = quoted(/export const KITCHEN_INPUT_KINDS = \[([\s\S]*?)\]/.exec(KB)[1])
    expect(fromLambda).toEqual(['harvest', 'purchased', 'pantry', 'other'])
    const mine = keysOf(read('src/components/putup/BatchDetailView.jsx'), 'INPUT_KIND_LABELS')
    expect(mine.sort()).toEqual([...fromLambda].sort())
  })

  it('renders a label for every stage kind and input kind the server can send', () => {
    const stageKinds = quoted(/export const KITCHEN_STAGE_KINDS = \[([\s\S]*?)\]/.exec(KB)[1])
    for (const k of stageKinds) {
      expect(stageRowText({ stage_kind: k, entered_at: FIRST_RECORDED_SEP_3 })).not.toBe('Logged · Sep 3')
    }
    const inputKinds = quoted(/export const KITCHEN_INPUT_KINDS = \[([\s\S]*?)\]/.exec(KB)[1])
    for (const k of inputKinds) expect(inputRowText({ input_kind: k })).not.toBe('Input')
  })
})

// ⚠ AMENDED FOR RELEASE F in the same commit as the change (06 §4 item 3): the section's body is the
// reworked field, WhatWentIn, handed the rows the page already fetched. The shipped BatchInputsField is
// mounted inside it for legacy picks only; its "Add something else" (the shipped un-keyed form) and the
// hidden garden-picks door are replaced by the line search — garden lines ARE the replacement V4 §10.1
// named ("'Add picks from the garden' → hidden (1a); garden lines replace it (3)").
describe('BatchDetailView — What went in is the reworked field', () => {
  it('imports it, hands it the rows the page already fetched, and really mounts it', () => {
    const src = read('src/components/putup/BatchDetailView.jsx')
    expect(src).toContain('export default function BatchDetailView')
    expect(src).toMatch(/^import WhatWentIn, \{ FromGarden \} from '\.\/WhatWentIn\.jsx'$/m)
    // `lines=` is the load-bearing half: without it the field has nothing to show and nothing to read.
    expect(src).toContain('<WhatWentIn batch={batch} lines={inputRows}')
    renderDetail({ inputs: [INPUT_PANTRY] })
    expect(within(screen.getByTestId('batch-detail-inputs')).getByTestId('what-went-in')).toBeTruthy()
  })
})

describe('BatchDetailView — the garden-picks door is gone; the line search is the door', () => {
  it('offers the line search, and neither the shipped "Add something else" nor a garden-picks door', () => {
    renderDetail()
    const section = within(screen.getByTestId('batch-detail-inputs'))
    expect(section.queryByTestId('batch-inputs-open-picks')).toBeNull()
    expect(section.queryByTestId('batch-inputs-open-other')).toBeNull()
    expect(screen.getByTestId('batch-detail-view').textContent).not.toContain('Add picks from the garden')
    expect(section.getByTestId('line-add-name').getAttribute('aria-required')).toBe('true')
  })
})

describe('BatchDetailView — the section titles a screen reader lands on', () => {
  it('titles the three sections and puts each list under its own', () => {
    renderDetail({ inputs: [INPUT_PANTRY], stages: [STAGE_PH], outputs: [OUTPUT_JAR] })
    // TWO headings in the inputs section and that is the structure as integrated: the section keeps
    // its own title (the landmark a screen reader lands on, unchanged from before the mount) and the
    // hosted field keeps the heading it carries when it stands alone. Asserted as an ordered whole so
    // a THIRD one — the duplicate-surface failure — cannot slip in under a getBy that takes the first.
    expect(within(screen.getByTestId('batch-detail-inputs')).getAllByRole('heading').map(h => h.textContent))
      // ONE heading for one thing. The hosted BatchInputsField used to render its own <h3> directly
      // under this Section's, stacking two headings a line apart and putting two entries in the
      // screen-reader heading list for a single section. The host owns it; the field's was removed
      // at integration 20260904.
      .toEqual(['What went in'])
    expect(within(screen.getByTestId('batch-detail-stages')).getByRole('heading').textContent).toBe('Log')
    expect(within(screen.getByTestId('batch-detail-outputs')).getByRole('heading').textContent).toBe('What came out')
  })
})
