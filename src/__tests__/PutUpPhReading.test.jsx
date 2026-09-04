// V5-PHRECORD-001 — recording a measured pH on the Going-now card, prompting for one, linking to how.
//
// ⚠ THE LINE EVERY ASSERTION IN THIS FILE SITS ON:
//   FORBIDDEN — derive, score, colour, gate, compare to a threshold, or infer from elapsed time.
//   PERMITTED — record a measured value verbatim, prompt someone to measure, link to how.
// The last describe block is the guard that keeps the forbidden half out of the lane's SOURCE, and it
// is the reason this file exists as much as the behaviour above it is.
//
// TEST-SHAPE RULES, inherited from PutUpGoingNow.test.jsx and each one earned:
//   • FULL LITERALS, both bounds and every separator. `toContain` on a fragment passes on a value ten
//     days wrong — this repo shipped exactly that.
//   • BOTH BOUNDS OF EVERY THRESHOLD. A single value proves a boundary exists, not where it is.
//   • FIXED ZONELESS LOCAL DATE LITERALS through `local()`, never Date.now() offsets, so the blocking
//     TZ=America/New_York CI re-run has something to bite on. `local()` parses and renders in the same
//     zone, so both the elapsed arithmetic AND the rendered "Sep 2" agree under every CI lane.
//   • `now` INJECTED into the view, never the wall clock — it is also what pins ph_read_at in the
//     POST body to a fixed literal instead of to whenever the test happened to run.
//   • EVERY "must be absent" ASSERTION PAIRED WITH A GREEN CONTROL. A sweep over the wrong file, or
//     over an empty string, passes for the wrong reason; each guard below first proves it is looking
//     at the thing it claims to be looking at.
//
// CI LANE: `npm test` (vitest run --coverage) plus the blocking TZ re-run. Not the integration
// workflow — migrations/v5-phrecord-001 is deliberately UNAPPLIED, so there is no database to test
// against and every assertion bites on logic or on what the client SENDS.
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
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => navigateMock }
})

import { P } from '../lib/constants.js'
import GoingNowView from '../components/putup/GoingNowView.jsx'
import {
  phReadingText, describeLastPhReading, phPromptAnchor, phPrompt, phRecorderVisible, phStagePatch,
  PH_PROMPT, PH_CHECK_DAYS, PH_STAGE_KIND, PH_SCALE_MIN, PH_SCALE_MAX, PH_SCALE_HINT,
  PH_RECORD_CTA, PH_INSTRUMENT_NOTE, PH_LINK_URL, PH_LINK_LABEL, SUBMERSION_PROMPT,
} from '../components/putup/goingNow.js'

// jsdom normalises every inline colour to `rgb(r, g, b)`, so a regex over the palette's HEX values
// matches NOTHING and passes no matter what colour the element is — a vacuity this repo has already
// been bitten by once. Compare converted values, never raw hex.
const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const ALARM_INKS = [P.terra, P.warnBorder, P.severityUrgent].map(toRgb)
// ⚠ NARROWED 2026-09-04 by V5-BATCHCLOSE-001, in step with the identical helper in
// PutUpGoingNow.test.jsx — see that file's block for the full reasoning and for the standing
// instrument proof that all three inks still kill and that the carve-out cannot widen by accident.
// In one sentence: the ruling is that the card BODY never reddens for a batch that is fine, not that
// a role="alert" error string may not use the house error ink; without the carve-out a FAILED WRITE
// would red a test whose subject is the pH prompt.
const hasNoAlarmInk = (el) => {
  const clone = el.cloneNode(true)
  clone.querySelectorAll('[data-alarm-ink-exempt]').forEach(n => n.remove())
  return ALARM_INKS.every(ink => !clone.outerHTML.includes(ink))
}

const NOW = new Date('2026-09-04T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
// The jalapeño ferment: a KNOWN ferment, started exactly, last touched Aug 31, and with no reading
// ever recorded — which is the state every ferment in the system is in today.
const FERMENT = {
  id: 'kb-ferment', user_id: 'user_dave', label: 'Jalapeño ferment', kind: 'ferment',
  started_at: local('2026-08-21T09:00:00'), start_precision: 'exact',
  first_recorded_at: local('2026-08-21T09:00:00'),
  expected_days_min: 21, expected_days_max: 42, suspended_at: null, closed_at: null,
  current_stage_kind: 'tended', current_stage_label: 'Skimmed',
  current_stage_entered_at: local('2026-08-31T09:00:00'), input_count: 12, output_count: 0,
  last_ph_reading: null, last_ph_read_at: null,
}
// The pepper mash this whole schema was built for: kind NULL because the capture path never asks,
// start NEVER ASKED (start_precision null, a different claim from 'unknown'). It is the batch that
// proves the recorder has to be offered on an unclassified row — a strict gate would lock the one
// real ferment in the system out of the feature.
const MASH = {
  id: 'kb-mash', user_id: 'user_dave', label: 'Pepper mash', kind: null, kind_other: null,
  started_at: null, start_precision: null, first_recorded_at: local('2026-08-30T09:00:00'),
  expected_days_min: 21, expected_days_max: 42, suspended_at: null, closed_at: null,
  current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: local('2026-08-30T09:00:00'), input_count: 139, output_count: 0,
  last_ph_reading: null, last_ph_read_at: null,
}
// A known NON-ferment. "Record a pH reading" on a dehydrator run is noise, and "have you measured
// the pH" on one is nonsense.
const DRY = {
  id: 'kb-dry', user_id: 'user_dave', label: 'Ghost peppers, dehydrating', kind: 'dehydrate',
  started_at: local('2026-09-04T05:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-09-04T05:00:00'),
  expected_days_min: 8, expected_days_max: 12, suspended_at: null, closed_at: null,
  current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: local('2026-09-04T05:00:00'), input_count: 0, output_count: 0,
  last_ph_reading: null, last_ph_read_at: null,
}
// A ferment that HAS a reading, recorded with the trailing digit a meter displays. Sep 2 is inside
// the cadence gap on purpose, so this fixture exercises the rendered line rather than the prompt.
const FERMENT_READ = {
  ...FERMENT, id: 'kb-read', label: 'Kraut crock',
  last_ph_reading: '4.60', last_ph_read_at: local('2026-09-02T09:00:00'),
}

function renderView(batches, extra = {}) {
  return render(
    <MemoryRouter initialEntries={['/put-up']}>
      <GoingNowView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} {...extra} />
    </MemoryRouter>,
  )
}

beforeEach(() => { fetchMock.mockReset(); navigateMock.mockReset() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('phReadingText — the value survives as typed', () => {
  // THE REQUIREMENT, not a nicety. Number('4.60') is 4.6 and the trailing digit the meter displayed
  // is gone; toFixed(1) would rewrite a two-decimal meter reading into a one-decimal one. Nothing in
  // this path may round, pad, coerce or re-format.
  // Mutation: return Number(t).toFixed(1) — the first, third and fourth rows red.
  it.each([
    ['4.60', '4.60'],
    ['3.2', '3.2'],
    ['  6.05  ', '6.05'],
    ['7', '7'],
    ['0', '0'],
  ])('%s reads back exactly as "%s"', (raw, expected) => {
    expect(phReadingText(raw)).toBe(expected)
  })

  it('returns null for nothing at all, rather than an empty-looking zero', () => {
    expect(phReadingText(null)).toBeNull()
    expect(phReadingText(undefined)).toBeNull()
    expect(phReadingText('')).toBeNull()
    expect(phReadingText('   ')).toBeNull()
  })
})

describe('describeLastPhReading — both halves or neither', () => {
  // A reading with no instant is not a dated line, and a dated line is the ONLY shape a reading is
  // allowed to take: rendering the bare number would make it read as the batch's CURRENT pH, which is
  // a state claim the app has no basis for and is not permitted to make.
  it('returns the value and its instant together', () => {
    expect(describeLastPhReading(FERMENT_READ))
      .toEqual({ text: '4.60', at: local('2026-09-02T09:00:00') })
  })

  it('returns null when either half is missing or unusable', () => {
    expect(describeLastPhReading({ ...FERMENT_READ, last_ph_read_at: null })).toBeNull()
    expect(describeLastPhReading({ ...FERMENT_READ, last_ph_reading: null })).toBeNull()
    expect(describeLastPhReading({ ...FERMENT_READ, last_ph_read_at: 'whenever' })).toBeNull()
    expect(describeLastPhReading(FERMENT)).toBeNull()
    expect(describeLastPhReading(null)).toBeNull()
  })
})

describe('phPromptAnchor — three tiers, and the last one is NOT NULL by design', () => {
  // The real anchor is "when did you last measure". The other two exist only so a batch with no
  // reading yet still gets asked once — and the third is what answers the started_at-is-NULL case,
  // which is not an edge: kind and start are both nullable and the capture path asks for neither.
  it('prefers the last reading, then the start, then the honest floor', () => {
    expect(phPromptAnchor({ last_ph_read_at: 'A', started_at: 'B', first_recorded_at: 'C' })).toBe('A')
    expect(phPromptAnchor({ last_ph_read_at: null, started_at: 'B', first_recorded_at: 'C' })).toBe('B')
    expect(phPromptAnchor({ last_ph_read_at: null, started_at: null, first_recorded_at: 'C' })).toBe('C')
    expect(phPromptAnchor({ last_ph_read_at: null, started_at: null, first_recorded_at: null })).toBeNull()
    expect(phPromptAnchor(null)).toBeNull()
  })

  // The precedence has to BITE, not merely exist: a batch measured an hour ago must fall silent even
  // though its start is a fortnight back, which is the case a started_at-only anchor would get wrong.
  it('a reading an hour old silences a prompt a fortnight of elapsed time would fire', () => {
    const justRead = { ...FERMENT, last_ph_read_at: local('2026-09-04T08:00:00'), last_ph_reading: '3.4' }
    expect(phPrompt(FERMENT, NOW)).toBe(PH_PROMPT)
    expect(phPrompt(justRead, NOW)).toBeNull()
  })

  // …and the fallback has to bite too: a permanently-unknown start still gets asked, off the floor.
  it('asks off first_recorded_at when the start was never asked or is permanently unknown', () => {
    const neverAsked = { ...FERMENT, kind: 'ferment', started_at: null, start_precision: null }
    const unknown = { ...FERMENT, kind: 'ferment', started_at: null, start_precision: 'unknown' }
    expect(phPrompt(neverAsked, NOW)).toBe(PH_PROMPT)
    expect(phPrompt(unknown, NOW)).toBe(PH_PROMPT)
    // …and stays silent when even the floor is recent, so the fallback is a cadence and not a
    // permanent nag.
    expect(phPrompt({ ...neverAsked, first_recorded_at: local('2026-09-04T08:00:00') }, NOW)).toBeNull()
  })
})

describe('phPrompt — UMN Extension\'s published 1-to-2-day cadence', () => {
  it('asks a question and stops — no verdict, no number, no second clause', () => {
    expect(phPrompt(FERMENT, NOW)).toBe('Measured the pH in the last day or two?')
    expect(PH_PROMPT.endsWith('?')).toBe(true)
    // It must not name a value, a target or an outcome. A prompt that says what to look for is a
    // threshold wearing a question mark.
    expect(PH_PROMPT).not.toMatch(/\d/)
    expect(PH_PROMPT).not.toMatch(/\bsafe\b|\bsafety\b|acidif|shelf|botul|spoil|\bready\b|below|above|under|over/i)
    // Two questions on one card, and neither is the other.
    expect(PH_PROMPT).not.toBe(SUBMERSION_PROMPT)
  })

  it('fires at the outer bound and not a second before it', () => {
    const read = (iso) => ({ ...FERMENT, last_ph_reading: '4.60', last_ph_read_at: local(iso) })
    expect(PH_CHECK_DAYS).toBe(2)
    expect(phPrompt(read('2026-09-03T09:00:00'), NOW)).toBeNull()          // 1 day
    expect(phPrompt(read('2026-09-02T09:00:01'), NOW)).toBeNull()          // 2 days less a second
    expect(phPrompt(read('2026-09-02T09:00:00'), NOW)).toBe(PH_PROMPT)     // exactly 2 days
    expect(phPrompt(read('2026-08-21T09:00:00'), NOW)).toBe(PH_PROMPT)     // 14 days
  })

  // SCOPED TO A KNOWN FERMENT, exactly as the submersion prompt is, and `kind IS NULL` is SILENT.
  // kind is nullable because the capture path never asks, so null means "nobody said" — and asking
  // for a pH on what might be a dehydrator run fails open into nonsense. Swept across the whole
  // vocabulary rather than spot-checked, because a gate that lets one kind through lets them all.
  it('never asks about pH on anything that is not a KNOWN ferment', () => {
    for (const kind of [null, undefined, 'other', 'dehydrate', 'candy', 'cure', 'infuse', 'age']) {
      expect(phPrompt({ ...FERMENT, kind }, NOW)).toBeNull()
    }
    expect(phPrompt(MASH, NOW)).toBeNull()
    expect(phPrompt(DRY, NOW)).toBeNull()
    // Control: the same fixture WITH the kind fires, so the sweep above is refusing on the kind and
    // not on something incidental to the fixture.
    expect(phPrompt(FERMENT, NOW)).toBe(PH_PROMPT)
  })

  it('is silent on a row with no instant at all, rather than treating missing as ancient', () => {
    expect(phPrompt({ ...FERMENT, started_at: null, first_recorded_at: null }, NOW)).toBeNull()
    expect(phPrompt({ ...FERMENT, started_at: 'not a date', first_recorded_at: null }, NOW)).toBeNull()
    expect(phPrompt(null, NOW)).toBeNull()
  })
})

describe('phRecorderVisible — wider than the prompt, and deliberately', () => {
  // The prompt is the app SPEAKING and must not ask a nonsense question. The recorder is a door the
  // cook opens, and offering it makes no claim — so it stays open on an UNCLASSIFIED batch, because
  // kind NULL means "nobody said" and the one real ferment in the system is in exactly that state
  // with no kind editor on this card.
  //
  // 'other' is EXCLUDED, and the distinction is the same one the start fields already draw twice:
  // NULL is a blank, 'other' is an ANSWER. Overriding an answer is a different act from filling a
  // blank.
  it('offers on a known ferment and on an unclassified batch, never on a named non-ferment', () => {
    expect(phRecorderVisible(FERMENT)).toBe(true)
    expect(phRecorderVisible(MASH)).toBe(true)
    expect(phRecorderVisible({ ...FERMENT, kind: undefined })).toBe(true)
    for (const kind of ['other', 'dehydrate', 'candy', 'cure', 'infuse', 'age']) {
      expect(phRecorderVisible({ ...FERMENT, kind })).toBe(false)
    }
    expect(phRecorderVisible(null)).toBe(false)
  })
})

describe('phStagePatch — what gets sent, and what never does', () => {
  const AT = local('2026-09-04T09:00:00')

  it('sends the trimmed string, the read instant, and a tended stage — nothing else', () => {
    expect(phStagePatch('4.60', AT)).toEqual({ stage_kind: 'tended', ph_reading: '4.60', ph_read_at: AT })
    expect(phStagePatch('  3.2 ', AT)).toEqual({ stage_kind: 'tended', ph_reading: '3.2', ph_read_at: AT })
    expect(PH_STAGE_KIND).toBe('tended')
  })

  // The whole payload as one literal: a patch that grew a fourth key — a status, a flag, a note the
  // app wrote for you — would pass an assertion written key-by-key.
  it('carries exactly three keys', () => {
    expect(Object.keys(phStagePatch('4.60', AT))).toEqual(['stage_kind', 'ph_reading', 'ph_read_at'])
  })

  // BOTH BOUNDS of the pH SCALE — which is the scale's definitional range and not a safety band: it
  // is symmetric, it prefers no reading to any other, and it excludes nothing a meter or a strip can
  // produce. It catches a fat-finger; a strip cannot read 46.
  it('accepts both ends of the scale and refuses just outside either', () => {
    expect(PH_SCALE_MIN).toBe(0)
    expect(PH_SCALE_MAX).toBe(14)
    expect(phStagePatch('0', AT).ph_reading).toBe('0')
    expect(phStagePatch('14', AT).ph_reading).toBe('14')
    expect(phStagePatch('-0.1', AT)).toBeNull()
    expect(phStagePatch('14.1', AT)).toBeNull()
    expect(phStagePatch('46', AT)).toBeNull()
  })

  it('refuses anything that is not a number, and anything with no instant', () => {
    expect(phStagePatch('four point six', AT)).toBeNull()
    expect(phStagePatch('', AT)).toBeNull()
    expect(phStagePatch(null, AT)).toBeNull()
    expect(phStagePatch('4.60', null)).toBeNull()
    expect(phStagePatch('4.60', 'whenever')).toBeNull()
  })
})

describe('GoingNowView — the prompt and the recorded line on the card', () => {
  it('renders the question in the card\'s ordinary ink, never as a badge or a warning colour', () => {
    renderView([FERMENT])
    const line = screen.getByTestId('going-batch-ph-prompt')
    expect(line.textContent).toBe('Measured the pH in the last day or two?')
    expect(line.style.color).toBe(toRgb(P.mid))
    const card = screen.getByTestId('going-batch')
    // POSITIVE ASSERTION over the same query on the same render: the sweep is reading a real, styled
    // card rather than an empty element, and nothing on it is carrying the exemption attribute — so
    // the absence below is about the paint, not about a carve-out that quietly swallowed the card.
    expect(card.outerHTML).toContain(toRgb(P.border))
    expect(card.querySelectorAll('[data-alarm-ink-exempt]')).toHaveLength(0)
    expect(hasNoAlarmInk(card)).toBe(true)
  })

  // The prompt is the app speaking, and it must not talk over a batch the cook has explicitly set
  // down: a PAUSED ferment was still being asked whether it had been measured. Both arms in one
  // render off one fixture, so the absence cannot pass because the selector was wrong.
  it('asks nothing of a PAUSED ferment, while its unpaused twin is still asked', () => {
    const setDown = { ...FERMENT, id: 'kb-setdown', label: 'Set down', suspended_at: '2026-08-25T12:00:00.000Z' }
    renderView([FERMENT, setDown])
    const byId = Object.fromEntries(screen.getAllByTestId('going-batch')
      .map(c => [c.getAttribute('data-batch-id'), c]))
    expect(within(byId['kb-ferment']).getByTestId('going-batch-ph-prompt').textContent).toBe(PH_PROMPT)
    expect(within(byId['kb-setdown']).queryByTestId('going-batch-ph-prompt')).toBeNull()
    // The RECORDER is deliberately not gated the same way — a reading taken on a paused ferment is
    // still a fact, and the door the cook opens makes no claim about the batch.
    expect(within(byId['kb-setdown']).getByTestId('going-ph-open').textContent).toBe(PH_RECORD_CTA)
  })

  it('phPrompt itself is silent under suspension and speaks without it', () => {
    expect(phPrompt(FERMENT, NOW)).toBe(PH_PROMPT)
    expect(phPrompt({ ...FERMENT, suspended_at: '2026-08-25T12:00:00.000Z' }, NOW)).toBeNull()
  })

  it('renders the recorded value VERBATIM with the date it was taken, as one line', () => {
    renderView([FERMENT_READ])
    expect(screen.getByTestId('going-batch-ph-last').textContent).toBe('pH 4.60 recorded Sep 2')
    expect(screen.getByTestId('going-batch-ph-last').style.color).toBe(toRgb(P.mid))
    // Mutation: render Number(text).toFixed(1) — the literal above reds on the trailing zero.
  })

  // ⚠ NEVER AN AGGREGATE. A batch that never acidified produces an unbroken run of "checked" entries,
  // so a count, a streak, a badge or a run of ticks turns absent failure signs into apparent success.
  // The same rule already binds the submersion prompt; this is it applied to the readings.
  it('shows one dated line and never a count, a streak, a tick or a badge', () => {
    renderView([FERMENT_READ])
    const card = screen.getByTestId('going-batch')
    expect(card.querySelectorAll('[data-testid="going-batch-ph-last"]')).toHaveLength(1)
    expect(card.textContent).not.toMatch(/\d+\s*(checks?|readings?|times|in a row)/i)
    expect(card.textContent).not.toMatch(/[✓✔✅×✗]/)
    expect(card.textContent).not.toMatch(/streak|so far|consecutive|average|highest|lowest|trend/i)
  })

  it('never renders a reading without its date', () => {
    renderView([{ ...FERMENT_READ, last_ph_read_at: null }])
    expect(screen.queryByTestId('going-batch-ph-last')).toBeNull()
    expect(screen.getByTestId('going-batch').textContent).not.toMatch(/4\.60/)
  })

  it('asks nothing about pH on a known non-ferment, and offers no recorder there either', () => {
    renderView([DRY])
    expect(screen.queryByTestId('going-batch-ph-prompt')).toBeNull()
    expect(screen.queryByTestId('going-ph-open')).toBeNull()
  })

  it('offers the recorder on an unclassified batch while staying silent about it', () => {
    renderView([MASH])
    expect(screen.queryByTestId('going-batch-ph-prompt')).toBeNull()
    expect(screen.getByTestId('going-ph-open').textContent).toBe(PH_RECORD_CTA)
  })
})

describe('GoingNowView — recording a reading', () => {
  const openEditor = () => {
    renderView([FERMENT])
    fireEvent.click(screen.getByTestId('going-ph-open'))
  }

  it('POSTs the string the cook typed, the injected instant, and a tended stage', async () => {
    fetchMock.mockResolvedValue({ stage: {}, batch: {} })
    openEditor()
    fireEvent.change(screen.getByTestId('going-ph-input'), { target: { value: '4.60' } })
    fireEvent.click(screen.getByTestId('going-ph-save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // The whole call as one literal — path, method and body. ph_read_at is the view's INJECTED `now`,
    // which is what makes this assertion stable under the blocking TZ re-run.
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-ferment/stages', {
      method: 'POST',
      body: JSON.stringify({
        stage_kind: 'tended', ph_reading: '4.60', ph_read_at: new Date(NOW).toISOString(),
      }),
    })
  })

  it('says so and sends nothing when the value is off the pH scale', async () => {
    openEditor()
    fireEvent.change(screen.getByTestId('going-ph-input'), { target: { value: '46' } })
    fireEvent.click(screen.getByTestId('going-ph-save'))
    expect(screen.getByTestId('going-ph-error').textContent).toBe(PH_SCALE_HINT)
    expect(PH_SCALE_HINT).toBe('A pH reading is a number from 0 to 14 — check what the meter showed.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // THE LINK-OUT. Utah State University Extension's instrument note, quoted rather than paraphrased,
  // with the strips caution travelling WITH it — separating them would leave the cheaper instrument
  // looking equivalent to the better one.
  it('carries the instrument note and its source link inside the editor', () => {
    openEditor()
    expect(screen.getByTestId('going-ph-instrument').textContent).toBe(
      'Utah State University Extension recommends "a digital pH meter or pH test strips that can '
      + 'measure to at least 1 decimal point", and notes that "Test strips are less accurate as the '
      + 'color of the food can alter the result." Utah State University Extension — how to measure →')
    const link = screen.getByTestId('going-ph-link')
    expect(link.getAttribute('href'))
      .toBe('https://extension.usu.edu/preserve-the-harvest/research/tips-to-safely-ferment-at-home')
    expect(link.textContent).toBe(PH_LINK_LABEL)
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')
    // The note names the instrument and its limitation. It does not name a target, and this is the
    // assertion that keeps it that way.
    expect(PH_INSTRUMENT_NOTE).not.toMatch(/\bsafe\b|\bsafety\b|acidif|shelf|botul|\bready\b/i)
  })

  // A failed save must not look like a successful one. The editor stays OPEN with the typed value
  // still in it, because a reading is a thing someone walked to the counter for and silently
  // discarding it is worse than not offering the field.
  it('keeps the reading on screen when the save fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    openEditor()
    fireEvent.change(screen.getByTestId('going-ph-input'), { target: { value: '3.2' } })
    fireEvent.click(screen.getByTestId('going-ph-save'))
    await waitFor(() => expect(screen.getByTestId('going-ph-error')).toBeTruthy())
    expect(screen.getByTestId('going-ph-error').textContent).toBe("Couldn't save that — try again.")
    expect(screen.getByTestId('going-ph-input').value).toBe('3.2')
  })

  it('is not open until it is asked for, and closes on cancel without sending', () => {
    renderView([FERMENT])
    expect(screen.queryByTestId('going-ph-editor')).toBeNull()
    fireEvent.click(screen.getByTestId('going-ph-open'))
    expect(screen.getByTestId('going-ph-editor')).toBeTruthy()
    fireEvent.click(screen.getByTestId('going-ph-cancel'))
    expect(screen.queryByTestId('going-ph-editor')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ THE NO-THRESHOLD GUARD. Everything above tests what the code DOES; this tests what it may never
// contain. The failure it exists to catch is a single line — `if (ph < <the acid line>)` — added by a
// future session trying to be helpful, which would turn a record into an assessment without changing
// any assertion above it.
//
// WHY A LITERAL SWEEP RATHER THAN A CLEVER ONE. A regex for "comparison operator near a pH
// identifier" has to model JavaScript to be right, and a guard that can be wrong in a subtle way is a
// guard nobody trusts. The corpus's acid-line numbers are a short, closed list; forbidding the
// LITERALS outright is blunt, checkable, and has exactly one false-positive mode (a comment quoting
// the number), which the lane's source deliberately avoids by citing the ruling document instead.
//
// THE NUMBERS. Every value the evidence base circulates as an acid line or a margin below one: the
// botulinum germination limit, the Listeria recommendation, the trade-practice margin, the
// process-validation boundary, the measurement-method boundary, and the home-canning salsa target.
// Each has a DIFFERENT origin and scope and none is interchangeable with another — which is precisely
// why a future session might reach for the "safer"-looking one.
//
// SCOPE: this lane's PRODUCTION source only. Test files are excluded and must be: a fixture reading
// is data, and this file names several. Excluding them is what lets the guard be blunt.
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')
const LANE_SOURCES = [
  ['src/components/putup/goingNow.js', 'phPrompt'],
  ['src/components/putup/PhReadingField.jsx', 'PhReadingField'],
  ['src/components/putup/GoingNowView.jsx', 'going-batch-ph-prompt'],
  ['lambda/preservation/kitchenBatch.js', 'KITCHEN_PH_SCALE_MAX'],
  ['lambda/preservation/kitchenRoutes.js', 'ph_read_at'],
  ['migrations/v5-phrecord-001/0a-additive-ddl.sql', 'chk_ksl_ph_scale'],
  ['migrations/v5-phrecord-001/0r-rollback.sql', 'chk_ksl_ph_scale'],
  ['migrations/v5-phrecord-001/gates.yml', 'post_no_extra_ph_constraint'],
  // V5-BATCHCLOSEOUT-001 — the close-out surfaces, added at integration. Lanes L3 and L5 each ran an
  // equivalent sweep over their own sources locally, but this file is the CENSUS: a guard that lives
  // in five places is five guards that can each be deleted alone. The batch detail renders the stage
  // log, which is where every recorded pH reading is displayed, so these files sit squarely in the
  // path this sweep exists to police.
  ['src/components/putup/batchClose.js', 'CLOSE_OUTCOMES'],
  ['src/components/putup/BatchCloseField.jsx', 'BatchCloseField'],
  ['src/components/putup/BatchDetailView.jsx', 'BatchDetailView'],
  ['src/components/putup/JarPicker.jsx', 'JarPicker'],
  ['src/components/putup/ClosedBatchesView.jsx', 'ClosedBatchesView'],
  ['src/components/putup/batchInputs.js', 'predicateBody'],
  ['src/components/putup/BatchInputsField.jsx', 'BatchInputsField'],
]
const ACID_LINE_NUMBERS = ['4.60', '4.6', '4.4', '4.2', '4.1', '4.0', '3.8', '3.3', '5.0']
// Anchored so a dotted version string is not a false positive: `5.0.0-phrecord-20260904` is not the
// number 5.0, and `4.110.0-inflightbatch-001` is not 4.1. A bare `includes` would red on both and the
// guard would be deleted within a week for crying wolf.
const acidRe = (n) => new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?!\\d)(?!\\.\\d)`)

describe('the acid line appears nowhere in this lane\'s source', () => {
  it.each(LANE_SOURCES)('%s', (rel, sentinel) => {
    const src = readFileSync(resolve(REPO, rel), 'utf8')
    // THE GREEN CONTROL, and it is not decoration. A typo in the path, a moved file, or a build that
    // empties the tree would make every assertion below pass over an empty string. This proves the
    // sweep is looking at the file it names before it claims anything about the contents.
    expect(src).toContain(sentinel)
    for (const n of ACID_LINE_NUMBERS) {
      expect(`${rel} contains ${n}: ${acidRe(n).test(src)}`).toBe(`${rel} contains ${n}: false`)
    }
  })

  // NON-VACUITY, proven rather than asserted. The regex above must actually match the thing it is
  // written to catch and must actually ignore the version strings it is written to allow — otherwise
  // the eight green rows above prove nothing about anything.
  it('matches a real threshold comparison and ignores a dotted version string', () => {
    expect(acidRe('4.6').test('  if (Number(ph) < 4.6) return "low"')).toBe(true)
    expect(acidRe('4.6').test('const ACID_LINE = 4.6;')).toBe(true)
    expect(acidRe('4.6').test('-- BC CDC recommends a drop below 4.6.')).toBe(true)
    expect(acidRe('4.60').test('ph_reading >= 4.60')).toBe(true)
    expect(acidRe('4.4').test('if (ph <= 4.4) {')).toBe(true)
    // …and the two shapes that must NOT red, or the guard gets deleted for crying wolf.
    expect(acidRe('5.0').test("VALUES ('5.0.0-phrecord-20260904',")).toBe(false)
    expect(acidRe('4.1').test("version = '4.110.0-inflightbatch-001'")).toBe(false)
    expect(acidRe('4.6').test('fontSize: 14.60')).toBe(false)
  })
})

describe('the rendered surface makes no assessment', () => {
  // The DOM half of the guard: not what the source contains, but what a reader is shown. Every card
  // state at once — a ferment mid-cadence, one with a reading, an unclassified batch, a dehydrator —
  // plus the editor open, because the instrument note only exists there.
  //
  // TEXT CONTENT, not innerHTML, and that is deliberate: the USU link's own URL contains the word
  // "safely" as part of the destination's slug. A link to a published page is not the app making a
  // claim; the label the app writes beside it is, and the label is in textContent.
  it('renders no verdict vocabulary and no acid-line number anywhere', () => {
    renderView([FERMENT, FERMENT_READ, MASH, DRY])
    fireEvent.click(screen.getAllByTestId('going-ph-open')[0])
    const view = screen.getByTestId('going-now-view')
    // Green control: the surface really is rendering this lane's copy.
    expect(view.textContent).toContain(PH_PROMPT)
    expect(view.textContent).toContain('pH 4.60 recorded Sep 2')
    expect(view.textContent).toContain(PH_INSTRUMENT_NOTE)
    // The claim.
    expect(view.textContent).not.toMatch(
      /\bsafe\b|\bsafety\b|\bunsafe\b|\bdanger\w*\b|botulis\w*|botulinum|acidif\w*|shelf.stable|shelf.life|spoil\w*|\bready\b|\bdone\b|\bgood\b/i)
    for (const n of ACID_LINE_NUMBERS) {
      if (n === '4.60') continue    // the recorded reading itself, which is the one number allowed
      expect(`shown ${n}: ${acidRe(n).test(view.innerHTML)}`).toBe(`shown ${n}: false`)
    }
  })
})
