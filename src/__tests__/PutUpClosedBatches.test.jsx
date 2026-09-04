// V5-BATCHCLOSE-001 item C — the closed-batch archive on /put-up and its per-row Reopen.
//
// WHY THIS FILE EXISTS AT ALL, and it is the single largest risk in this build: every food-safety
// and readiness absence sweep this repo ships is scoped to `screen.getByTestId('going-now-view')`.
// Copy that moves to a NEW surface leaves all eight inherited rulings unguarded while the old sweeps
// stay GREEN — the assertion does not break, it stops being about anything. So this surface carries
// its OWN sweep, against its OWN root testid, and every absence arm below is paired with a positive
// assertion over the same query on the same render.
//
// TEST-SHAPE RULES THIS FILE HOLDS TO (each exists because the repo already shipped the failure):
//   • FULL LITERALS, both bounds and every separator. Nothing here asserts a fragment.
//   • TWO AGES MINIMUM on anything a clock decides. A single age is vacuous.
//   • FIXED ZONELESS LOCAL DATE LITERALS, and instants at 12:00Z — NOT 16:00Z. A timestamptz renders
//     its own calendar day in the reader's zone, so a literal has to sit far enough from both
//     midnights that no plausible CI zone moves it. 16:00Z looked safe, covered the two CI lanes,
//     and flipped a day in Tokyo. Every fixture below is inside one DST regime (2026 EDT runs
//     Mar 8 -> Nov 1), so `npm test` and the blocking TZ=America/New_York re-run agree by construction.
//   • FIXTURES FROM THE REAL DISTRIBUTION, including a TWO-USER PAIR — a single-owner fixture cannot
//     fail an ownership bug in a two-person household, and a reopen that binds the wrong row's id is
//     exactly an ownership bug.
//   • NUMERICS ARRIVE AS STRINGS. input_count / output_count are uncast bigint counts; every fixture
//     below carries them as strings, which is what makes a `=== 1` comparison detectable here.
//
// CI LANE: `npm test` (vitest run --coverage) plus the blocking TZ=America/New_York re-run.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import { P } from '../lib/constants.js'
import ClosedBatchesView, {
  CLOSED_BATCHES_PATH, reopenBatchPath, CLOSED_OUTCOME_LABELS, UNKNOWN_OUTCOME_LABEL,
  UNKNOWN_MONTH_LABEL, outcomeLabel, sortClosed, groupClosedByMonth,
} from '../components/putup/ClosedBatchesView.jsx'
// Read-only imports from the going-now half, used as CONTRAST rather than as machinery: the whole
// point of a separate sort is that these two disagree, and a test that never runs the other one
// cannot show that they do.
import { sortGoing, partitionGoing, isSuspended } from '../components/putup/goingNow.js'

// jsdom normalises every inline colour to `rgb(r, g, b)`, so a regex over the palette's HEX values
// matches NOTHING and passes no matter what colour the element is. Both of this repo's original
// "never a warning colour" assertions were written that way and a mutation run proved them vacuous.
// Compare converted values, never raw hex — and prove the converter works, below.
const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const ALARM_INKS = [P.terra, P.warnBorder, P.severityUrgent].map(toRgb)
const hasNoAlarmInk = (el) => ALARM_INKS.every(ink => !el.outerHTML.includes(ink))

// The fixed "now" every label below is measured against. Zoneless => local.
const NOW = new Date('2026-09-04T09:00:00').getTime()
// A second, LATER instant in a DIFFERENT CALENDAR YEAR. It is not decoration: with only one `now`
// in 2026, a component that ignored the prop and called Date.now() would stay green for the rest of
// this year and red on Jan 1. Two years is what pins the prop.
const NOW_NEXT_YEAR = new Date('2027-02-10T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()

// NOON UTC, not 16:00Z — see the header.
const CLOSED_AUG_28 = '2026-08-28T12:00:00.000Z'
const CLOSED_AUG_14 = '2026-08-14T12:00:00.000Z'
const CLOSED_JUL_09 = '2026-07-09T12:00:00.000Z'
const CLOSED_SEP_02 = '2026-09-02T12:00:00.000Z'

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
// NO FIXTURE ID CONTAINS AN OUTCOME VALUE, and that is a constraint rather than a coincidence. The
// "no stored value reaches the DOM" sweep below is deliberately blunt — a substring over innerHTML,
// because that is what catches an enum smuggled into an attribute — so an id like
// `kb-closed-abandoned` reds it on the FIXTURE rather than on the component. The first draft here
// had exactly that id and exactly that false red. A guard that cries wolf gets deleted; the id gets
// renamed instead.
// The pepper mash, finished. `put_up` is one of only two outcomes that produce any jars at all.
const CLOSED_PUTUP = {
  id: 'kb-closed-putup', user_id: 'user_dave', label: 'Pepper mash', kind: null, kind_other: null,
  started_at: local('2026-08-02T09:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-08-02T09:00:00'),
  expected_days_min: 21, expected_days_max: 42,
  suspended_at: null, closed_at: CLOSED_AUG_28, outcome: 'put_up', outcome_note: 'Two quarts',
  current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: CLOSED_AUG_28,
  input_count: '139', output_count: '2',
}
// D's reversible half, and a DISTINCT fixture rather than a spread of the one above: a spread shares
// every field it does not override, so a bug that reads the wrong row's data cannot surface through
// it. Started LATER and closed EARLIER than CLOSED_PUTUP — which is precisely what lets the ordering
// tests below tell `closed_at DESC` apart from the going-now `started_at DESC`.
const CLOSED_ABANDONED = {
  id: 'kb-closed-crock', user_id: 'user_dave', label: 'Crock of something', kind: 'ferment',
  kind_other: null,
  started_at: local('2026-08-10T09:00:00'), start_precision: 'week',
  first_recorded_at: local('2026-08-10T09:00:00'),
  expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: CLOSED_AUG_14, outcome: 'abandoned', outcome_note: null,
  current_stage_kind: 'tended', current_stage_label: 'Skimmed',
  current_stage_entered_at: local('2026-08-12T09:00:00'),
  input_count: '0', output_count: '0',
}
// Exists solely to drive the raw-value-must-not-render assertions: `discarded_spoiled` is the one
// stored value whose text collides with the food-safety sweep's own vocabulary.
const CLOSED_SPOILED = {
  id: 'kb-closed-kraut', user_id: 'user_dave', label: 'Kraut, second crock', kind: 'ferment',
  kind_other: null,
  started_at: local('2026-06-20T09:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-06-20T09:00:00'),
  expected_days_min: 21, expected_days_max: 42,
  suspended_at: null, closed_at: CLOSED_JUL_09, outcome: 'discarded_spoiled', outcome_note: null,
  current_stage_kind: 'failed', current_stage_label: null, current_stage_entered_at: CLOSED_JUL_09,
  input_count: '4', output_count: '0',
}
// The household peer. Jen owns nothing on prod today, which is exactly why a fixture has to.
const JEN_CLOSED = {
  id: 'kb-closed-jen', user_id: 'user_jen', label: "Jen's plum butter", kind: 'preserve',
  kind_other: null,
  started_at: local('2026-08-30T09:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-08-30T09:00:00'),
  expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: CLOSED_SEP_02, outcome: 'put_up', outcome_note: null,
  current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: CLOSED_SEP_02,
  input_count: '1', output_count: '6',
}
// A batch that WAS paused when it was closed. The close statement sets suspended_at = NULL alongside
// closed_at, so the pause is already gone from the row by the time it reaches this surface — which
// is the whole trap, and why the copy on this surface has to say so.
const PAUSED_THEN_CLOSED = {
  ...CLOSED_ABANDONED, id: 'kb-closed-waspaused', label: 'Candy parent, frozen',
  kind: 'candy', suspended_at: null, outcome: 'abandoned',
}

function renderView(batches, extra = {}) {
  return render(
    <MemoryRouter initialEntries={['/put-up']}>
      <ClosedBatchesView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} {...extra} />
    </MemoryRouter>,
  )
}

const ids = () => screen.getAllByTestId('closed-batch').map(c => c.getAttribute('data-batch-id'))

beforeEach(() => { fetchMock.mockReset() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('ordering — closed_at DESC, and deliberately NOT the going-now sort', () => {
  it('sorts newest-closed first, from either input order', () => {
    expect(sortClosed([CLOSED_ABANDONED, CLOSED_PUTUP]).map(r => r.id))
      .toEqual(['kb-closed-putup', 'kb-closed-crock'])
    expect(sortClosed([CLOSED_PUTUP, CLOSED_ABANDONED]).map(r => r.id))
      .toEqual(['kb-closed-putup', 'kb-closed-crock'])
  })

  // THE CONTRAST, and it is the thing that makes the assertion above non-vacuous: if these two
  // fixtures happened to sort the same way under both functions, "we did not reuse sortGoing" would
  // be unfalsifiable. They sort OPPOSITE ways, so reusing sortGoing is detectable.
  it('disagrees with sortGoing on these fixtures, which is why a separate sort exists', () => {
    expect(sortGoing([CLOSED_ABANDONED, CLOSED_PUTUP]).map(r => r.id))
      .toEqual(['kb-closed-crock', 'kb-closed-putup'])
    expect(sortClosed([CLOSED_ABANDONED, CLOSED_PUTUP]).map(r => r.id))
      .toEqual(['kb-closed-putup', 'kb-closed-crock'])
  })

  it('renders the rows in that order', () => {
    renderView([CLOSED_ABANDONED, CLOSED_PUTUP])
    expect(ids()).toEqual(['kb-closed-putup', 'kb-closed-crock'])
  })

  it('sorts a row with no readable closed_at LAST, never first', () => {
    const NO_DATE = { ...CLOSED_SPOILED, id: 'kb-closed-nodate', closed_at: null }
    expect(sortClosed([NO_DATE, CLOSED_PUTUP]).map(r => r.id))
      .toEqual(['kb-closed-putup', 'kb-closed-nodate'])
    // Green control on the same comparator: a readable date really does move a row to the front, so
    // the assertion above is about NULLS-LAST and not about input order surviving untouched.
    expect(sortClosed([CLOSED_ABANDONED, CLOSED_PUTUP]).map(r => r.id))
      .toEqual(['kb-closed-putup', 'kb-closed-crock'])
  })

  it('leaves TWO undated rows in the order the server sent them, rather than shuffling them', () => {
    const A = { ...CLOSED_PUTUP, id: 'kb-nodate-a', closed_at: null }
    const B = { ...CLOSED_SPOILED, id: 'kb-nodate-b', closed_at: null }
    expect(sortClosed([A, B]).map(r => r.id)).toEqual(['kb-nodate-a', 'kb-nodate-b'])
    expect(sortClosed([B, A]).map(r => r.id)).toEqual(['kb-nodate-b', 'kb-nodate-a'])
    // Green control: the comparator is live on this input — a dated row still overtakes both.
    expect(sortClosed([A, CLOSED_PUTUP, B]).map(r => r.id))
      .toEqual(['kb-closed-putup', 'kb-nodate-a', 'kb-nodate-b'])
  })

  it('leaves rows closed at the same instant in the order the server sent them', () => {
    const A = { ...CLOSED_PUTUP, id: 'kb-tie-a' }
    const B = { ...CLOSED_PUTUP, id: 'kb-tie-b' }
    expect(sortClosed([A, B]).map(r => r.id)).toEqual(['kb-tie-a', 'kb-tie-b'])
    expect(sortClosed([B, A]).map(r => r.id)).toEqual(['kb-tie-b', 'kb-tie-a'])
  })
})

describe('month grouping — an archive is not a flat scroll', () => {
  it('groups by the month a batch was closed, newest month first', () => {
    renderView([CLOSED_ABANDONED, JEN_CLOSED, CLOSED_PUTUP])
    expect(screen.getAllByTestId('closed-month-heading').map(h => h.textContent))
      .toEqual(['September', 'August'])
    expect(ids()).toEqual(['kb-closed-jen', 'kb-closed-putup', 'kb-closed-crock'])
  })

  it('renders ONE heading when everything closed in one month', () => {
    const { unmount } = renderView([CLOSED_ABANDONED, CLOSED_PUTUP])
    expect(screen.getAllByTestId('closed-month-heading').map(h => h.textContent)).toEqual(['August'])
    expect(ids()).toEqual(['kb-closed-putup', 'kb-closed-crock'])
    unmount()
    // Green control on the same query: it really does return two headings when there are two
    // months, so the single-heading assertion is about the grouping and not about a broken query.
    renderView([CLOSED_ABANDONED, JEN_CLOSED])
    expect(screen.getAllByTestId('closed-month-heading').map(h => h.textContent))
      .toEqual(['September', 'August'])
  })

  // TWO YEARS, and this pair is what proves `now` is an injected prop rather than a hidden
  // Date.now(). Same fixture, same month, two different injected clocks, two different literals.
  it('drops the year inside the current year and keeps it outside — full literals, both arms', () => {
    const { unmount } = renderView([CLOSED_PUTUP], { now: NOW })
    expect(screen.getByTestId('closed-month-heading').textContent).toBe('August')
    unmount()
    renderView([CLOSED_PUTUP], { now: NOW_NEXT_YEAR })
    expect(screen.getByTestId('closed-month-heading').textContent).toBe('August 2026')
  })

  it('gives a row with no readable closed_at its own group, at the bottom', () => {
    const NO_DATE = { ...CLOSED_SPOILED, id: 'kb-closed-nodate', closed_at: null }
    renderView([NO_DATE, CLOSED_PUTUP])
    expect(screen.getAllByTestId('closed-month-heading').map(h => h.textContent))
      .toEqual(['August', UNKNOWN_MONTH_LABEL])
    expect(ids()).toEqual(['kb-closed-putup', 'kb-closed-nodate'])
  })

  it('is a pure function of the rows and the clock', () => {
    const groups = groupClosedByMonth([CLOSED_ABANDONED, JEN_CLOSED, CLOSED_PUTUP], NOW)
    expect(groups.map(g => g.key)).toEqual(['2026-09', '2026-08'])
    expect(groups.map(g => g.label)).toEqual(['September', 'August'])
    expect(groups.map(g => g.batches.map(b => b.id)))
      .toEqual([['kb-closed-jen'], ['kb-closed-putup', 'kb-closed-crock']])
  })
})

describe('the row — label, provenance date, outcome, output count', () => {
  it('renders the meta line as one full literal, every separator included', () => {
    renderView([CLOSED_PUTUP])
    expect(screen.getByTestId('closed-batch-title').textContent).toBe('Pepper mash')
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe('closed Aug 28 · Put it up · 2 put-ups')
  })

  it('omits the output count entirely when nothing came off the batch', () => {
    renderView([CLOSED_ABANDONED])
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe('closed Aug 14 · Gave up on it')
  })

  // output_count arrives as a STRING. `'1' === 1` is false, so a raw === comparison silently
  // pluralises a single put-up; this pair is what detects that.
  it('reads output_count across the string boundary — 1 and 6, both full literals', () => {
    expect(typeof CLOSED_PUTUP.output_count).toBe('string')
    const ONE = { ...CLOSED_PUTUP, id: 'kb-one', output_count: '1' }
    const { unmount } = renderView([ONE])
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe('closed Aug 28 · Put it up · 1 put-up')
    unmount()
    renderView([JEN_CLOSED])
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe('closed Sep 2 · Put it up · 6 put-ups')
  })

  it('renders a batch whose closed_at is unreadable without inventing a date for it', () => {
    renderView([{ ...CLOSED_PUTUP, closed_at: null }])
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe('Put it up · 2 put-ups')
    // Green control on the same query: a readable date really does produce the `closed …` prefix.
    expect(sortClosed([CLOSED_PUTUP])[0].closed_at).toBe(CLOSED_AUG_28)
  })
})

describe('the outcome label table is TOTAL, and no stored value reaches the DOM', () => {
  it.each([
    ['put_up', 'Put it up'],
    ['put_up_different', 'Put it up — but not what I set out to make'],
    ['consumed', 'Ate it'],
    ['given_away', 'Gave it away'],
    ['discarded_spoiled', 'It spoiled — threw it out'],
    ['abandoned', 'Gave up on it'],
  ])('%s renders as its label, verbatim', (value, label) => {
    expect(outcomeLabel(value)).toBe(label)
    renderView([{ ...CLOSED_PUTUP, outcome: value, output_count: '0' }])
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe(`closed Aug 28 · ${label}`)
  })

  it('covers exactly the six DDL outcomes and no others', () => {
    expect(Object.keys(CLOSED_OUTCOME_LABELS).sort()).toEqual([
      'abandoned', 'consumed', 'discarded_spoiled', 'given_away', 'put_up', 'put_up_different',
    ])
    // A closed row cannot have a null outcome — chk_kitchen_batch_close_pairing is a biconditional —
    // so the null arm contributes no segment to the meta line rather than a placeholder label.
    expect(outcomeLabel(null)).toBeNull()
    expect(outcomeLabel(undefined)).toBeNull()
  })

  // THE FALLBACK IS NOT THE VALUE. A seventh outcome added server-side, a typo, a stale bundle:
  // whatever arrives, the DOM must not carry the machine string.
  it('falls back to a written label for an unknown value, never echoing the value', () => {
    renderView([{ ...CLOSED_PUTUP, outcome: 'composted', output_count: '0' }])
    const view = screen.getByTestId('closed-batches-view')
    expect(view.textContent).toContain(UNKNOWN_OUTCOME_LABEL)
    expect(view.innerHTML).not.toContain('composted')
    expect(outcomeLabel('composted')).toBe('Something else')
  })

  // The pair the whole ruling turns on: the LABEL may say "spoiled" — that is the cook's own report
  // of what happened, mandated wording, and it renders in text. The VALUE may not appear anywhere,
  // in any attribute, because a machine string in innerHTML reds a food-safety guard on something
  // that is not a claim. Absence arm and green control, same query, same render.
  it('renders the spoiled LABEL and never the discarded_spoiled VALUE', () => {
    renderView([CLOSED_SPOILED])
    const view = screen.getByTestId('closed-batches-view')
    expect(view.textContent).toContain('It spoiled — threw it out')
    expect(view.innerHTML).not.toContain('discarded_spoiled')
  })

  it('puts no outcome value in any attribute on any row', () => {
    renderView([CLOSED_PUTUP, CLOSED_SPOILED, CLOSED_ABANDONED, JEN_CLOSED])
    const view = screen.getByTestId('closed-batches-view')
    expect(view.querySelector('[data-outcome]')).toBeNull()
    // Green control: the selector machinery works and rows really are in this subtree — an
    // attribute query that returns null because the subtree is empty proves nothing.
    expect(view.querySelectorAll('[data-batch-id]')).toHaveLength(4)
    for (const value of Object.keys(CLOSED_OUTCOME_LABELS)) {
      expect(`${value} in DOM: ${view.innerHTML.includes(value)}`).toBe(`${value} in DOM: false`)
    }
    // The same claim again, attribute-precise, so it survives a future fixture whose id happens to
    // contain one of the six words: no attribute anywhere in the subtree HAS an outcome as its value.
    const attrValues = [...view.querySelectorAll('*')]
      .flatMap(el => [...el.attributes].map(a => a.value))
    expect(attrValues.length).toBeGreaterThan(10)
    expect(attrValues.filter(v => Object.keys(CLOSED_OUTCOME_LABELS).includes(v))).toEqual([])
  })
})

describe('the inherited rulings hold on THIS surface, not just on going-now', () => {
  const ALL = [CLOSED_PUTUP, CLOSED_ABANDONED, CLOSED_SPOILED, JEN_CLOSED, PAUSED_THEN_CLOSED]

  it('renders no countdown, no due date, no remaining-days figure and no progress element', () => {
    renderView(ALL)
    const view = screen.getByTestId('closed-batches-view')
    const html = view.innerHTML
    expect(html).not.toMatch(/\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i)
    expect(view.querySelector('progress')).toBeNull()
    expect(html).not.toMatch(/role="progressbar"/)
    // Green control: this really is a populated surface, so the arms above are asserting absence
    // over something rather than over an empty div.
    expect(html).toMatch(/closed Aug 28/)
    expect(screen.getAllByTestId('closed-batch')).toHaveLength(5)
  })

  // NOTE ON THE ONE ARM THAT IS DELIBERATELY ABSENT HERE. The going-now sweep includes `spoil` in
  // this regex. This surface must NOT copy that arm: `It spoiled — threw it out` is frozen wording
  // for an outcome the cook chose, and the app repeating the cook's own answer is not the app making
  // a food-safety claim. What is forbidden is the machine value and any assessment vocabulary — the
  // value is asserted absent in the block above, and the assessment vocabulary here.
  it('says nothing about acidification, safety or shelf stability, and names no acid line', () => {
    renderView(ALL)
    const view = screen.getByTestId('closed-batches-view')
    const html = view.innerHTML
    expect(html).not.toMatch(/acidif|shelf.stab|shelf.life|\bsafe\b|\bsafety\b|\bunsafe\b|botul/i)
    expect(html).not.toMatch(/(?<![\d.])(4\.60|4\.6|4\.4|4\.2|4\.1|4\.0|3\.8|3\.3|5\.0)(?!\d)(?!\.\d)/)
    // Green control: the surface really is rendering this lane's copy, including the one label whose
    // wording is closest to the forbidden vocabulary.
    expect(view.textContent).toContain('It spoiled — threw it out')
  })

  it('makes no assessment of whether any batch went well', () => {
    renderView(ALL)
    const text = screen.getByTestId('closed-batches-view').textContent
    expect(text).not.toMatch(/\bsucce\w*|\bfailed\b|\bgood\b|\bbad\b|\bshould have\b|\bnext time\b/i)
    expect(text).toContain('Gave up on it')
  })

  it('carries no urgency tone', () => {
    renderView(ALL)
    const text = screen.getByTestId('closed-batches-view').textContent
    expect(text).not.toMatch(/\bsoon\b|\burgent\b|\bhurry\b|\battention\b|!/)
    expect(text).toContain('Pepper mash')
  })

  it('paints no alarm ink on a closed row', () => {
    renderView(ALL)
    for (const row of screen.getAllByTestId('closed-batch')) {
      expect(`${row.getAttribute('data-batch-id')} alarm-free: ${hasNoAlarmInk(row)}`)
        .toBe(`${row.getAttribute('data-batch-id')} alarm-free: true`)
    }
  })

  // NON-VACUITY OF THE DETECTOR ITSELF. jsdom normalises inline colour to rgb(), so a hex-valued
  // check matches nothing and passes on any colour. This proves the converted comparison really does
  // catch an alarm ink before the five green rows above are allowed to mean anything.
  it('the alarm-ink detector actually catches an alarm ink', () => {
    const el = document.createElement('div')
    el.style.color = P.terra
    expect(hasNoAlarmInk(el)).toBe(false)
    const ok = document.createElement('div')
    ok.style.color = P.green
    expect(hasNoAlarmInk(ok)).toBe(true)
  })

  // The source half of the guard, in this lane's own file, because the shipped acid-line sweep's
  // LANE_SOURCES list lives in a file this lane does not own. Bounded read plus a sentinel: a moved
  // file, a typo'd path or an emptied tree would otherwise let every arm pass over an empty string.
  it('names no acid line in its own source', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../components/putup/ClosedBatchesView.jsx'), 'utf8')
    expect(src).toContain('closed-batches-view')
    expect(src.length).toBeGreaterThan(2000)
    expect(src.length).toBeLessThan(60000)
    const acidRe = (n) => new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?!\\d)(?!\\.\\d)`)
    for (const n of ['4.60', '4.6', '4.4', '4.2', '4.1', '4.0', '3.8', '3.3', '5.0']) {
      expect(`source contains ${n}: ${acidRe(n).test(src)}`).toBe(`source contains ${n}: false`)
    }
    // The regex must actually match the thing it is written to catch, or the nine rows above prove
    // nothing about anything.
    expect(acidRe('4.6').test('if (Number(ph) < 4.6) return "low"')).toBe(true)
    expect(acidRe('5.0').test("VALUES ('5.0.0-batchclose-20260904',")).toBe(false)
  })
})

describe('Reopen — the one door back out of a terminal act', () => {
  it('POSTs the reopen route for that row and asks the page to refetch', async () => {
    fetchMock.mockResolvedValue({ ...CLOSED_PUTUP, closed_at: null, outcome: null })
    const onReload = vi.fn()
    renderView([CLOSED_PUTUP], { onReload })
    fireEvent.click(screen.getByTestId('closed-batch-reopen'))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-closed-putup/reopen', { method: 'POST' })
  })

  // THE TWO-USER PAIR. Both rows are on screen; the tap is on Jen's. A reopen that binds the wrong
  // row's id — an index mix-up, a hoisted constant, a stale closure — is an ownership bug, and a
  // single-owner fixture cannot fail it.
  it('binds the tapped row\'s id, not the first row\'s, in a two-user household', async () => {
    fetchMock.mockResolvedValue({})
    renderView([CLOSED_PUTUP, JEN_CLOSED])
    expect(ids()).toEqual(['kb-closed-jen', 'kb-closed-putup'])
    const buttons = screen.getAllByTestId('closed-batch-reopen')
    fireEvent.click(buttons[0])
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-closed-jen/reopen', { method: 'POST' })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/kitchen-batches/kb-closed-putup/reopen', { method: 'POST' })
  })

  it('labels each row\'s control with the batch it acts on', () => {
    renderView([CLOSED_PUTUP, JEN_CLOSED])
    expect(screen.getAllByTestId('closed-batch-reopen').map(b => b.getAttribute('aria-label')))
      .toEqual(["Reopen Jen's plum butter", 'Reopen Pepper mash'])
  })

  // UNCONDITIONAL — V100's "reopen only while nothing is linked" was deleted. Both arms on the same
  // query: the row with jars and the row without both offer it.
  it('offers Reopen whether or not the batch produced anything', () => {
    renderView([CLOSED_PUTUP, CLOSED_ABANDONED])
    expect(screen.getAllByTestId('closed-batch-reopen')).toHaveLength(2)
    expect(screen.getAllByTestId('closed-batch-reopen').map(b => b.textContent)).toEqual(['Reopen', 'Reopen'])
    expect(Number(CLOSED_PUTUP.output_count)).toBeGreaterThan(0)
    expect(Number(CLOSED_ABANDONED.output_count)).toBe(0)
  })

  it('a double tap on one row sends ONE request, not two', async () => {
    let resolveFetch
    fetchMock.mockImplementation(() => new Promise(r => { resolveFetch = r }))
    renderView([CLOSED_PUTUP])
    const btn = screen.getByTestId('closed-batch-reopen')
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('closed-batch-reopen').textContent).toBe('Reopening…')
    resolveFetch({})
    await waitFor(() => expect(screen.getByTestId('closed-batch-reopen').textContent).toBe('Reopen'))
  })

  // The in-flight guard, which the disabled button alone does NOT cover: the OTHER rows' controls
  // stay enabled while one reopen is in flight, so without the guard a second row fires a second
  // write against a list that is about to be refetched underneath it. One reopen at a time, the
  // shipped restore rule.
  it('ignores a tap on a second row while one reopen is still in flight', async () => {
    let resolveFetch
    fetchMock.mockImplementation(() => new Promise(r => { resolveFetch = r }))
    renderView([CLOSED_PUTUP, JEN_CLOSED])
    const buttons = screen.getAllByTestId('closed-batch-reopen')
    fireEvent.click(buttons[0])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByTestId('closed-batch-reopen')[1])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolveFetch({})
    // Green control: once the first one lands, the second row's control works again.
    await waitFor(() => expect(screen.getAllByTestId('closed-batch-reopen')[0].textContent).toBe('Reopen'))
    fireEvent.click(screen.getAllByTestId('closed-batch-reopen')[1])
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenLastCalledWith('/api/kitchen-batches/kb-closed-putup/reopen', { method: 'POST' })
  })

  it('reports a failed reopen by name and leaves the row reopenable', async () => {
    fetchMock.mockRejectedValue(new Error('nope'))
    const onReload = vi.fn()
    renderView([CLOSED_PUTUP], { onReload })
    fireEvent.click(screen.getByTestId('closed-batch-reopen'))
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe('Couldn\'t reopen "Pepper mash" — try again.'))
    expect(onReload).not.toHaveBeenCalled()
    expect(screen.getByTestId('closed-batch-reopen').textContent).toBe('Reopen')
  })

  it('shows no error banner on the happy path', async () => {
    fetchMock.mockResolvedValue({})
    renderView([CLOSED_PUTUP])
    fireEvent.click(screen.getByTestId('closed-batch-reopen'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
    // Green control on the same query: the banner IS reachable on this surface.
    expect(screen.getByTestId('closed-batches-view')).toBeTruthy()
  })
})

describe('Reopen resumes the batch — and the copy says so', () => {
  it('states what reopening does, without promising the prior state back', () => {
    renderView([CLOSED_PUTUP])
    const note = screen.getByTestId('closed-reopen-note')
    expect(note.textContent)
      .toBe('Reopening a batch puts it back in Going now. One you had paused comes back going, not paused.')
    expect(note.textContent).not.toMatch(/back to paused|as it was|restores|exactly how|undo/i)
  })

  // paused -> closed -> reopened -> ACTIVE, asserted at the seam this lane owns. The close already
  // NULLed suspended_at, so the row the server hands back after a reopen carries neither closed_at
  // nor suspended_at — and the going-now list therefore files it as ACTIVE, not paused. Both arms,
  // same function, same render of the going-now partition.
  it('a batch that had been paused comes back ACTIVE, not paused', async () => {
    const reopened = { ...PAUSED_THEN_CLOSED, closed_at: null, outcome: null, outcome_note: null }
    fetchMock.mockResolvedValue(reopened)
    renderView([PAUSED_THEN_CLOSED])
    fireEvent.click(screen.getByTestId('closed-batch-reopen'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-closed-waspaused/reopen', { method: 'POST' })

    expect(isSuspended(reopened)).toBe(false)
    const { active, paused } = partitionGoing([reopened])
    expect(active.map(b => b.id)).toEqual(['kb-closed-waspaused'])
    expect(paused.map(b => b.id)).toEqual([])
    // Green control: the same partition really does file a suspended row under `paused`, so the
    // empty array above is a fact about this row rather than about a broken call.
    const stillPaused = partitionGoing([{ ...reopened, suspended_at: '2026-08-12T12:00:00.000Z' }])
    expect(stillPaused.paused.map(b => b.id)).toEqual(['kb-closed-waspaused'])
    expect(stillPaused.active.map(b => b.id)).toEqual([])
  })

  it('renders no paused chrome on a closed row that used to be paused', () => {
    renderView([PAUSED_THEN_CLOSED])
    const row = screen.getByTestId('closed-batch')
    expect(row.style.borderStyle).toBe('solid')
    expect(row.textContent).not.toMatch(/paused since/i)
    // Green control: the row rendered, with its own meta line.
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe('closed Aug 14 · Gave up on it')
  })
})

describe('route literals — one spelling, and it is the one the server parses', () => {
  it('queries state=closed, as a full literal', () => {
    expect(CLOSED_BATCHES_PATH).toBe('/api/kitchen-batches?state=closed')
    expect(reopenBatchPath('kb-closed-putup')).toBe('/api/kitchen-batches/kb-closed-putup/reopen')
  })

  // Wire-shape parity, modelled on startChipParity.test.js: text-read the state vocabulary out of
  // the Lambda and assert the literal this client sends is one the server actually accepts. A
  // `?state=finished` typo is otherwise a green client test and an empty list at runtime.
  it('sends a state the Lambda\'s parseBatchState accepts', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../../lambda/preservation/kitchenBatch.js'), 'utf8')
    // Green control on the read itself.
    expect(src).toContain('parseBatchState')
    const state = new URL(`https://x${CLOSED_BATCHES_PATH}`).searchParams.get('state')
    expect(state).toBe('closed')
    expect(src).toContain(`'${state}'`)
  })
})

describe('loading, error and empty', () => {
  it('renders the loading line and no rows while loading', () => {
    renderView([], { loading: true })
    expect(screen.getByTestId('closed-batches-view').textContent).toBe('Loading…')
    expect(screen.queryAllByTestId('closed-batch')).toHaveLength(0)
    expect(screen.queryByTestId('closed-empty')).toBeNull()
  })

  it('renders rows once loading is done — the control for the assertion above', () => {
    renderView([CLOSED_PUTUP])
    expect(screen.getAllByTestId('closed-batch')).toHaveLength(1)
  })

  it('renders a load error instead of an empty state', () => {
    renderView([], { error: true })
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load your closed batches — try again.')
    expect(screen.queryByTestId('closed-empty')).toBeNull()
  })

  it('renders the empty state, with no reopen note above it', () => {
    renderView([])
    expect(screen.getByTestId('closed-empty').textContent)
      .toBe('Nothing closed yet.When you close a batch out it moves here, with what happened to it.')
    expect(screen.queryByTestId('closed-reopen-note')).toBeNull()
    expect(screen.queryAllByTestId('closed-month-heading')).toHaveLength(0)
  })

  it('renders the reopen note once there is anything to reopen — the control for the arm above', () => {
    renderView([CLOSED_PUTUP])
    expect(screen.getByTestId('closed-reopen-note')).toBeTruthy()
    expect(screen.queryByTestId('closed-empty')).toBeNull()
  })

  it('tolerates a missing list without throwing', () => {
    renderView(undefined)
    expect(screen.getByTestId('closed-empty')).toBeTruthy()
  })

  // THE PRODUCTION CALL SHAPE. The page omits `now`, so the `?? Date.now()` arm is the one that
  // actually ships and every other test in this file takes the other one. The month LABEL is
  // deliberately not asserted as a full literal here: with the wall clock supplying the year it is
  // 'August' this year and 'August 2026' next, which is the whole reason the prop exists. What this
  // pins is that the default arm renders rather than throwing on an undefined clock.
  it('renders with `now` omitted, which is how the page calls it', () => {
    render(
      <MemoryRouter initialEntries={['/put-up']}>
        <ClosedBatchesView batches={[CLOSED_PUTUP]} loading={false} error={false} onReload={vi.fn()} />
      </MemoryRouter>,
    )
    expect(ids()).toEqual(['kb-closed-putup'])
    expect(screen.getAllByTestId('closed-month-heading')).toHaveLength(1)
    expect(screen.getByTestId('closed-month-heading').textContent).toMatch(/^August( \d{4})?$/)
    expect(screen.getByTestId('closed-batch-meta').textContent).toBe('closed Aug 28 · Put it up · 2 put-ups')
  })
})
