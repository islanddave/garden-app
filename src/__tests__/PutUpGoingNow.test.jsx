// V5-INFLIGHTBATCH-001 — the "Going now" third segment on /put-up.
//
// TEST-SHAPE RULES THIS FILE HOLDS TO (API-CONTRACT §4, and each one exists because this repo
// already shipped the failure it names):
//   • FULL LITERALS, both bounds and every separator. SavedSeeds.processAndElapsed.test.jsx:194
//     asserts toContain('4 days in drying') and '14 days in drying'.includes(...) is TRUE — that
//     shipped assertion passes on a value ten days wrong. Nothing here uses toContain on a fragment.
//   • TWO AGES MINIMUM, at the bounds of every band. A single age is vacuous.
//   • SWEEP THE SHAPE. Precision is asserted as a monotone ordering, not spot-checked: non-monotonic
//     means broken independent of any individual value.
//   • FIXED ZONELESS LOCAL DATE LITERALS, never Date.now() offsets. The blocking TZ=America/New_York
//     CI re-run has nothing to bite on over millisecond arithmetic. Every literal below is inside one
//     DST regime (2026 EDT runs Mar 8 → Nov 1), so the two CI lanes agree by construction.
//   • FIXTURES FROM THE REAL DISTRIBUTION, and it is degenerate: a kind-less batch (kind is nullable
//     on purpose — the existing put-up picker mis-files 40% of its live rows), a batch with no start
//     at all, a batch whose start is a permanent 'unknown', and a TWO-USER PAIR, because a
//     single-owner fixture cannot fail an ownership bug in a two-person household.
//
// CI LANE: `npm test` (vitest run --coverage) plus the blocking TZ re-run. Not the integration
// workflow — there is no database to integration-test against, the migration is unapplied.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const fetchMock = vi.fn()
const navigateMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'pepper', display_name: 'Peppers', category: 'vegetable' }], loading: false }),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => navigateMock }
})

import PutUp, { batchRows } from '../pages/PutUp.jsx'
import { P } from '../lib/constants.js'
import GoingNowView from '../components/putup/GoingNowView.jsx'
import {
  describeElapsed, describeAge, describeStage, describeExpectedWindow, startIsDayOrBetter,
  precisionRank, UNRANKED_PRECISION, startPromptState, isSuspended, sortGoing, partitionGoing,
  submersionPrompt, SUBMERSION_PROMPT,
  START_CHIPS, startChipPatch, pickedDatePatch, ymdToInstant, startPatchViolatesPairing,
  pausePatch, PAUSE_CTA, RESUME_CTA, OPEN_BATCH_CTA, CLOSED_DOOR_CTA,
} from '../components/putup/goingNow.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// jsdom normalises every inline colour to `rgb(r, g, b)`, so a regex over the palette's HEX values
// matches NOTHING and passes no matter what colour the element is. Both "never a warning colour"
// assertions below were written that way and a mutation run proved them vacuous: repainting the
// submersion line in P.terra left them green. Compare converted values, never raw hex.
const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
// The app's three alarm inks. None may appear anywhere on a Going-now card.
const ALARM_INKS = [P.terra, P.warnBorder, P.severityUrgent].map(toRgb)
// ⚠ NARROWED 2026-09-04 BY V5-BATCHCLOSE-001, and narrowed by an EXPLICIT per-element opt-out rather
// than by shrinking the scope, which is the difference between a guard and a hole.
//
// The ruling this sweep enforces (goingNow.js:21-24) is that the card BODY never reddens for a batch
// that is fine — "a card that reddens for a thing that is fine teaches the user that red means
// nothing". It is NOT a ban on an error string looking like an error: P.terra is the house error ink
// and GoingNowView.jsx:93 has always painted a role="alert" line with it inside the start editor. The
// pause control adds a second such line, so left unnarrowed a FAILED WRITE would red a test whose
// stated subject is the missing-start CTA — a wrong-reason red, and the fix for that is the test.
//
// Only nodes carrying data-alarm-ink-exempt are dropped, and the swept element itself is NEVER
// dropped, so an alarm-coloured card BORDER still kills. Mutations M33 (submersion line in P.terra),
// M34 (P.warnBorder card edge) and M35 (title in P.severityUrgent) were re-run against THIS version
// and all three still kill; the instrument test below is the standing proof.
const hasNoAlarmInk = (el) => {
  const clone = el.cloneNode(true)
  clone.querySelectorAll('[data-alarm-ink-exempt]').forEach(n => n.remove())
  return ALARM_INKS.every(ink => !clone.outerHTML.includes(ink))
}

// The fixed "now" every age below is measured against. Zoneless => local.
const NOW = new Date('2026-09-04T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()

// NOON UTC, not 16:00Z. A timestamptz renders its own calendar day in the reader's zone, so the
// literal has to sit far enough from both midnights that no plausible CI zone can move it: 12:00Z is
// Sep 3 from UTC-11 through UTC+11. 16:00Z looked safe, covered the two CI lanes, and flipped to
// Sep 4 in Tokyo — a half-width margin is how a date assertion becomes zone-dependent by accident.
const FIRST_RECORDED_SEP_3 = '2026-09-03T12:00:00.000Z'

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
// The pepper mash that drove this whole schema: mixed garden + bought peppers, no start date anyone
// remembers, NEVER ASKED (start_precision null, distinct from 'unknown'), kind null, and the
// measured fan-in of 139 harvest_log rows across 30 plantings.
const MASH = {
  id: 'kb-mash', user_id: 'user_dave', label: 'Pepper mash', kind: null, kind_other: null,
  started_at: null, start_precision: null, first_recorded_at: FIRST_RECORDED_SEP_3,
  expected_days_min: 21, expected_days_max: 42, suspended_at: null, closed_at: null,
  current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: FIRST_RECORDED_SEP_3, input_count: 139, output_count: 0,
}
// The hours case. SavedSeeds' elapsed() floors to days and would render this "today" — the one
// number that decides whether to go and check it.
const DEHYDRATOR = {
  id: 'kb-dry', user_id: 'user_dave', label: 'Ghost peppers, dehydrating', kind: 'dehydrate',
  started_at: local('2026-09-04T05:00:00'), start_precision: 'day', first_recorded_at: local('2026-09-04T05:00:00'),
  expected_days_min: 8, expected_days_max: 12, suspended_at: null, closed_at: null,
  current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: local('2026-09-04T05:00:00'), input_count: 0, output_count: 0,
}
// The repeated stage. Candying is n-of-m with repetition and its order is NOT monotonic — a `tended`
// row legitimately follows a `finished` one.
const CANDY = {
  id: 'kb-candy', user_id: 'user_dave', label: 'Candied ginger', kind: 'candy',
  started_at: local('2026-08-23T09:00:00'), start_precision: 'exact', first_recorded_at: local('2026-08-23T09:00:00'),
  expected_days_min: null, expected_days_max: null, suspended_at: null, closed_at: null,
  current_stage_kind: 'tended', current_stage_label: 'Syrup rung 2',
  current_stage_entered_at: local('2026-09-02T09:00:00'), input_count: 3, output_count: 0,
}
// Asked, and he does not know. started_at NULL + precision 'unknown' is a DIFFERENT CLAIM from
// MASH's never-asked, and the 0a DDL is explicit that the renderer must treat them differently.
const UNKNOWN_START = {
  id: 'kb-unk', user_id: 'user_dave', label: 'Crock of something', kind: null,
  started_at: null, start_precision: 'unknown', first_recorded_at: FIRST_RECORDED_SEP_3,
  expected_days_min: 21, expected_days_max: 42, suspended_at: null, closed_at: null,
  current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: FIRST_RECORDED_SEP_3, input_count: 0, output_count: 0,
}
// The frozen candy parent. Resumes N times over months; showing it beside a day-2 syrup pot as
// equally "in flight" misreports the only thing this view exists to say.
const PAUSED = {
  id: 'kb-paused', user_id: 'user_dave', label: 'Candy parent, frozen', kind: 'candy',
  started_at: local('2026-06-14T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-06-14T09:00:00'),
  expected_days_min: null, expected_days_max: null,
  suspended_at: '2026-08-12T12:00:00.000Z', closed_at: null,
  current_stage_kind: 'tended', current_stage_label: 'Frozen', input_count: 0, output_count: 0,
  current_stage_entered_at: '2026-08-12T12:00:00.000Z',
}
// A ferment whose start is known TO THE SECOND, with a published-looking window on the row. This is
// the fixture the 2026-09-04 food-safety adjudication exists for: the precision gate alone would let
// this render "usually 21–42 days", and it must not, because elapsed time is not evidence about a
// ferment at ANY precision. Last touched 4 days ago, so it is also outside the submersion cadence.
const FERMENT_EXACT = {
  id: 'kb-ferment', user_id: 'user_dave', label: 'Jalapeño ferment', kind: 'ferment',
  started_at: local('2026-08-21T09:00:00'), start_precision: 'exact', first_recorded_at: local('2026-08-21T09:00:00'),
  expected_days_min: 21, expected_days_max: 42, suspended_at: null, closed_at: null,
  current_stage_kind: 'tended', current_stage_label: 'Skimmed',
  current_stage_entered_at: local('2026-08-31T09:00:00'), input_count: 12, output_count: 0,
}
// The household peer. Jen owns nothing on prod today, which is exactly why a fixture has to.
const JEN_BATCH = {
  ...CANDY, id: 'kb-jen', user_id: 'user_jen', label: "Jen's plum butter",
  started_at: local('2026-09-01T09:00:00'), current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: local('2026-09-01T09:00:00'), input_count: 0,
}
// Two CLOSED rows, and the numerics are STRINGS because that is what the wire sends: the neon driver
// hands back numeric/bigint columns as strings, and only `linked_output_count` is a real number. A
// fixture that types them as numbers is an invented wire, which is the whole class BUG-GOINGNOWENVELOPE-001
// belongs to. Rendering a closed ROW is ClosedBatchesView's contract (lane L5) and is not asserted
// here; these exist so this lane's plumbing carries a realistic two-user payload.
const CLOSED_PUTUP = {
  ...CANDY, id: 'kb-closed', label: 'Peach butter, done', closed_at: '2026-08-30T12:00:00.000Z',
  outcome: 'put_up', outcome_note: null, input_count: '3', output_count: '2',
}
const JEN_CLOSED = {
  ...CLOSED_PUTUP, id: 'kb-jen-closed', user_id: 'user_jen', label: "Jen's plum butter, done",
  closed_at: '2026-09-01T12:00:00.000Z', input_count: '0', output_count: '1',
}

// `now` is INJECTED, never left to the wall clock. The first draft of this helper omitted it: the
// dehydrator card then read "4 hours" under America/New_York and "8 hours" under UTC, because the
// fixture's start was a zoneless local literal and the component's Date.now() was not. Caught by
// running the file under TZ=UTC before committing.
function renderView(batches, extra = {}) {
  return render(
    <MemoryRouter initialEntries={['/put-up']}>
      <GoingNowView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} {...extra} />
    </MemoryRouter>,
  )
}

beforeEach(() => { fetchMock.mockReset(); navigateMock.mockReset(); sessionStorage.clear() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('goingNow — elapsed, at both bounds of every band', () => {
  // Ten fixed instants, each named by the band boundary it sits on. A single age would be vacuous;
  // a boundary pair per band is what actually pins the branch points.
  it.each([
    ['2026-09-04T08:01:00', 'less than an hour'],
    ['2026-09-04T08:00:00', '1 hour'],
    ['2026-09-03T10:00:00', '23 hours'],
    ['2026-09-03T09:00:00', '1 day'],
    ['2026-08-15T09:00:00', '20 days'],
    ['2026-08-14T09:00:00', '3 weeks'],
    ['2026-07-26T09:00:00', '6 weeks'],
    ['2026-07-07T09:00:00', '8 weeks'],
    ['2026-07-06T09:00:00', '2 months'],
    ['2026-05-07T09:00:00', '4 months'],
  ])('%s reads exactly "%s"', (start, expected) => {
    expect(describeElapsed(local(start), NOW)).toBe(expected)
  })

  it('the hours branch exists: a 4-hour dehydrator run is NOT "today"', () => {
    // This is the concrete reuse hazard in SavedSeeds.elapsed(), which floors to days and renders
    // 'today' for anything under 24 h. The design names dehydrator runs as an in-scope case.
    expect(describeElapsed(DEHYDRATOR.started_at, NOW)).toBe('4 hours')
  })

  it('returns null rather than a zero for an absent or unparseable instant', () => {
    expect(describeElapsed(null, NOW)).toBeNull()
    expect(describeElapsed('not a date', NOW)).toBeNull()
  })
})

describe('goingNow — precision is a monotone ordering, swept not spot-checked', () => {
  it('ranks exact < hour < day < week < month < unknown < unrecognised', () => {
    const order = ['exact', 'hour', 'day', 'week', 'month', 'unknown']
    for (let i = 1; i < order.length; i += 1) {
      expect(precisionRank(order[i - 1])).toBeLessThan(precisionRank(order[i]))
    }
    // An unrecognised grade is unknown reliability, and the only safe direction to round unknown
    // reliability is DOWN — worse than every named grade, including 'unknown' itself.
    expect(precisionRank('unknown')).toBeLessThan(precisionRank('centuries'))
    expect(precisionRank('centuries')).toBe(UNRANKED_PRECISION)
    expect(precisionRank(null)).toBe(UNRANKED_PRECISION)
  })

  it('startIsDayOrBetter is a step at day, true for the first three and false for every later one', () => {
    for (const p of ['exact', 'hour', 'day']) expect(startIsDayOrBetter({ start_precision: p })).toBe(true)
    for (const p of ['week', 'month', 'unknown', null, 'centuries']) {
      expect(startIsDayOrBetter({ start_precision: p })).toBe(false)
    }
  })
})

describe('goingNow — a FERMENT gets no duration affordance at ANY precision', () => {
  // The 2026-09-04 adjudication, and it is stricter than the contract it supersedes. The reason is
  // not uncertainty about the date: elapsed time is not evidence about a ferment at all. BC CDC —
  // "no standard set of time to a required pH drop is provided based on vegetable category". UMN —
  // bubbling can cease while pH is still above 4.6.
  it('is silent for a ferment whose start is known to the second', () => {
    expect(FERMENT_EXACT.start_precision).toBe('exact')     // the gate that USED to let this through
    expect(startIsDayOrBetter(FERMENT_EXACT)).toBe(true)
    expect(describeExpectedWindow(FERMENT_EXACT)).toBeNull()
  })

  it('is silent for a ferment at every one of the six graded precisions', () => {
    for (const p of ['exact', 'hour', 'day', 'week', 'month', 'unknown']) {
      expect(describeExpectedWindow({ ...FERMENT_EXACT, start_precision: p })).toBeNull()
    }
  })

  it('fails CLOSED on an unclassified batch — the app cannot rule out that a crock is a ferment', () => {
    for (const kind of [null, undefined, 'other', 'ferment']) {
      expect(describeExpectedWindow({ ...DEHYDRATOR, kind })).toBeNull()
    }
  })

  it('leaves the five named non-ferment kinds exactly as they were', () => {
    for (const kind of ['dehydrate', 'candy', 'cure', 'infuse', 'age']) {
      expect(describeExpectedWindow({ ...DEHYDRATOR, kind })).toBe('usually 8–12 days')
    }
  })

  it('renders no countdown, day-N-of-M, or percentage anywhere on a ferment card', () => {
    renderView([FERMENT_EXACT])
    // textContent, not innerHTML: inline styles carry legitimate `100%` widths, and a readiness
    // claim is something the user READS. The structural check (no <progress>, no progressbar role)
    // is the innerHTML sweep two describes below.
    const text = screen.getByTestId('going-now-view').textContent
    expect(text).not.toMatch(/usually|\bday \d+ of \d+\b|\d\s?%|\bof 21\b|\bof 42\b/i)
    expect(screen.getByTestId('going-batch-meta').textContent)
      .toBe('14 days · Skimmed · last touched 4 days ago')
  })
})

describe('goingNow — the expected window is gated on day-or-better precision (ruling 1)', () => {
  it('renders both bounds and the en-dash separator when the start is day-or-better', () => {
    expect(describeExpectedWindow(DEHYDRATOR)).toBe('usually 8–12 days')
  })

  it('renders a single bound when min equals max', () => {
    expect(describeExpectedWindow({ ...DEHYDRATOR, expected_days_min: 10, expected_days_max: 10 }))
      .toBe('usually 10 days')
    expect(describeExpectedWindow({ ...DEHYDRATOR, expected_days_min: 1, expected_days_max: 1 }))
      .toBe('usually 1 day')
  })

  it('is SILENT for every coarser grade — pairing a guessed start with a duration licenses "it\'s been long enough"', () => {
    for (const p of ['week', 'month', 'unknown', null]) {
      expect(describeExpectedWindow({ ...DEHYDRATOR, start_precision: p })).toBeNull()
    }
    // …and silent when the row simply carries no window, at any precision.
    expect(describeExpectedWindow({ ...DEHYDRATOR, expected_days_min: null, expected_days_max: null })).toBeNull()
    expect(describeExpectedWindow(MASH)).toBeNull()
  })
})

describe('goingNow — the submersion prompt, the one thing the evidence base supports', () => {
  it('asks a question and stops — no verdict, no failure-sign checklist, no second clause', () => {
    // A checklist of what going wrong looks like invites the reader to conclude that its absence
    // means success, and that inference is the specific error behind the olive botulism outbreak
    // (measured pH 6.5, no sensory alarm recorded).
    expect(submersionPrompt(FERMENT_EXACT, NOW)).toBe('Everything still under the brine?')
    expect(SUBMERSION_PROMPT).not.toMatch(/mold|mould|scum|slime|slimy|smell|odou?r|film|discard/i)
    expect(SUBMERSION_PROMPT).not.toMatch(/\bpH\b|acidif|salt|safe|safety|shelf|botul/i)
    expect(SUBMERSION_PROMPT.endsWith('?')).toBe(true)
  })

  it('recurs on Penn State\'s two-to-three-times-a-week cadence, keyed on when you last looked', () => {
    const touched = (iso) => ({ ...FERMENT_EXACT, current_stage_entered_at: local(iso) })
    // Both bounds of the threshold, and a value well past it — a single age would be vacuous.
    expect(submersionPrompt(touched('2026-09-03T09:00:00'), NOW)).toBeNull()          // 1 day
    expect(submersionPrompt(touched('2026-09-02T09:00:01'), NOW)).toBeNull()          // 2 days less a second
    expect(submersionPrompt(touched('2026-09-02T09:00:00'), NOW)).toBe(SUBMERSION_PROMPT)   // exactly 2 days
    expect(submersionPrompt(touched('2026-08-21T09:00:00'), NOW)).toBe(SUBMERSION_PROMPT)   // 14 days
  })

  it('never asks about brine on something that is not a KNOWN ferment', () => {
    for (const kind of [null, undefined, 'other', 'dehydrate', 'candy', 'cure', 'infuse', 'age']) {
      expect(submersionPrompt({ ...FERMENT_EXACT, kind }, NOW)).toBeNull()
    }
  })

  it('falls back to first_recorded_at when the batch has no stage instant', () => {
    const noStage = { ...FERMENT_EXACT, current_stage_entered_at: null, first_recorded_at: FIRST_RECORDED_SEP_3 }
    expect(submersionPrompt(noStage, NOW)).toBeNull()   // Sep 3 noon → under 2 days from Sep 4 09:00
    expect(submersionPrompt({ ...noStage, first_recorded_at: local('2026-08-01T09:00:00') }, NOW))
      .toBe(SUBMERSION_PROMPT)
    expect(submersionPrompt({ ...noStage, first_recorded_at: null }, NOW)).toBeNull()
  })

  it('renders in the card\'s ordinary ink, never as a badge or a warning colour', () => {
    renderView([FERMENT_EXACT])
    const line = screen.getByTestId('going-batch-submersion')
    expect(line.textContent).toBe('Everything still under the brine?')
    expect(line.style.color).toBe(toRgb(P.mid))
    expect(hasNoAlarmInk(screen.getByTestId('going-batch'))).toBe(true)
  })
})

describe('goingNow — the age line leads with what is known', () => {
  it('carries the grade as an "approx" qualifier, not as a separate confession', () => {
    expect(describeAge(CANDY, NOW)).toEqual({ kind: 'elapsed', text: '12 days', approx: false })
    expect(describeAge({ ...CANDY, start_precision: 'week' }, NOW))
      .toEqual({ kind: 'elapsed', text: '12 days', approx: true })
  })

  it('falls back to first_recorded_at as raw PROVENANCE, never as an age', () => {
    // The 0a DDL: "'First recorded Sep 3' is a fact even when the start is not, and it is what the
    // card leads with instead of a blank." A duration derived from this floor would be a readiness
    // computation on a guessed start, which is exactly what ruling 1 forbids.
    expect(describeAge(MASH, NOW)).toEqual({ kind: 'first_recorded', at: FIRST_RECORDED_SEP_3 })
    expect(describeAge(UNKNOWN_START, NOW)).toEqual({ kind: 'first_recorded', at: FIRST_RECORDED_SEP_3 })
  })
})

describe('goingNow — the missing-start CTA has THREE states, not two', () => {
  it('prompts only when nobody was ever asked', () => {
    expect(startPromptState(MASH)).toBe('prompt')
  })

  it('NEVER prompts again once the answer is "unknown" — a permanent, acceptable terminal state', () => {
    expect(startPromptState(UNKNOWN_START)).toBe('silent')
  })

  it('never prompts a batch that already has a start', () => {
    expect(startPromptState(CANDY)).toBe('silent')
    expect(startPromptState({ ...CANDY, start_precision: 'month' })).toBe('silent')
  })
})

describe('goingNow — ordering: started_at DESC NULLS LAST', () => {
  it('puts an unknown start BELOW every measured one, never at the top of a "check this" list', () => {
    const sorted = sortGoing([MASH, CANDY, DEHYDRATOR, UNKNOWN_START])
    expect(sorted.map(b => b.id)).toEqual(['kb-dry', 'kb-candy', 'kb-mash', 'kb-unk'])
  })

  it('breaks a NULL-start tie on first_recorded_at DESC', () => {
    const older = { ...MASH, id: 'kb-older', first_recorded_at: '2026-08-01T12:00:00.000Z' }
    expect(sortGoing([older, UNKNOWN_START]).map(b => b.id)).toEqual(['kb-unk', 'kb-older'])
    expect(sortGoing([UNKNOWN_START, older]).map(b => b.id)).toEqual(['kb-unk', 'kb-older'])
  })

  it('is total on a degenerate list and never throws', () => {
    expect(sortGoing(null)).toEqual([])
    expect(sortGoing([{ id: 'a', started_at: 'garbage', first_recorded_at: null }]).map(b => b.id)).toEqual(['a'])
  })
})

describe('goingNow — suspended is a separate answer, not a lower-ranked one', () => {
  it('partitions on suspended_at and sorts each side independently', () => {
    const { active, paused } = partitionGoing([PAUSED, MASH, DEHYDRATOR, CANDY])
    expect(active.map(b => b.id)).toEqual(['kb-dry', 'kb-candy', 'kb-mash'])
    expect(paused.map(b => b.id)).toEqual(['kb-paused'])
    expect(isSuspended(PAUSED)).toBe(true)
    expect(isSuspended(CANDY)).toBe(false)
  })
})

describe('goingNow — the stage line counts since you last looked, never toward a finish', () => {
  it('is silent on the auto-written "started" row — every batch has one, so it says nothing', () => {
    expect(describeStage(DEHYDRATOR, NOW)).toEqual({ label: null, since: null })
  })

  it('names the newest row and when, with no position in a sequence', () => {
    expect(describeStage(CANDY, NOW)).toEqual({ label: 'Syrup rung 2', since: 'last touched 2 days ago' })
  })

  it('falls back to the kind label for an unlabelled non-start row, in EITHER order — stage order is not monotonic', () => {
    const finished = { ...CANDY, current_stage_kind: 'finished', current_stage_label: null }
    const tendedAfter = { ...CANDY, current_stage_kind: 'tended', current_stage_label: null }
    expect(describeStage(finished, NOW)).toEqual({ label: 'Finished', since: 'last touched 2 days ago' })
    expect(describeStage(tendedAfter, NOW)).toEqual({ label: 'Tended', since: 'last touched 2 days ago' })
  })
})

describe('goingNow — the start chips derive precision, never ask for it (ruling 5)', () => {
  it('offers the seven answers in the ruling, with "not sure" as a first-class one', () => {
    expect(START_CHIPS.map(c => c.label)).toEqual([
      'Today', 'Yesterday', 'A few days ago', 'About a week', '2–3 weeks', 'Longer / not sure',
    ])
  })

  it('maps each chip to its derived grade', () => {
    expect(START_CHIPS.map(c => c.precision)).toEqual(['exact', 'day', 'day', 'week', 'week', 'unknown'])
  })

  it('EVERY chip produces a patch that satisfies chk_kitchen_batch_start_pairing', () => {
    // The biconditional is what makes the four start states the only four. A client that can build a
    // fifth surfaces as an opaque 400 on a route the user cannot see.
    for (const chip of START_CHIPS) {
      expect(startPatchViolatesPairing(startChipPatch(chip.value, NOW))).toBe(false)
    }
  })

  it('back-dates "2–3 weeks" to the band midpoint at week precision', () => {
    const patch = startChipPatch('few_weeks', NOW)
    expect(patch.start_precision).toBe('week')
    expect(patch.start_anchor_kind).toBe('memory')
    expect(new Date(patch.started_at).getTime()).toBe(new Date('2026-08-17T09:00:00').getTime())
  })

  it('"Longer / not sure" stores the grade with NO instant — the one legal NULL-date pairing', () => {
    expect(startChipPatch('unsure', NOW)).toEqual({
      started_at: null, start_precision: 'unknown', start_anchor_kind: 'memory',
    })
  })

  it('returns null for a chip that does not exist', () => {
    expect(startChipPatch('sometime', NOW)).toBeNull()
  })

  it('the pairing guard rejects both illegal combinations', () => {
    expect(startPatchViolatesPairing({ started_at: '2026-09-01T12:00:00.000Z', start_precision: 'unknown' })).toBe(true)
    expect(startPatchViolatesPairing({ started_at: null, start_precision: 'day' })).toBe(true)
    expect(startPatchViolatesPairing(null)).toBe(true)
  })
})

describe('goingNow — a picked calendar date survives the timezone', () => {
  it('lands on LOCAL NOON so the stored instant renders back as the same calendar day', () => {
    // `new Date('2026-08-20')` parses as UTC MIDNIGHT and renders as Aug 19 for every negative
    // offset, which is what the blocking TZ=America/New_York re-run exists to catch. This assertion
    // is the reason ymdToInstant is not that one-liner.
    const iso = ymdToInstant('2026-08-20')
    const back = new Date(iso)
    expect([back.getFullYear(), back.getMonth() + 1, back.getDate()]).toEqual([2026, 8, 20])
    expect(back.getHours()).toBe(12)
  })

  it('produces a day-precision, manually-anchored patch that satisfies the pairing constraint', () => {
    const patch = pickedDatePatch('2026-08-20')
    expect(patch.start_precision).toBe('day')
    expect(patch.start_anchor_kind).toBe('manual')
    expect(startPatchViolatesPairing(patch)).toBe(false)
  })

  it('rejects anything that is not a YYYY-MM-DD', () => {
    expect(ymdToInstant('20-08-2026')).toBeNull()
    expect(ymdToInstant('')).toBeNull()
    expect(pickedDatePatch('nope')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('GoingNowView — the three named cards, as full literals', () => {
  it('renders the unknown-start card leading with what is KNOWN and the CTA in the action slot', () => {
    renderView([MASH])
    expect(screen.getByTestId('going-batch-title').textContent).toBe('Pepper mash')
    expect(screen.getByTestId('going-batch-meta').textContent).toBe('first recorded Sep 3')
    expect(screen.getByTestId('going-set-start').textContent).toBe('Set a start date →')
    expect(screen.getByTestId('going-batch-inputs').textContent).toBe('139 picks in')
  })

  it('renders the dehydrator card with its hours and both window bounds', () => {
    renderView([DEHYDRATOR])
    expect(screen.getByTestId('going-batch-title').textContent).toBe('Ghost peppers, dehydrating')
    expect(screen.getByTestId('going-batch-meta').textContent).toBe('4 hours · usually 8–12 days')
  })

  it('renders the repeated-stage card with its label and last-touched, and no window', () => {
    renderView([CANDY])
    expect(screen.getByTestId('going-batch-title').textContent).toBe('Candied ginger')
    expect(screen.getByTestId('going-batch-meta').textContent).toBe('12 days · Syrup rung 2 · last touched 2 days ago')
    expect(screen.getByTestId('going-batch-inputs').textContent).toBe('3 picks in')
  })

  it('renders a week-graded start as "about", the qualifier riding on the elapsed line', () => {
    renderView([{ ...CANDY, start_precision: 'week', current_stage_kind: 'started', current_stage_label: null }])
    expect(screen.getByTestId('going-batch-meta').textContent).toBe('about 12 days')
  })
})

describe('GoingNowView — an unknown start is a terminal state, not a defect', () => {
  it('shows NO prompt, no badge and no warning ink once the answer is "unknown"', () => {
    renderView([UNKNOWN_START])
    expect(screen.queryByTestId('going-set-start')).toBeNull()
    // Ruling 6: never a warning colour. P.terra / P.warnBorder / P.severityUrgent are the app's
    // alarm inks; none of them may appear anywhere on this card.
    expect(hasNoAlarmInk(screen.getByTestId('going-batch'))).toBe(true)
  })

  it('renders the never-asked card in the SAME ink and size as any other batch', () => {
    renderView([MASH, DEHYDRATOR])
    const [mashCard, dryCard] = screen.getAllByTestId('going-batch')
    const [mashTitle, dryTitle] = screen.getAllByTestId('going-batch-title')
    expect(mashTitle.getAttribute('style')).toBe(dryTitle.getAttribute('style'))
    expect(mashCard.getAttribute('style')).toBe(dryCard.getAttribute('style'))
  })
})

describe('GoingNowView — suspended renders distinctly from active', () => {
  it('lists active batches first and paused ones under their own heading', () => {
    renderView([PAUSED, CANDY])
    const cards = screen.getAllByTestId('going-batch')
    expect(cards.map(c => c.getAttribute('data-batch-id'))).toEqual(['kb-candy', 'kb-paused'])
    expect(screen.getByTestId('going-paused-heading').textContent).toBe('Paused')
    expect(screen.getByTestId('going-batch-paused').textContent).toBe('Paused since Aug 12')
    // Distinct chrome, not a warning tone — paused is fine, not late.
    expect(cards[1].style.borderStyle).toBe('dashed')
    expect(cards[0].style.borderStyle).toBe('solid')
  })

  it('renders no Paused heading when nothing is suspended', () => {
    renderView([CANDY, DEHYDRATOR])
    expect(screen.queryByTestId('going-paused-heading')).toBeNull()
  })
})

describe('GoingNowView — no readiness affordance anywhere', () => {
  it('never renders a countdown, a due date, a remaining-days figure or a progress element', () => {
    renderView([MASH, DEHYDRATOR, CANDY, UNKNOWN_START, PAUSED, FERMENT_EXACT])
    const html = screen.getByTestId('going-now-view').innerHTML
    expect(html).not.toMatch(/\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i)
    expect(screen.getByTestId('going-now-view').querySelector('progress')).toBeNull()
    expect(html).not.toMatch(/role="progressbar"/)
  })

  // ⚠ AMENDED 2026-09-04 BY V5-PHRECORD-001, and the amendment is narrow and deliberate.
  //
  // This assertion used to read `.not.toMatch(/\bpH\b|acidif|shelf.stab|\bsafe\b|\bsafety\b|botul/i)`,
  // and the `\bpH\b` arm has been REMOVED because it is now false by design. That arm was a
  // characterization of a ruling, not of a requirement: the adjudication it encoded forbade the app
  // to mention pH at all, was re-examined, and was found to have over-corrected — forbidding the word
  // also forbade asking the cook to MEASURE, which is the opposite of the thing it protected. The
  // card now asks whether you have measured and records what you measured.
  //
  // EVERY OTHER ARM SURVIVES UNCHANGED, and one is added. Mentioning pH is permitted; ASSESSING it is
  // not, and neither is naming a food-safety line — a number on this surface would be a threshold
  // whether or not any code compares to it. The sibling assertion on the CAPTURE surface
  // (CaptureFlow.kitchenBatch.test.jsx) keeps its `\bpH\b` arm and must NOT be widened or weakened:
  // pH belongs on the check-in, and nobody measures one while photographing a jar they just packed.
  it('may name pH, but says nothing about acidification, safety or shelf stability', () => {
    renderView([MASH, DEHYDRATOR, CANDY, UNKNOWN_START, PAUSED, FERMENT_EXACT])
    const html = screen.getByTestId('going-now-view').innerHTML
    expect(html).not.toMatch(/acidif|shelf.stab|\bsafe\b|\bsafety\b|botul|spoil/i)
    // No acid line, in any of the spellings the evidence base circulates. Full detail, plus the
    // source-level guard and its non-vacuity proof, in PutUpPhReading.test.jsx.
    expect(html).not.toMatch(/(?<![\d.])(4\.60|4\.6|4\.4|4\.2|4\.1|4\.0|3\.8|3\.3|5\.0)(?!\d)(?!\.\d)/)
    // Green control: the pH affordance IS on this surface, so the arms above are asserting absence
    // over a surface that actually renders it rather than over one where it never appeared.
    expect(html).toMatch(/\bpH\b/)
  })
})

describe('GoingNowView — Start a batch sits at the BOTTOM', () => {
  // ⚠ STRENGTHENED, NOT WEAKENED, 2026-09-04. `lastElementChild` was standing in for the claim in the
  // test's own name, and the two are not the same claim: it would keep passing if a card were ever
  // rendered outside the view's direct children, and it reds for the WRONG reason the moment anything
  // legitimate is appended. Both assertions are now made, so neither can rot into the other. Mutation
  // M13 ("Start-a-batch moved above the cards") was re-run against this version and still kills.
  it('is the last element of the view, below every card', () => {
    renderView([CANDY, PAUSED])
    const view = screen.getByTestId('going-now-view')
    const btn = screen.getByTestId('start-a-batch')
    expect(view.lastElementChild).toBe(btn)
    const cards = screen.getAllByTestId('going-batch')
    expect(cards).toHaveLength(2)   // instrument check: the loop below is not over an empty set
    for (const card of cards) {
      expect(`${card.getAttribute('data-batch-id')} precedes the button: `
        + `${!!(card.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING)}`)
        .toBe(`${card.getAttribute('data-batch-id')} precedes the button: true`)
    }
    expect(btn.textContent).toBe('🍲Start a batch')
  })

  it('is not a floating button', () => {
    renderView([CANDY])
    const btn = screen.getByTestId('start-a-batch')
    expect(btn.style.position).not.toBe('fixed')
    expect(btn.style.position).not.toBe('absolute')
  })

  it('is present on an empty list too, under the empty state and under the closed door', () => {
    renderView([])
    expect(screen.getByTestId('going-empty')).toBeTruthy()
    const btn = screen.getByTestId('start-a-batch')
    expect(screen.getByTestId('going-now-view').lastElementChild).toBe(btn)
    // Same strengthening as above, against the one other thing that now precedes it.
    expect(!!(screen.getByTestId('going-closed-door')
      .compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('routes to the camera-first capture flow', () => {
    renderView([CANDY])
    fireEvent.click(screen.getByTestId('start-a-batch'))
    expect(navigateMock).toHaveBeenCalledWith('/capture')
  })
})

describe('GoingNowView — a two-user household', () => {
  it('renders a peer\'s batch alongside your own; scoping is the server\'s job, not a client filter', () => {
    renderView([CANDY, JEN_BATCH])
    const titles = screen.getAllByTestId('going-batch-title').map(t => t.textContent)
    expect(titles).toEqual(["Jen's plum butter", 'Candied ginger'])
  })
})

describe('GoingNowView — setting a start date after the fact', () => {
  it('PUTs exactly the three start keys and nothing else on the allowlist', async () => {
    fetchMock.mockResolvedValue({ ...MASH, started_at: local('2026-08-17T09:00:00'), start_precision: 'week' })
    const onReload = vi.fn()
    renderView([MASH], { onReload })
    fireEvent.click(screen.getByTestId('going-set-start'))
    fireEvent.click(screen.getByTestId('going-start-chip-few_weeks'))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    const [path, opts] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/kitchen-batches/kb-mash')
    expect(opts.method).toBe('PUT')
    expect(Object.keys(JSON.parse(opts.body)).sort())
      .toEqual(['start_anchor_kind', 'start_precision', 'started_at'])
  })

  it('"Longer / not sure" writes the terminal grade with a null instant', async () => {
    fetchMock.mockResolvedValue({ ...MASH, start_precision: 'unknown' })
    renderView([MASH])
    fireEvent.click(screen.getByTestId('going-set-start'))
    fireEvent.click(screen.getByTestId('going-start-chip-unsure'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body))
      .toEqual({ started_at: null, start_precision: 'unknown', start_anchor_kind: 'memory' })
  })

  it('keeps the row and says so when the write fails', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    renderView([MASH])
    fireEvent.click(screen.getByTestId('going-set-start'))
    fireEvent.click(screen.getByTestId('going-start-chip-today'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't save that — try again."))
    expect(screen.getByTestId('going-start-chips')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the alarm-ink sweep is an instrument, not a formality', () => {
  // The sweep above was narrowed this session, and a narrowed absence assertion that has not been
  // re-proved is a vacuous one by default. This is the proof, standing: it must catch every ink it
  // claims to catch, drop exactly what is marked, and never drop the element it was handed.
  const painted = (style, attrs = {}) => {
    const el = document.createElement('span')
    for (const [prop, v] of Object.entries(style)) el.style[prop] = v
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    return el
  }

  it('catches all three inks, in the two ways a card can carry one', () => {
    for (const hex of [P.terra, P.warnBorder, P.severityUrgent]) {
      const host = document.createElement('div')
      host.appendChild(painted({ color: hex }))
      expect(`${hex} as text: ${hasNoAlarmInk(host)}`).toBe(`${hex} as text: false`)
      // M34's shape: the ink on an edge, written as the shorthand the component actually uses.
      expect(`${hex} as an edge: ${hasNoAlarmInk(painted({ border: `1px solid ${hex}` }))}`)
        .toBe(`${hex} as an edge: false`)
    }
    // The green control: an ordinary card ink is not a false positive.
    const clean = document.createElement('div')
    clean.appendChild(painted({ color: P.mid }))
    expect(hasNoAlarmInk(clean)).toBe(true)
  })

  it('drops only what is explicitly marked, and never the element being swept', () => {
    const one = document.createElement('div')
    one.appendChild(painted({ color: P.terra }, { 'data-alarm-ink-exempt': 'error' }))
    expect(hasNoAlarmInk(one)).toBe(true)
    // A marked node does not cover for an unmarked sibling.
    const two = document.createElement('div')
    two.appendChild(painted({ color: P.terra }, { 'data-alarm-ink-exempt': 'error' }))
    two.appendChild(painted({ color: P.terra }))
    expect(hasNoAlarmInk(two)).toBe(false)
    // And an element cannot exempt ITSELF — otherwise one attribute on the card would blind the sweep.
    expect(hasNoAlarmInk(painted({ border: `1px solid ${P.warnBorder}` }, { 'data-alarm-ink-exempt': 'x' })))
      .toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('GoingNowView — the one explicit door, and a card that stays inert', () => {
  it('renders exactly one door per card, in the action slot, with no arrow-free ambiguity', () => {
    renderView([CANDY, PAUSED])
    const doors = screen.getAllByTestId('going-open-batch')
    expect(doors).toHaveLength(2)
    expect(doors.map(d => d.textContent)).toEqual([OPEN_BATCH_CTA, OPEN_BATCH_CTA])
    expect(OPEN_BATCH_CTA).toBe('Open this batch →')
    // Same tap floor as the two inline expanders it is a sibling of.
    expect(doors[0].style.minHeight).toBe('44px')
  })

  it('hands the door the id of the card it sits on, in a two-user list', () => {
    const opened = []
    renderView([CANDY, JEN_BATCH])
    const cards = screen.getAllByTestId('going-batch')
    // Jen's row sorts first (started Sep 1 vs Aug 23), which is exactly why the wrong id would be
    // invisible in a single-owner fixture.
    expect(cards.map(c => c.getAttribute('data-batch-id'))).toEqual(['kb-jen', 'kb-candy'])
    for (const card of cards) {
      within(card).getByTestId('going-open-batch').click()
      opened.push(card.getAttribute('data-batch-id'))
    }
    expect(opened).toEqual(['kb-jen', 'kb-candy'])
  })
})

describe('GoingNowView — pause, the reversible give-up that had no writer', () => {
  it('PUTs exactly suspended_at, at the INJECTED instant, and merges nothing else', async () => {
    fetchMock.mockResolvedValue({ ...CANDY, suspended_at: new Date(NOW).toISOString() })
    const onReload = vi.fn()
    renderView([CANDY], { onReload })
    expect(screen.getByTestId('going-pause').textContent).toBe(PAUSE_CTA)
    expect(PAUSE_CTA).toBe('Pause this batch')
    fireEvent.click(screen.getByTestId('going-pause'))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    // The whole call as one literal. ph-style: the instant is the view's injected `now`, so this
    // assertion is stable under the blocking TZ re-run instead of racing the wall clock.
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-candy', {
      method: 'PUT', body: JSON.stringify({ suspended_at: new Date(NOW).toISOString() }),
    })
    expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body))).toEqual(['suspended_at'])
  })

  it('offers the way back on a paused card and NULLs the column', async () => {
    fetchMock.mockResolvedValue({ ...PAUSED, suspended_at: null })
    const onReload = vi.fn()
    renderView([PAUSED], { onReload })
    expect(screen.getByTestId('going-pause').textContent).toBe(RESUME_CTA)
    expect(RESUME_CTA).toBe('Pick it back up')
    fireEvent.click(screen.getByTestId('going-pause'))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-paused', {
      method: 'PUT', body: JSON.stringify({ suspended_at: null }),
    })
  })

  it('pauses the row you tapped, not the first one on screen', async () => {
    fetchMock.mockResolvedValue({})
    renderView([CANDY, JEN_BATCH])
    const cards = screen.getAllByTestId('going-batch')
    expect(cards[0].getAttribute('data-batch-id')).toBe('kb-jen')
    fireEvent.click(within(cards[1]).getByTestId('going-pause'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/kitchen-batches/kb-candy')
  })

  it('keeps the row and says so when the write fails — and the alert is not a card-body alarm', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    renderView([CANDY])
    fireEvent.click(screen.getByTestId('going-pause'))
    await waitFor(() => expect(screen.getByTestId('going-pause-error').textContent)
      .toBe("Couldn't save that — try again."))
    // Nothing was discarded: the row is exactly as it was. There is no offline queue in this app and
    // none is possible, so a clear failure is the honest answer — but it must not also lose state.
    expect(screen.getByTestId('going-batch-title').textContent).toBe('Candied ginger')
    expect(screen.getByTestId('going-pause').textContent).toBe(PAUSE_CTA)
    // POSITIVE ASSERTION over the same query on the same render: the ink really IS P.terra, so the
    // sweep below is exempting something that exists rather than passing over an empty carve-out.
    expect(screen.getByTestId('going-pause-error').style.color).toBe(toRgb(P.terra))
    expect(screen.getByTestId('going-pause-error').getAttribute('role')).toBe('alert')
    expect(hasNoAlarmInk(screen.getByTestId('going-batch'))).toBe(true)
  })

  it('pausePatch is a pure function of the injected clock and refuses a bad one', () => {
    expect(pausePatch(false, NOW)).toEqual({ suspended_at: new Date(NOW).toISOString() })
    expect(pausePatch(true, NOW)).toEqual({ suspended_at: null })
    expect(pausePatch(true, NaN)).toEqual({ suspended_at: null })   // resuming needs no clock
    expect(pausePatch(false, NaN)).toBeNull()
  })
})

describe('goingNow — a paused batch is not questioned', () => {
  // The card asked a PAUSED ferment whether it was still under the brine: the app questioning a batch
  // the user had explicitly set down. Both arms carry their own green control on the same fixture, so
  // neither absence can pass because the selector was wrong.
  const stale = { ...FERMENT_EXACT, current_stage_entered_at: local('2026-08-21T09:00:00') }

  it('submersionPrompt goes silent under suspension, and speaks without it', () => {
    expect(submersionPrompt(stale, NOW)).toBe(SUBMERSION_PROMPT)
    expect(submersionPrompt({ ...stale, suspended_at: '2026-08-25T12:00:00.000Z' }, NOW)).toBeNull()
  })

  it('renders the question on the active ferment and not on its set-down twin, in ONE render', () => {
    const setDown = { ...stale, id: 'kb-setdown', label: 'Set down', suspended_at: '2026-08-25T12:00:00.000Z' }
    renderView([stale, setDown])
    const byId = Object.fromEntries(screen.getAllByTestId('going-batch')
      .map(c => [c.getAttribute('data-batch-id'), c]))
    expect(within(byId['kb-ferment']).getByTestId('going-batch-submersion').textContent)
      .toBe(SUBMERSION_PROMPT)
    expect(within(byId['kb-setdown']).queryByTestId('going-batch-submersion')).toBeNull()
  })
})

describe('GoingNowView — the door to closed batches', () => {
  it('renders exactly one door, INSIDE the empty state, when nothing is going', () => {
    renderView([])
    const doors = screen.getAllByTestId('going-closed-door')
    expect(doors).toHaveLength(1)
    expect(doors[0].textContent).toBe(CLOSED_DOOR_CTA)
    expect(CLOSED_DOOR_CTA).toBe('Closed batches →')
    // The finding, asserted: the state in which a user hunts a six-week-old batch is the state that
    // used to hide the door entirely.
    expect(within(screen.getByTestId('going-empty')).getByTestId('going-closed-door')).toBeTruthy()
  })

  it('renders exactly one door, above Start a batch, when the list is populated', () => {
    renderView([CANDY, PAUSED])
    const doors = screen.getAllByTestId('going-closed-door')
    expect(doors).toHaveLength(1)
    expect(screen.queryByTestId('going-empty')).toBeNull()
    expect(!!(doors[0].compareDocumentPosition(screen.getByTestId('start-a-batch'))
      & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })
})

describe('GoingNowView — the counts arrive as STRINGS', () => {
  // Only linked_output_count is a real number on this wire; every other numeric comes back from the
  // driver as a string. `Number(...) === 1` across that boundary is the singular/plural branch, so a
  // number-typed fixture would certify a comparison the wire never makes.
  it('renders the singular and plural branches off string counts', () => {
    renderView([{ ...MASH, input_count: '139' }, { ...CANDY, id: 'kb-one', input_count: '1' }])
    expect(screen.getAllByTestId('going-batch-inputs').map(l => l.textContent))
      .toEqual(['1 pick in', '139 picks in'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE WIRE SHAPE, in ONE place. BUG-GOINGNOWENVELOPE-001: kitchenRoutes.js:172 returns
// `{ state, batches }` and apiFetch hands the parsed body back verbatim, so a list fixture that
// resolves a BARE ARRAY is an invented wire. This file's original fixture did exactly that, which is
// why 74 green tests could not see that PutUp.jsx set `going` to [] on every load in production.
// Every list fixture below goes through this helper so no test can drift back to the bare shape.
const listEnvelope = (batches, state = 'going') => ({ state, batches })

// THE BARE-OPEN DEFAULT — the whole discoverability fix, and one line of it.
const DETAIL_ROUTE = /^\/api\/kitchen-batches\/[^/?]+$/
function wirePage({ batches = [], batchesFail = false, closed = [], detail = null, detailFail = false } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches?state=closed')) {
      return Promise.resolve(listEnvelope(closed, 'closed'))
    }
    if (DETAIL_ROUTE.test(path) && method === 'GET') {
      return detailFail ? Promise.reject(new Error('no such row')) : Promise.resolve(detail)
    }
    if (path.startsWith('/api/kitchen-batches')) {
      return batchesFail ? Promise.reject(new Error('no such table')) : Promise.resolve(listEnvelope(batches))
    }
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants?')) return Promise.resolve([])
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups: [] })
    return Promise.resolve(null)
  })
}

function renderPage(prefill, search = '') {
  const entry = prefill ? { pathname: '/put-up', search, state: { prefill } } : { pathname: '/put-up', search }
  return render(<MemoryRouter initialEntries={[entry]}><PutUp /></MemoryRouter>)
}
// GETs only: the pause PUT lands on the same path as the detail GET, and a path-only census would
// let a write stand in for the read this page is being asserted to make.
const getPaths = () => fetchMock.mock.calls.filter(([, o]) => (o?.method ?? 'GET') === 'GET').map(([p]) => p)

// Scoped to the VIEW toggle by its aria-label: StoresView renders a second radiogroup (its own
// group-by facet), so an unscoped getAllByRole('radio') silently mixes the two.
function segments() {
  return within(screen.getByRole('radiogroup', { name: 'Put-Up view' })).getAllByRole('radio')
}
function activeSegment() {
  return segments().find(r => r.getAttribute('aria-checked') === 'true')?.textContent
}

describe('PutUp — the bare-open default lands on "Going now" when something is going', () => {
  it('shows the three segments in lifecycle order', async () => {
    wirePage()
    renderPage()
    await waitFor(() => expect(segments().map(r => r.textContent))
      .toEqual(['Going now', 'Log a put-up', "What's put up"]))
  })

  it('promotes a bare open to Going now with ONE open batch', async () => {
    wirePage({ batches: [CANDY] })
    renderPage()
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
    expect(screen.getByTestId('going-batch-title').textContent).toBe('Candied ginger')
  })

  it('promotes on a SUSPENDED-only list too — paused is still open', async () => {
    wirePage({ batches: [PAUSED] })
    renderPage()
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
  })

  it('falls back to "What\'s put up" when nothing is open', async () => {
    wirePage({ batches: [] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('putup-primary-cta')).toBeTruthy())
    expect(activeSegment()).toBe("What's put up")
  })

  it('leaves the landing EXACTLY as it is today when the route is unavailable', async () => {
    // The state this page is actually in until Dave applies the migration: every batch route 500s.
    // A failed read is not an empty list and must not move anything.
    wirePage({ batchesFail: true })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('putup-primary-cta')).toBeTruthy())
    expect(activeSegment()).toBe("What's put up")
  })

  it('never overrides a segment the user picked while the fetch was in flight', async () => {
    let release
    fetchMock.mockImplementation((path) => {
      if (path.startsWith('/api/kitchen-batches')) return new Promise(r => { release = () => r(listEnvelope([CANDY])) })
      if (path === '/api/storage-locations') return Promise.resolve([])
      if (path.startsWith('/api/plants?')) return Promise.resolve([])
      if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups: [] })
      return Promise.resolve(null)
    })
    renderPage()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    expect(activeSegment()).toBe('Log a put-up')
    release()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(activeSegment()).toBe('Log a put-up')
  })

  it('never yanks a harvest-prefilled open off the form', async () => {
    wirePage({ batches: [CANDY] })
    renderPage({ crop_type_slug: 'pepper', harvest_log_id: 'h-1' })
    await waitFor(() => expect(screen.getByTestId('putup-prefill-strip')).toBeTruthy())
    expect(activeSegment()).toBe('Log a put-up')
  })

  it('a manual tap reaches Going now from either other segment', async () => {
    wirePage({ batches: [] })
    renderPage()
    await waitFor(() => expect(activeSegment()).toBe("What's put up"))
    fireEvent.click(screen.getByRole('radio', { name: 'Going now' }))
    expect(within(screen.getByTestId('going-now-view')).getByTestId('going-empty')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BUG-GOINGNOWENVELOPE-001 — the payload the page actually receives.
//
// The bug was not a typo. Both sides were internally consistent and both were tested, and they
// disagreed about the shape of the thing BETWEEN them: kitchenRoutes.js asserted the envelope in its
// own suite while this file's fixture invented a bare array, so 74 green tests certified a page that
// set `going` to [] on every load in production. Nothing could see the gap because nothing crossed it.
describe('PutUp — the going list is read off the envelope the Lambda actually sends', () => {
  it('renders cards from { state, batches } and promotes the bare open off its length', async () => {
    wirePage({ batches: [CANDY, MASH] })
    renderPage()
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
    expect(screen.getAllByTestId('going-batch-title').map(t => t.textContent))
      .toEqual(['Candied ginger', 'Pepper mash'])
  })

  it('still accepts a bare array, and still treats anything else as "no answer"', () => {
    // The defensive arm, kept deliberately (src/lib/batches.js:38 does the same): coercing an
    // unrecognised payload straight to [] is exactly what disabled the feature silently instead of
    // failing loudly, so the recognised shapes are named and everything else is one branch.
    expect(batchRows({ state: 'going', batches: [MASH] })).toEqual([MASH])
    expect(batchRows([MASH])).toEqual([MASH])
    expect(batchRows(null)).toEqual([])
    expect(batchRows({ state: 'going' })).toEqual([])
    expect(batchRows({ state: 'going', batches: 'nope' })).toEqual([])
    expect(batchRows('nope')).toEqual([])
  })
})

// The guard across the two deploy artifacts. They cannot import each other, so the only thing a unit
// test can do is read the other side's source and bind the literal. Model: startChipParity.test.js.
describe('the going-list wire shape is BOUND to the Lambda, not assumed', () => {
  const LAMBDA = readFileSync(resolve(REPO, 'lambda/preservation/kitchenRoutes.js'), 'utf8')
  const PAGE = readFileSync(resolve(REPO, 'src/pages/PutUp.jsx'), 'utf8')
  const ENVELOPE = /return \{ status: 200, body: \{ state, (\w+): rows \} \};/

  it('the list handler returns a named-key envelope, and the key is `batches`', () => {
    // INSTRUMENT CHECK FIRST — prove we are reading the list handler before claiming anything about
    // its return, or a moved file / renamed path passes every assertion below over the wrong text.
    expect(LAMBDA).toContain('GET /api/kitchen-batches?state=going|closed|all')
    const found = LAMBDA.match(ENVELOPE)
    expect(found === null ? 'the list handler no longer returns { status: 200, body: { state, <key>: rows } } — '
      + 're-anchor this test against the real return rather than deleting it' : found[1]).toBe('batches')
  })

  it('the client unwraps THAT key, by name', () => {
    const key = LAMBDA.match(ENVELOPE)[1]
    expect(PAGE).toContain('export function batchRows(payload)')
    expect(new RegExp(`Array\\.isArray\\(payload\\?\\.${key}\\)\\s*\\?\\s*payload\\.${key}`).test(PAGE))
      .toBe(true)
    // Non-vacuity: the same probe must NOT find a key the Lambda does not send.
    expect(new RegExp('Array\\.isArray\\(payload\\?\\.rows\\)\\s*\\?\\s*payload\\.rows').test(PAGE))
      .toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// `?batch=<id>` AND `?state=closed` — MODE FLAGS on /put-up, never child routes.
describe('PutUp — the batch detail is a mode flag on this page', () => {
  const CANDY_DETAIL = { ...CANDY, inputs: [], stages: [], outputs: [] }

  it('the card\'s door opens the detail and asks the server for THAT batch', async () => {
    wirePage({ batches: [CANDY], detail: CANDY_DETAIL })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('going-open-batch')).toBeTruthy())
    fireEvent.click(screen.getByTestId('going-open-batch'))
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    expect(getPaths()).toContain('/api/kitchen-batches/kb-candy')
    // The list surface stands down and the way back is in the PAGE, because an installed PWA has no
    // address bar to offer one.
    expect(screen.queryByTestId('going-now-view')).toBeNull()
    expect(screen.getByTestId('putup-mode-back').textContent).toBe('← Going now')
    // NOT a route: nothing navigated. useNavigate is a no-op spy in this file, so on its own that
    // assertion would be worth nothing — the positive half is the line above it, which proves the
    // surface opened anyway.
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('opens straight from the URL, so a deep link and a tap land in the same place', async () => {
    wirePage({ batches: [CANDY], detail: CANDY_DETAIL })
    renderPage(null, '?batch=kb-candy')
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    expect(getPaths()).toContain('/api/kitchen-batches/kb-candy')
    // Both loaders are live in this mode — which is what makes onChanged able to re-read both.
    expect(getPaths()).toContain('/api/kitchen-batches?state=going')
  })

  it('the CARD itself is inert — only the labelled door opens anything', async () => {
    wirePage({ batches: [CANDY], detail: CANDY_DETAIL })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('going-batch')).toBeTruthy())
    for (const id of ['going-batch', 'going-batch-title', 'going-batch-meta']) {
      fireEvent.click(screen.getByTestId(id))
    }
    expect(screen.queryByTestId('putup-batch-mode')).toBeNull()
    expect(getPaths()).not.toContain('/api/kitchen-batches/kb-candy')
    // GREEN CONTROL, same queries, same render: the door DOES open it, so the three absences above
    // are about a card that is genuinely inert rather than about a click that never landed.
    fireEvent.click(screen.getByTestId('going-open-batch'))
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    expect(getPaths()).toContain('/api/kitchen-batches/kb-candy')
  })

  it('leaving the mode restores the segment the user was on, with no remount', async () => {
    wirePage({ batches: [CANDY], detail: CANDY_DETAIL })
    renderPage()
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
    fireEvent.click(screen.getByTestId('going-open-batch'))
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    fireEvent.click(screen.getByTestId('putup-mode-back'))
    await waitFor(() => expect(screen.getByTestId('going-now-view')).toBeTruthy())
    // The failure this shape exists to avoid: a child route unmounts PutUp, `view` re-initialises to
    // 'stores', and the recovery is a network round trip that does not even fire on an empty list.
    expect(activeSegment()).toBe('Going now')
    expect(screen.queryByTestId('putup-batch-mode')).toBeNull()
  })

  it('a failed detail read says so and leaves the way back', async () => {
    wirePage({ batches: [CANDY], detailFail: true })
    renderPage(null, '?batch=kb-candy')
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    expect(screen.getByTestId('putup-mode-back')).toBeTruthy()
  })

  // The invalidation contract, asserted where it can be: a write from a card re-reads the LIST. The
  // detail half of onChanged is bound below as source text, because BatchDetailView belongs to
  // another lane and this branch carries a placeholder for it — see the report.
  it('a write from the card re-reads the list rather than mutating it locally', async () => {
    wirePage({ batches: [CANDY] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('going-pause')).toBeTruthy())
    const before = getPaths().filter(p => p === '/api/kitchen-batches?state=going').length
    expect(before).toBe(1)
    fireEvent.click(screen.getByTestId('going-pause'))
    await waitFor(() => expect(getPaths().filter(p => p === '/api/kitchen-batches?state=going').length)
      .toBe(before + 1))
  })

  it('onChanged on the detail surface re-reads BOTH the row and the list', () => {
    const PAGE = readFileSync(resolve(REPO, 'src/pages/PutUp.jsx'), 'utf8')
    const bodyOf = (name) => PAGE.match(new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{([^}]*)\\}`))?.[1]
    // Green control: the handler is what the detail surface is actually given, and the probe finds a
    // body to look at. Without both, the two assertions below pass over `undefined`.
    expect(PAGE).toContain('onChanged={onBatchChanged}')
    expect(typeof bodyOf('onBatchChanged')).toBe('string')
    expect(bodyOf('onBatchChanged')).toContain('loadGoing()')
    expect(bodyOf('onBatchChanged')).toContain('loadDetail()')
    // Reopening from the closed list moves a row back into `going`, so that handler owes both too.
    expect(bodyOf('onClosedChanged')).toContain('loadClosed()')
    expect(bodyOf('onClosedChanged')).toContain('loadGoing()')
    // Non-vacuity: the probe does not report a call that is not there.
    expect(bodyOf('onBatchChanged')).not.toContain('loadClosed()')
  })
})

describe('PutUp — the closed list is the same kind of mode flag', () => {
  it('the door switches the page over and asks the server for closed rows', async () => {
    wirePage({ batches: [CANDY], closed: [JEN_CLOSED, CLOSED_PUTUP] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('going-closed-door')).toBeTruthy())
    fireEvent.click(screen.getByTestId('going-closed-door'))
    await waitFor(() => expect(screen.getByTestId('putup-closed-mode')).toBeTruthy())
    expect(getPaths()).toContain('/api/kitchen-batches?state=closed')
    expect(screen.queryByTestId('going-now-view')).toBeNull()
    expect(screen.getByTestId('putup-mode-back')).toBeTruthy()
  })

  it('does NOT fetch the closed list on an ordinary open', async () => {
    wirePage({ batches: [CANDY] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('going-now-view')).toBeTruthy())
    expect(getPaths()).not.toContain('/api/kitchen-batches?state=closed')
    // Green control over the same query on the same render: the page IS issuing list GETs, so the
    // absence above is about the closed one specifically.
    expect(getPaths()).toContain('/api/kitchen-batches?state=going')
  })

  it('opens straight from the URL, and `batch` wins when both are present', async () => {
    wirePage({ batches: [CANDY], closed: [CLOSED_PUTUP], detail: { ...CANDY, inputs: [], stages: [], outputs: [] } })
    renderPage(null, '?state=closed&batch=kb-candy')
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    // Opening a batch FROM the closed list must show that batch, not the list it came from.
    expect(screen.queryByTestId('putup-closed-mode')).toBeNull()
  })
})
