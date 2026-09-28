// V5-TODAYRADIATIVEWATCH-001 — the radiative "Frost watch" on Today: the pure rule and the MOUNT.
//
// THE GAP (FROST_RADIATIVE_ENABLED=true in prod). A radiative imminent email ("Garden alert - Frost watch tonight
// (low 41F)") fires ABOVE the trip point, at a plan low of 39-42F, where the weather cue says "Cool night" or nothing
// and the frost line skipped every imminent entry — so on the evening the email said "watch", Today never did. And a
// radiative-only ADVISORY's line read "Frost possible tonight — low 42°F", naming no watch, because its entry did not
// carry the trip basis.
//
// DAVE'S DECISION (2026-09-21, AskUserQuestion, "Show it on Today"): "Whenever that email goes out, Today shows a line
// like 'Frost watch tonight — clear and calm, low 42°F', and the in-app advisory says 'watch' instead of 'Frost
// possible'. The screen and the email stop contradicting each other on the same evening."
//
// THE RULE (src/lib/frostAlertLine.js pickAdvisory / buildFrostAlertLine):
//   - an entry with `trip: 'radiative'` is worded "Frost watch <night> — clear and calm, low N°F. Plan cover …";
//   - a radiative IMMINENT entry renders, as tonight's watch; a threshold one still never renders (the freeze cue
//     covers it) and, sent later, hands tonight back to the cue: the most recently sent imminent entry decides;
//   - a watch outranks an advisory, except an advisory naming TONIGHT at the same or a colder low;
//   - a forced (rehearsal) entry never renders (BUG-FROSTREHEARSALSWALLOWS-001);
//   - entries stored before the change carry no `trip` and render exactly as they did.
// Same slot, same element, same style: no modal, toast, banner, badge or tap target (frost alerts stay email-only).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const { planState, fetchMock, toastMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ accepted: 1 })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import Today from '../pages/Today.jsx'
import FrostAlertLine from '../components/today/FrostAlertLine.jsx'
import {
  buildFrostAlertLine, buildFrostAlertLines, pickAdvisory, pickFrostLines, resolveNight, tonightLineLow, currentLows,
  FREEZE_BELOW_F, ADVISORY_TRIP_F,
} from '../lib/frostAlertLine.js'
import { agreedTonightLow, agreeCallout } from '../lib/tonightLow.js'
import { buildCareNeeded } from '../lib/careNeeded.js'
import {
  PLAN_DATE, GEN, DRY, planFor, tonight, tomorrowNight, imminent, coldText, freezeText,
} from './helpers/twoLowsFixtures.js'
import frostEval from '../../lambda/daily-plan/frostEval.js'
import frostClass from '../../lambda/daily-plan/frostClass.js'

// Handler-shaped (handler.js publish block + frostWeatherFacts): a radiative imminent entry carries
// { lowF: the plan low it was sent at, dayOffset: 0, trip: 'radiative' }; a radiative-only advisory adds `trip`.
const watch = (lowF, over = {}) => ({ ...imminent(lowF), key: `sp1|${PLAN_DATE}|imminent|protect|w${lowF}`, trip: 'radiative', ...over })
const at = (hhmm) => `2026-10-09T${hhmm}:00.000Z`
const WATCH = (when, t) => `Frost watch ${when} — clear and calm, low ${t}°F. Plan cover for tender plants.`
const POSSIBLE = (when, t) => `Frost possible ${when} — low ${t}°F. Plan cover for tender plants.`

describe('the words — a radiative trip is a WATCH, every other entry reads as before', () => {
  it('a radiative imminent entry: "Frost watch tonight — clear and calm, low 41°F"', () => {
    expect(buildFrostAlertLine([watch(41)])).toEqual({ text: WATCH('tonight', 41), tier: 'imminent', dayOffset: 0, nightOffset: 0, lowF: 41 })
    expect(buildFrostAlertLine([watch(41.6)]).text).toBe(WATCH('tonight', 42))   // rounded, as the advisory is
  })

  it('a THRESHOLD imminent entry still renders nothing (the freeze cue covers it); the trip is the only difference', () => {
    expect(buildFrostAlertLine([imminent(36)])).toBeNull()
    // NEAR-MISS CONTROL: the same entry marked radiative renders, so the null is the basis rule, not the fixture.
    expect(buildFrostAlertLine([{ ...imminent(36), trip: 'radiative' }]).text).toBe(WATCH('tonight', 36))
    for (const trip of ['threshold', 'RADIATIVE', true, null]) expect(buildFrostAlertLine([{ ...imminent(40), trip }]), String(trip)).toBeNull()
  })

  it('a radiative-only ADVISORY says watch on every night phrase; the same entry without `trip` says "Frost possible"', () => {
    const cases = [
      [tonight(42, { trip: 'radiative' }), 'tonight', 42],
      [tomorrowNight(42.4, { trip: 'radiative' }), 'tomorrow night', 42],
      [tonight(43, { trip: 'radiative', dayOffset: 3, date: '2026-10-12', nightOffset: 2 }), 'Sunday night', 43],
    ]
    for (const [entry, when, t] of cases) {
      expect(buildFrostAlertLine([entry]).text).toBe(WATCH(when, t))
      const { trip: _t, ...stored } = entry   // an entry stored before V5-TODAYRADIATIVEWATCH-001
      expect(buildFrostAlertLine([stored]).text).toBe(POSSIBLE(when, t))
    }
  })

  it('a watch entry with no usable low renders nothing, like any entry without a temperature', () => {
    for (const lowF of [null, undefined, 'n/a', NaN]) expect(buildFrostAlertLine([watch(41, { lowF })]), String(lowF)).toBeNull()
    // ...and it does not hide an advisory beside it
    expect(buildFrostAlertLine([tomorrowNight(36.4), watch(41, { lowF: null })]).text).toBe(POSSIBLE('tomorrow night', 36))
    expect(buildFrostAlertLine([watch(41, { lowF: '41' })]).text).toBe(WATCH('tonight', 41))   // control: a numeric string reads
  })

  it('lowShown (the one low per night) applies to a watch as to any line', () => {
    expect(buildFrostAlertLine([watch(41)], { lowShown: 39 }).text).toBe(WATCH('tonight', 39))
    expect(buildFrostAlertLine([watch(41)], { lowShown: null }).text).toBe(WATCH('tonight', 41))
  })

  it('an imminent entry is tonight by construction (resolveNight), whatever its offsets say', () => {
    expect(resolveNight(watch(41))).toEqual({ nightOffset: 0, nightDate: null })
    expect(resolveNight({ ...watch(41), dayOffset: 2, nightOffset: 3 })).toEqual({ nightOffset: 0, nightDate: null })
    expect(resolveNight({ dayOffset: 0 })).toBeNull()   // control: no tier, nothing to resolve (unchanged)
  })
})

describe('which line renders — the latest imminent decides, and a watch never makes tonight warmer', () => {
  it('a later threshold imminent send hands tonight back to the freeze cue', () => {
    const w = watch(41, { at: at('19:00') })
    const t = { ...imminent(36), at: at('20:00') }
    expect(buildFrostAlertLine([w, t])).toBeNull()
    expect(buildFrostAlertLine([t, w])).toBeNull()                                   // array order is not send order
    const adv = tomorrowNight(36.4, { at: at('18:00') })
    expect(buildFrostAlertLine([adv, w, t]).text).toBe(POSSIBLE('tomorrow night', 36))  // exactly what base rendered
    // ...and a watch sent AFTER a threshold one is tonight's line again
    expect(buildFrostAlertLine([{ ...t, at: at('18:30') }, w]).text).toBe(WATCH('tonight', 41))
  })

  // CHANGED by V5-TODAYFROSTLINEGAPS-001 (lane frostlinegaps, 2026-09-21): this pinned the one-slot rule ("a watch
  // outranks an advisory for a LATER night" — the later night vanished). Dave chose two lines: the watch is still the
  // FIRST line (what buildFrostAlertLine returns, unchanged), and the later night is now the second, not displaced.
  it('a watch comes first over an advisory for a LATER night, sent before or after it — which is now the second line', () => {
    for (const advAt of ['18:00', '21:00']) {
      const adv = tomorrowNight(34, { at: at(advAt) })
      expect(buildFrostAlertLine([adv, watch(41, { at: at('19:00') })]).text, advAt).toBe(WATCH('tonight', 41))
      expect(buildFrostAlertLines([adv, watch(41, { at: at('19:00') })]).map((l) => l.text), advAt)
        .toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)])
    }
  })

  it('an advisory naming TONIGHT at the same or a colder low keeps the line; a warmer one yields to the watch', () => {
    const w = watch(41, { at: at('20:00') })
    expect(buildFrostAlertLine([tonight(37.6), w]).text).toBe(POSSIBLE('tonight', 38))
    expect(buildFrostAlertLine([tonight(41), w]).text).toBe(POSSIBLE('tonight', 41))                   // tie: the advisory
    expect(buildFrostAlertLine([tonight(42, { trip: 'radiative' }), w]).text).toBe(WATCH('tonight', 41))
    expect(buildFrostAlertLine([tonight(40.5, { trip: 'radiative' }), w]).text).toBe(WATCH('tonight', 41)) // its own watch, 40.5
    expect(pickAdvisory([tonight(40.5, { trip: 'radiative' }), w]).tier).toBe('advisory')
  })

  it('a forced (rehearsal) watch never renders and never displaces a real line', () => {
    expect(buildFrostAlertLine([watch(41, { run: 'forced' })])).toBeNull()
    expect(buildFrostAlertLine([tomorrowNight(36.4), watch(41, { run: 'forced', at: at('23:00') })]).text).toBe(POSSIBLE('tomorrow night', 36))
    // a forced THRESHOLD imminent does not hand tonight back either: the real watch stays
    expect(buildFrostAlertLine([watch(41, { at: at('19:00') }), { ...imminent(36), run: 'forced', at: at('20:00') }]).text).toBe(WATCH('tonight', 41))
  })

  // CHANGED by V5-TODAYFROSTLINEGAPS-001 follow-up F1 (Dave 2026-09-21): this pinned the one advisory slot — the newer
  // tomorrow-night advisory took the line and the first line's nightOffset was 1. Advisories are now ranked per night,
  // so tonight's is the first line (nightOffset 0) and tomorrow night's the second. The threshold-imminent half holds.
  it('advisory-only lists: a threshold imminent beside them changes nothing; tonight\'s advisory is the first line', () => {
    const t = tonight(37.6, { at: at('19:05') })
    const m = tomorrowNight(36.4, { at: at('20:05') })
    expect(buildFrostAlertLine([t, m])).toEqual(buildFrostAlertLine([t, m, imminent(36)]))
    expect(buildFrostAlertLines([t, m])).toEqual(buildFrostAlertLines([t, m, imminent(36)]))
    expect(buildFrostAlertLine([t, m]).nightOffset).toBe(0)
  })
})

describe('one low per night, with a watch naming tonight', () => {
  it('agreedTonightLow triggers on a watch: the colder of the plan low and the watch\'s low', () => {
    expect(agreedTonightLow(planFor(41, [watch(41)]))).toEqual({ lowF: 41, lowRaw: 41 })
    expect(agreedTonightLow(planFor(44, [watch(41)]))).toEqual({ lowF: 41, lowRaw: 41 })    // the plan warmed later
    expect(agreedTonightLow(planFor(39.6, [watch(41)]))).toEqual({ lowF: 40, lowRaw: 39.6 })
    expect(agreedTonightLow(planFor(41, [imminent(41)]))).toBeNull()                         // control: threshold shape
    expect(agreedTonightLow(planFor(41, [watch(41, { run: 'forced' })]))).toBeNull()         // control: a rehearsal
  })

  it('Protect rows lose their "(low …)" on a watch night, as on any night the line names tonight', () => {
    const rows = (plan) => buildCareNeeded(plan).filter((r) => r.need === 'cold').map((r) => r.reason)
    const withWatch = rows(planFor(41, [watch(41)]))
    const without = rows(planFor(41, []))
    expect(without.some((r) => / \(low [^()]*\)$/.test(r))).toBe(true)
    expect(withWatch.some((r) => / \(low [^()]*\)$/.test(r))).toBe(false)
    expect(withWatch).toEqual(without.map((r) => r.replace(/ \(low [^()]*\)$/, '')))
  })
})

// ── the mount: what Today renders from a stored plan ─────────────────────────────────────────────────────────────
const mountData = (plan) => ({ data: { has_plan: true, plan_date: PLAN_DATE, generated_at: GEN, plan }, loading: false, error: null })
function readPage(container) {
  const q = within(container)
  return {
    card: q.getByTestId('weather-night-low').textContent,
    cue: q.queryByTestId('weather-cue-line')?.textContent ?? null,
    line: q.queryByTestId('frost-alert-line')?.textContent ?? null,
  }
}

beforeEach(() => { fetchMock.mockClear(); planState.current = null })

describe('Today — the watch line, mounted from plan.alerts_sent', () => {
  it('THE GAP: a radiative imminent email at plan low 41 -> "Cool night (41°F)" cue AND the watch line', () => {
    planState.current = mountData(planFor(41, [watch(41)]))
    const { container } = render(<Today />)
    expect(readPage(container)).toEqual({ card: '41°', cue: coldText(41), line: WATCH('tonight', 41) })
    const el = screen.getByTestId('frost-alert-line')
    expect(el.dataset.frostTier).toBe('imminent')
    expect(el.dataset.frostNightOffset).toBe('0')
  })

  it('the forecast warmed after the email (plan low 44): one low for tonight on the card, cue and line', () => {
    planState.current = mountData(planFor(44, [watch(41)]))
    const { container } = render(<Today />)
    expect(readPage(container)).toEqual({ card: '41°', cue: coldText(41), line: WATCH('tonight', 41) })
  })

  it('a radiative-only advisory for tomorrow night: the watch words, tonight untouched', () => {
    planState.current = mountData(planFor(47, [tomorrowNight(42, { trip: 'radiative' })]))
    const { container } = render(<Today />)
    expect(readPage(container)).toEqual({ card: '47°', cue: null, line: WATCH('tomorrow night', 42) })
  })

  it('unchanged: a threshold imminent send (freeze cue, no line), and an old radiative advisory with no trip', () => {
    planState.current = mountData(planFor(36, [imminent(36)]))
    const a = render(<Today />)
    expect(readPage(a.container)).toEqual({ card: '36°', cue: freezeText(36), line: null })
    a.unmount()
    planState.current = mountData(planFor(47, [tonight(42)]))
    const b = render(<Today />)
    expect(readPage(b.container)).toEqual({ card: '42°', cue: null, line: POSSIBLE('tonight', 42) })
  })

  it('a rehearsal renders nothing on Today', () => {
    planState.current = mountData(planFor(55, [tonight(45, { run: 'forced' })]))
    const { container } = render(<Today />)
    expect(readPage(container)).toEqual({ card: '55°', cue: null, line: null })
  })

  it('the same element in the same slot: directly after the cue, one line, no new control, same ink and rule', () => {
    planState.current = mountData(planFor(41, [watch(41)]))
    const { container } = render(<Today />)
    const cue = screen.getByTestId('weather-cue-line')
    const line = screen.getByTestId('frost-alert-line')
    expect(cue.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="frost-alert-line"]')).toHaveLength(1)
    expect(line.querySelectorAll('*')).toHaveLength(0)                                    // text only: no icon, badge or button
    expect(line.getAttribute('role')).toBeNull()
    // Same inline style as an advisory line (FrostAlertLine.test.jsx pins that style out of the warn family).
    const { container: adv } = render(<FrostAlertLine alertsSent={[tonight(38)]} />)
    expect(line.getAttribute('style')).toBe(adv.querySelector('[data-testid="frost-alert-line"]').getAttribute('style'))
    expect(line.getAttribute('style')).toMatch(/border-left/)
  })
})

// ══ V5-TODAYFROSTLINEGAPS-001 — Dave's three decisions (AskUserQuestion, 2026-09-21 ~12:15 ET) ═══════════════════════
//   (1) TWO SEPARATE LINES: tonight's watch and a frost advisory for a LATER night both show, tonight's first; one
//       applies -> one line, as before; never two lines about the same night.
//   (2) SHOW THE COLDER FIGURE: a watch whose email printed "Colder on a second forecast: 35°F tonight" stores it
//       (`colder` on the imminent entry) and the line says "as low as 35°F"; the card and the cue agree on it.
//   (3) SAY IT WARMED: after a THRESHOLD "Frost protect tonight" email, once the plan low has left the freeze cue,
//       "Forecast warmed to 44°F since the 3 PM frost email." Facts only. Never while the cue covers it, never forced.
const ASLOW = (when, t) => `Frost watch ${when} — clear and calm, as low as ${t}°F. Plan cover for tender plants.`
const WARMED = (t, time) => `Forecast warmed to ${t}°F since the ${time} frost email.`
// handler.frostWeatherFacts' `colder`, the advisory entry's own vocabulary: tonight (D1 before dawn) or a later night.
const colderTonight = (lowF) => ({ lowF, dayOffset: 1, date: '2026-10-10', nightOffset: 0 })
const colderAhead = (lowF, over = {}) => ({ lowF, dayOffset: 2, date: '2026-10-11', nightOffset: 1, ...over })
const MONDAY = { dayOffset: 3, date: '2026-10-12', nightOffset: 3 }
const texts = (entries, opts) => buildFrostAlertLines(entries, opts).map((l) => l.text)

describe('(1) two lines, one per night — a watch no longer hides a later night', () => {
  it('THE GAP: a watch for tonight and an advisory for tomorrow night -> both, tonight first, whatever the order', () => {
    for (const advAt of ['18:00', '21:00']) {
      const adv = tomorrowNight(34, { at: at(advAt) })
      const w = watch(41, { at: at('19:00') })
      expect(texts([adv, w]), advAt).toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)])
      expect(texts([w, adv]), advAt).toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)])
    }
    const lines = buildFrostAlertLines([tomorrowNight(34), watch(41)])
    expect(lines.map((l) => [l.tier, l.nightOffset, l.dayOffset, l.lowF])).toEqual([['imminent', 0, 0, 41], ['advisory', 1, 2, 34]])
  })

  it('a weekday night keeps its own name and figure', () => {
    expect(texts([tomorrowNight(31.4, MONDAY), watch(41)])).toEqual([WATCH('tonight', 41), POSSIBLE('Monday night', 31)])
  })

  it('never two lines about the same night: an advisory naming tonight and a watch -> one line, chosen as before', () => {
    const w = watch(41, { at: at('20:00') })
    expect(texts([tonight(37.6), w])).toEqual([POSSIBLE('tonight', 38)])
    expect(texts([tonight(42), w])).toEqual([WATCH('tonight', 41)])
  })

  // CHANGED by V5-TODAYFROSTLINEGAPS-001 follow-up F1 (Dave 2026-09-21): the last two assertions pinned "the newest
  // advisory still supersedes an older one" ACROSS nights — a tonight advisory and a tomorrow-night one rendered one
  // line, whichever was newer. Dave: two lines, tonight first, regardless of which was sent last. Supersession now holds
  // within a night (pinned in the F1 block below).
  it('only one applies -> exactly one line, as before; advisories about two nights are two lines, whatever the order', () => {
    expect(texts([watch(41)])).toEqual([WATCH('tonight', 41)])
    expect(texts([tomorrowNight(36.4)])).toEqual([POSSIBLE('tomorrow night', 36)])
    expect(texts([tonight(37.6)])).toEqual([POSSIBLE('tonight', 38)])
    expect(texts([])).toEqual([])
    expect(texts([tomorrowNight(36.4, { at: at('18:00') }), tonight(37.6, { at: at('20:00') })])).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 36)])
    expect(texts([tonight(37.6, { at: at('18:00') }), tomorrowNight(36.4, { at: at('20:00') })])).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 36)])
  })

  it('the "Colder ahead" advisory a watch email carried is the later night\'s line — no advisory entry is needed', () => {
    expect(texts([watch(41, { colder: colderAhead(35) })])).toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 35)])
    expect(texts([watch(41, { colder: colderAhead(33.4, MONDAY) })])).toEqual([WATCH('tonight', 41), POSSIBLE('Monday night', 33)])
    // An entry stored before the field carries no `colder`: one line, as before.
    expect(texts([watch(41)])).toEqual([WATCH('tonight', 41)])
  })

  it('one later-night line: the newest statement about a later night wins, entry or watch email', () => {
    const adv = tomorrowNight(36.4, { at: at('18:00') })
    expect(texts([adv, watch(41, { at: at('19:00'), colder: colderAhead(35) })])).toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 35)])
    expect(texts([adv, watch(41, { at: at('19:00'), colder: colderAhead(33, MONDAY) })])).toEqual([WATCH('tonight', 41), POSSIBLE('Monday night', 33)])
    expect(texts([watch(41, { at: at('19:00'), colder: colderAhead(33, MONDAY) }), tomorrowNight(36.4, { at: at('21:00') })]))
      .toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 36)])
  })

  it('a threshold send after the watch hands tonight back to the cue; the later night stays', () => {
    const t = { ...imminent(36), at: at('20:00') }
    expect(texts([watch(41, { at: at('19:00'), colder: colderAhead(35) }), t])).toEqual([POSSIBLE('tomorrow night', 35)])
    expect(texts([tomorrowNight(34, { at: at('18:00') }), watch(41, { at: at('19:00') }), t])).toEqual([POSSIBLE('tomorrow night', 34)])
  })

  it('a forced watch contributes to neither line', () => {
    expect(texts([watch(41, { run: 'forced', colder: colderAhead(35) })])).toEqual([])
    expect(texts([tomorrowNight(36.4), watch(41, { run: 'forced', at: at('23:00'), colder: colderAhead(30) })])).toEqual([POSSIBLE('tomorrow night', 36)])
  })

  it('lowShown (the agreed low for tonight) reaches tonight\'s line only; the later night keeps its own figure', () => {
    const lines = buildFrostAlertLines([tomorrowNight(34), watch(41)], { lowShown: 39 })
    expect(lines.map((l) => [l.text, l.lowF])).toEqual([[WATCH('tonight', 39), 39], [POSSIBLE('tomorrow night', 34), 34]])
    expect(agreedTonightLow(planFor(39, [tomorrowNight(34), watch(41)]))).toEqual({ lowF: 39, lowRaw: 39 })
    // a later night alone never triggers the agreement
    expect(agreedTonightLow(planFor(39, [watch(41, { colder: colderAhead(30) }), { ...imminent(36), at: at('20:00') }]))).toBeNull()
  })
})

describe('(2) the watch shows its email\'s colder second forecast — "as low as 35°F"', () => {
  it('the line says "as low as" at the second forecast\'s figure, rounded', () => {
    expect(buildFrostAlertLine([watch(39, { colder: colderTonight(35) })])).toEqual({ text: ASLOW('tonight', 35), tier: 'imminent', dayOffset: 0, nightOffset: 0, lowF: 35 })
    expect(buildFrostAlertLine([watch(39, { colder: colderTonight(34.7) })]).text).toBe(ASLOW('tonight', 35))
    expect(buildFrostAlertLine([watch(39, { colder: colderTonight('35') })]).text).toBe(ASLOW('tonight', 35))   // a numeric string reads
    // An entry stored before the field: exactly as before.
    expect(buildFrostAlertLine([watch(39)]).text).toBe(WATCH('tonight', 39))
  })

  it('an unusable or not-colder figure is ignored: the watch reads its own low, worded as before', () => {
    for (const lowF of [null, undefined, '', 'n/a', NaN]) expect(buildFrostAlertLine([watch(39, { colder: colderTonight(lowF) })]).text, String(lowF)).toBe(WATCH('tonight', 39))
    expect(buildFrostAlertLine([watch(39, { colder: colderTonight(39) })]).text).toBe(WATCH('tonight', 39))
    expect(buildFrostAlertLine([watch(39, { colder: colderTonight(40) })]).text).toBe(WATCH('tonight', 39))
    for (const colder of ['35', 35, [], { nightOffset: 0 }]) expect(buildFrostAlertLine([watch(39, { colder })]).text, JSON.stringify(colder)).toBe(WATCH('tonight', 39))
  })

  it('ONE LOW FOR THE NIGHT: the card and the cue print the second forecast\'s figure too', () => {
    const w = watch(39, { colder: colderTonight(35) })
    expect(agreedTonightLow(planFor(39, [w]))).toEqual({ lowF: 35, lowRaw: 35 })
    expect(agreedTonightLow(planFor(41, [w]))).toEqual({ lowF: 35, lowRaw: 35 })
    expect(agreedTonightLow(planFor(33, [w]))).toEqual({ lowF: 33, lowRaw: 33 })        // a colder plan low still wins
    expect(buildFrostAlertLine([w], { lowShown: 33 }).text).toBe(ASLOW('tonight', 33))
    expect(agreedTonightLow(planFor(39, [watch(39)]))).toEqual({ lowF: 39, lowRaw: 39 })  // control: no field, as before
    const p = planFor(41, [w])
    expect(p.weather.callout).toEqual({ icon: 'cold', text: coldText(41) })
    expect(agreeCallout(p.weather.callout, agreedTonightLow(p))).toMatchObject({ icon: 'freeze', text: freezeText(35) })
    // Protect rows: no third number beside the agreed one
    const rows = buildCareNeeded(p).filter((r) => r.need === 'cold').map((r) => r.reason)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => / \(low [^()]*\)$/.test(r))).toBe(false)
  })

  it('QA M2 — "as low as" only when the PRINTED number is lower: a 38.5-38.99 second forecast under a 39 watch reads "low 39°F"', () => {
    for (const second of [38.5, 38.6, 38.75, 38.99]) {
      expect(buildFrostAlertLine([watch(39, { colder: colderTonight(second) })]).text, String(second)).toBe(WATCH('tonight', 39))
    }
    expect(buildFrostAlertLine([watch(39, { colder: colderTonight(38.49) })]).text).toBe(ASLOW('tonight', 38))   // control: rounds lower
    // the agreed low still takes the raw figure (the cue's freeze split reads it raw), and prints the same 39
    expect(agreedTonightLow(planFor(41, [watch(39, { colder: colderTonight(38.6) })]))).toEqual({ lowF: 39, lowRaw: 38.6 })
    expect(buildFrostAlertLine([watch(39, { colder: colderTonight(38.6) })], { lowShown: 39 }).text).toBe(WATCH('tonight', 39))
  })

  it('the tonight exception reads the second forecast: an advisory warmer than it yields, a colder one keeps the line', () => {
    const w = watch(41, { at: at('20:00'), colder: colderTonight(35) })
    expect(texts([tonight(37.6), w])).toEqual([ASLOW('tonight', 35)])
    expect(texts([tonight(34.4), w])).toEqual([POSSIBLE('tonight', 34)])
    expect(texts([tonight(35), w])).toEqual([POSSIBLE('tonight', 35)])                   // tie: the advisory, as before
    expect(agreedTonightLow(planFor(44, [tonight(37.6), w]))).toEqual({ lowF: 35, lowRaw: 35 })
  })
})

describe('(3) "Forecast warmed" — a threshold frost email whose night has left the freeze cue', () => {
  const thr = (lowF, over = {}) => ({ ...imminent(lowF), run: 'intraday-pm', at: at('19:00'), ...over })   // 3 PM EDT
  const lines = (entries, planLow) => texts(entries, { planLow })

  it('THE GAP: a 3 PM "Frost protect tonight (low 36°F)" email, plan low now 44 -> one line of fact', () => {
    expect(lines([thr(36)], 44)).toEqual([WARMED(44, '3 PM')])
    expect(buildFrostAlertLines([thr(36)], { planLow: 44 })).toEqual([{ text: WARMED(44, '3 PM'), tier: 'imminent', dayOffset: 0, nightOffset: 0, lowF: 44 }])
  })

  it('never while the freeze cue still covers tonight — the boundary is the engine\'s own (computeCallout low < 40)', () => {
    for (const low of [36, 39, 39.9]) expect(lines([thr(36)], low), String(low)).toEqual([])
    expect(lines([thr(36)], 40)).toEqual([WARMED(40, '3 PM')])
    expect(FREEZE_BELOW_F).toBe(40)
    expect(planFor(39.9, []).weather.callout.icon).toBe('freeze')
    expect(planFor(40, []).weather.callout.icon).toBe('cold')
  })

  it('only when the plan low is now warmer than the low the email was sent at', () => {
    expect(lines([thr(41)], 41)).toEqual([])
    expect(lines([thr(41)], 42)).toEqual([WARMED(42, '3 PM')])
    expect(lines([thr(null)], 44)).toEqual([])
  })

  it('the email\'s send time on the ET clock, the phone\'s zone aside', () => {
    expect(lines([thr(36, { at: '2026-10-09T19:05:00.000Z' })], 44)).toEqual([WARMED(44, '3:05 PM')])
    expect(lines([thr(36, { at: '2026-10-09T21:00:30.000Z' })], 44)).toEqual([WARMED(44, '5 PM')])
    expect(lines([thr(36, { at: '2026-11-13T20:00:00.000Z' })], 44)).toEqual([WARMED(44, '3 PM')])   // EST, UTC-5
    for (const bad of [null, '', 'z', undefined]) expect(lines([thr(36, { at: bad })], 44), String(bad)).toEqual([])
  })

  it('the most recently sent real imminent decides: a later watch is tonight\'s line; a forced send never counts', () => {
    expect(lines([thr(36), watch(41, { at: at('20:00') })], 44)).toEqual([WATCH('tonight', 41)])
    expect(lines([thr(36, { run: 'forced' })], 44)).toEqual([])
    expect(lines([thr(36), thr(30, { run: 'forced', at: at('21:00') })], 44)).toEqual([WARMED(44, '3 PM')])
    expect(lines([thr(36), thr(32, { level: 'hard_freeze', at: at('20:00') })], 44)).toEqual([WARMED(44, '4 PM')])
  })

  it('never two lines about tonight: an advisory naming tonight keeps tonight\'s line and its agreed low', () => {
    expect(lines([tonight(37.6), thr(36)], 44)).toEqual([POSSIBLE('tonight', 38)])
    expect(agreedTonightLow(planFor(44, [tonight(37.6), thr(36)]))).toEqual({ lowF: 38, lowRaw: 37.6 })
  })

  it('with an advisory for a later night: two lines, tonight\'s first', () => {
    expect(lines([tomorrowNight(34), thr(36)], 44)).toEqual([WARMED(44, '3 PM'), POSSIBLE('tomorrow night', 34)])
  })

  it('the figure is the plan low as the card prints it; no plan low, no line', () => {
    expect(lines([thr(36)], 44.3)).toEqual([WARMED(44.3, '3 PM')])
    expect(lines([thr(36)], '44')).toEqual([WARMED('44', '3 PM')])
    for (const p of [null, undefined, '', 'n/a']) expect(lines([thr(36)], p), String(p)).toEqual([])
  })

  it('a runtime without the ET zone costs the warmed line only: nothing throws, the other lines still render', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new RangeError('Invalid time zone specified: America/New_York') })
    try {
      expect(lines([tomorrowNight(34), thr(36)], 44)).toEqual([POSSIBLE('tomorrow night', 34)])
      expect(spy).toHaveBeenCalled()
    } finally { spy.mockRestore() }
    expect(lines([tomorrowNight(34), thr(36)], 44)).toEqual([WARMED(44, '3 PM'), POSSIBLE('tomorrow night', 34)])   // control
  })

  it('the ET formatter is never built at module load (the module is imported by tonightLow.js and careNeeded.js)', async () => {
    vi.resetModules()
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new RangeError('Invalid time zone specified: America/New_York') })
    try {
      const fresh = await import('../lib/frostAlertLine.js')
      expect(fresh.buildFrostAlertLines([tomorrowNight(34)]).map((l) => l.text)).toEqual([POSSIBLE('tomorrow night', 34)])
    } finally { spy.mockRestore() }
  })

  it('it triggers no agreement (it prints the plan low itself) and needs planLow: the one-argument call is unchanged', () => {
    expect(agreedTonightLow(planFor(44, [thr(36)]))).toBeNull()
    expect(buildFrostAlertLine([thr(36)])).toBeNull()
    expect(buildFrostAlertLines([thr(36)])).toEqual([])
    const rows = buildCareNeeded(planFor(44, [thr(36)])).filter((r) => r.need === 'cold').map((r) => r.reason)
    expect(rows.some((r) => r.endsWith('(low 44°F)'))).toBe(true)                       // the plan's own figure, kept
  })
})

// ══ V5-TODAYFROSTWARMEDADVISORY-001 — Dave's two decisions (AskUserQuestion, 2026-09-28) ══════════════════════════════
//   WORDING: once BOTH forecasts for tonight have warmed out of frost range after a frost email, Today says "Forecast
//            warmed to 44°F since the 3 PM frost email." — the (3) line above, word for word.
//   SCOPE:   the same line on an advisory-only night (a "Frost possible" email with no "Frost protect" after it), citing
//            that email. A radiative "Frost watch" advisory keeps today's behaviour; no refresh of the number while cold.
// THE GAP (preship-qa I2): "Frost possible tonight" at 2 PM (best_match's D1 37.6), "Frost protect tonight" at 3 PM, then a
// plan low of 44 left "Freeze tonight (38°F)" + "Frost possible tonight — low 38°F" all evening and the warmed line could
// never speak — the pin in (3) above ("never two lines about tonight"), which stays true for a row WITHOUT current lows.
// The plan now stores the second model's CURRENT D1..D3 lows (hydrology.forecast_lows/forecast_dates); currentLows reads
// them. Plan date Fri 10-09: the advisory names tonight through D1 = 2026-10-10 (twoLowsFixtures `tonight`).
const D1_3 = ['2026-10-10', '2026-10-11', '2026-10-12']
const hyLows = (d1, over = {}) => ({ ...DRY, forecast_lows: [d1, 45.3, 47.1], forecast_dates: D1_3, ...over })
const ADV = (lowF = 37.6, over = {}) => tonight(lowF, { at: at('18:05'), ...over })                  // 2:05 PM EDT
const PROTECT = (over = {}) => ({ ...imminent(38), run: 'intraday-pm', at: at('19:00'), ...over })    // 3 PM EDT
const LADDER = [ADV(), PROTECT()]
// Everything Today prints about tonight from one stored plan, through the helpers Today itself calls (the mount block
// below proves Today wires them this way): the card's figure, the cue's words, the frost lines.
function screenOf(plan) {
  const agreed = agreedTonightLow(plan)
  const cue = agreeCallout(plan.weather.callout, agreed)
  return {
    card: agreed ? agreed.lowF : plan.weather.tonightLow,
    cue: cue ? cue.text : null,
    lines: texts(plan.alerts_sent, { lowShown: agreed?.lowF, planLow: plan.weather.tonightLow, current: currentLows(plan) }),
  }
}
const STALE = { card: 38, cue: freezeText(38), lines: [POSSIBLE('tonight', 38)] }   // the I2 screen at plan low 44

describe('(4) "Forecast warmed" after a same-night ADVISORY — retired once both models have left its range', () => {
  it('T1 THE GAP: the ladder, then both models warm (plan 44, second model 41.2) -> the plan low everywhere, the warmed line', () => {
    expect(screenOf(planFor(44, LADDER, hyLows(41.2)))).toEqual({ card: 44, cue: coldText(44), lines: [WARMED(44, '3 PM')] })
    expect(screenOf(planFor(44, LADDER))).toEqual(STALE)                  // a row without current lows: exactly as before
  })

  it('T2 colder wins: the second model still in range (39.6) keeps the email\'s line, card and cue', () => {
    expect(screenOf(planFor(44, LADDER, hyLows(39.6)))).toEqual(STALE)
  })

  it('T3 the second model\'s split is the email\'s own trigger (<= 40 fires): 40.0 keeps the line, 40.1 retires it', () => {
    expect(screenOf(planFor(44, LADDER, hyLows(40))).lines).toEqual([POSSIBLE('tonight', 38)])
    expect(screenOf(planFor(44, LADDER, hyLows(40.1))).lines).toEqual([WARMED(44, '3 PM')])
  })

  it('T4 the plan low still in the freeze cue (39, 39.9) keeps the email\'s line, whatever the second model says', () => {
    for (const low of [39, 39.9]) expect(screenOf(planFor(low, LADDER, hyLows(45))), String(low)).toEqual(STALE)
    // ...including when a watch would take tonight over from a retired advisory (T12): not retired, so still the advisory
    const list = [ADV(), watch(41, { at: at('20:00') })]
    expect(screenOf(planFor(39, list, hyLows(45)))).toEqual(STALE)
  })

  it('T5 the plan boundary is the freeze cue\'s own (low < 40): at 40 the cue is cool and the line says warmed', () => {
    expect(screenOf(planFor(40, LADDER, hyLows(41)))).toEqual({ card: 40, cue: coldText(40), lines: [WARMED(40, '3 PM')] })
  })

  it('T6 anything the row cannot vouch for keeps today\'s screen — the warning is never dropped on missing data', () => {
    const shifted = ['2026-10-11', '2026-10-12', '2026-10-13']
    const unknown = {
      'dates but no lows': { ...DRY, forecast_dates: D1_3 },
      'lows but no dates': hyLows(41.2, { forecast_dates: null }),
      'the advisory\'s date is not among them': hyLows(41.2, { forecast_dates: shifted }),
      'a hole on that date': hyLows(null),
      'a non-numeric low': hyLows('n/a'),
    }
    for (const [name, hy] of Object.entries(unknown)) expect(screenOf(planFor(44, LADDER, hy)), name).toEqual(STALE)
    const noDate = [ADV(37.6, { date: undefined }), PROTECT()]
    expect(screenOf(planFor(44, noDate, hyLows(41.2)))).toEqual(screenOf(planFor(44, noDate)))
    expect(screenOf(planFor(null, LADDER, hyLows(41.2)))).toEqual(screenOf(planFor(null, LADDER)))   // no plan low
  })

  it('T6b looked up by DATE, never by position: the day the advisory named decides, in both directions', () => {
    const from09 = ['2026-10-09', '2026-10-10', '2026-10-11']
    expect(screenOf(planFor(44, LADDER, hyLows(45, { forecast_lows: [45, 39, 47.1], forecast_dates: from09 })))).toEqual(STALE)
    expect(screenOf(planFor(44, LADDER, hyLows(39, { forecast_lows: [39, 45, 47.1], forecast_dates: from09 }))).lines)
      .toEqual([WARMED(44, '3 PM')])
  })

  // Adopted from the v4.158.0 pre-promote QA review (review-v4158-qa.md, probe Q5). T6's no-plan-low case holds with or
  // without warmedPast's own `plan != null`, because the warmed line cannot speak without a plan low. With a WATCH sent
  // after the advisory nothing has to speak, so only that check keeps the email's line: QA mutant N4 (a missing plan low
  // read as warm) survived all 771 lane tests and put the watch's warmer 41 on the card and the line.
  it('T6c no plan low + a watch sent after the advisory: not retired, tonight stays the email\'s 38 (QA probe Q5)', () => {
    const watch41 = { key: 'sp1|2026-10-09|imminent|watch', tier: 'imminent', level: 'protect', trip: 'radiative', run: 'intraday-pm',
      at: at('20:00'), lowF: 41, dayOffset: 0 }
    const list = [ADV(), watch41]
    const cur = currentLows(planFor(null, list, hyLows(45)))
    expect(buildFrostAlertLines(list, { planLow: null, current: cur }).map((l) => l.text)).toEqual([POSSIBLE('tonight', 38)])
    expect(screenOf(planFor(null, list, hyLows(45)))).toEqual({ card: 38, cue: null, lines: [POSSIBLE('tonight', 38)] })
    // CONTROL: with a plan low the advisory does retire and the watch takes tonight (T12's rule)
    const cur44 = currentLows(planFor(44, list, hyLows(45)))
    expect(buildFrostAlertLines(list, { planLow: 44, current: cur44 }).map((l) => l.text)[0]).toMatch(/^Frost watch tonight/)
  })

  it('T7 nothing is stored: each run\'s row decides, so a forecast that turns cold again brings the email\'s line back', () => {
    const runs = [[44, 41.2], [39, 38.9], [44, 38.9], [44, 41.2]]
    expect(runs.map(([low, d1]) => screenOf(planFor(low, LADDER, hyLows(d1))).lines)).toEqual([
      [WARMED(44, '3 PM')], [POSSIBLE('tonight', 38)], [POSSIBLE('tonight', 38)], [WARMED(44, '3 PM')],
    ])
  })

  it('T8 a radiative-only advisory keeps its figure (the plan holds no clear-and-calm verdict); so does an unknown trip', () => {
    const rad = [ADV(42, { trip: 'radiative' })]
    expect(screenOf(planFor(47, rad, hyLows(45)))).toEqual({ card: 42, cue: null, lines: [WATCH('tonight', 42)] })
    expect(screenOf(planFor(47, rad, hyLows(45)))).toEqual(screenOf(planFor(47, rad)))
    const odd = [ADV(37.6, { trip: 'threshold' }), PROTECT()]
    expect(screenOf(planFor(44, odd, hyLows(45)))).toEqual(screenOf(planFor(44, odd)))
  })

  it('T9 an advisory for a LATER night is not this rule\'s: it keeps its own line and figure', () => {
    const later = [tomorrowNight(34, { at: at('18:05') })]
    expect(screenOf(planFor(50, later, hyLows(41.2, { forecast_lows: [41.2, 45, 47.1] }))))
      .toEqual({ card: 50, cue: null, lines: [POSSIBLE('tomorrow night', 34)] })
  })

  it('T10 DAVE\'S SCOPE — an advisory-only night that warms: the same line, citing the advisory\'s own send time', () => {
    expect(screenOf(planFor(50, [ADV()], hyLows(45)))).toEqual({ card: 50, cue: null, lines: [WARMED(50, '2:05 PM')] })
    expect(screenOf(planFor(50, [ADV()]))).toEqual({ card: 38, cue: null, lines: [POSSIBLE('tonight', 38)] })   // before
    // the same element's data as the advisory line it replaces: tier and day of that entry, tonight
    expect(buildFrostAlertLines([ADV()], { planLow: 50, current: currentLows(planFor(50, [ADV()], hyLows(45))) }))
      .toEqual([{ text: WARMED(50, '2:05 PM'), tier: 'advisory', dayOffset: 1, nightOffset: 0, lowF: 50 }])
  })

  it('T11 old callers and unknown rows: identical to the call without `current`, over a grid of lists and plan lows', () => {
    const lists = [[], [ADV()], LADDER, [PROTECT()], [watch(41)], [ADV(42, { trip: 'radiative' })], [tomorrowNight(34)],
      [ADV(), tomorrowNight(34, { at: at('20:00') }), watch(41, { at: at('21:00') })]]
    const unknownHy = [DRY, { ...DRY, forecast_lows: [null, null, null], forecast_dates: D1_3 }, { ...DRY, forecast_dates: D1_3 }]
    let n = 0
    for (const list of lists) {
      for (const low of [null, 30, 36, 39, 39.9, 40, 41, 44, 50, 55]) {
        const tag = `${JSON.stringify(list.map((a) => [a.tier, a.lowF, a.trip ?? null]))} @ ${low}`
        const plain = planFor(low, list)
        const opts = { lowShown: agreedTonightLow(plain)?.lowF, planLow: low }
        for (const hy of unknownHy) {
          const cur = currentLows(planFor(low, list, hy))
          expect(buildFrostAlertLines(list, { ...opts, current: cur }), tag).toEqual(buildFrostAlertLines(list, opts))
          expect(tonightLineLow(list, cur), tag).toEqual(tonightLineLow(list))
          expect(agreedTonightLow(planFor(low, list, hy)), tag).toEqual(agreedTonightLow(plain))
          n++
        }
      }
    }
    expect(n).toBe(240)
  })

  it('T12 a watch sent after the advisory: once the advisory retires, tonight is the watch at its own low (watch rules unchanged)', () => {
    const list = [ADV(), watch(41, { at: at('20:00') })]
    expect(screenOf(planFor(44, list, hyLows(45)))).toEqual({ card: 41, cue: coldText(41), lines: [WATCH('tonight', 41)] })
    expect(screenOf(planFor(44, list))).toEqual(STALE)                   // before: the colder advisory held tonight
  })

  it('the warmed line cites the NEWEST real frost email about tonight', () => {
    expect(pickFrostLines(LADDER, currentLows(planFor(44, LADDER, hyLows(45)))).warmed).toBe(LADDER[1])
    const escalated = [...LADDER, PROTECT({ level: 'hard_freeze', lowF: 32, at: at('20:00') })]
    expect(screenOf(planFor(44, escalated, hyLows(45))).lines).toEqual([WARMED(44, '4 PM')])
    const adviceLast = [ADV(37.6, { at: at('20:00') }), PROTECT()]            // not produced today (dedup), pinned anyway
    expect(screenOf(planFor(44, adviceLast, hyLows(45))).lines).toEqual([WARMED(44, '4 PM')])
    const forcedLast = [...LADDER, PROTECT({ run: 'forced', at: at('21:00') })]   // a rehearsal is never cited
    expect(screenOf(planFor(44, forcedLast, hyLows(45))).lines).toEqual([WARMED(44, '3 PM')])
  })

  it('retired only when something speaks for tonight: no warmed line possible -> the advisory keeps the line', () => {
    // the plan low is not warmer than the email's own figure (40 = 40): "warmed to 40°F" would be false
    expect(screenOf(planFor(40, [ADV(40)], hyLows(41)))).toEqual({ card: 40, cue: coldText(40), lines: [POSSIBLE('tonight', 40)] })
    // an unreadable send time
    expect(screenOf(planFor(50, [ADV(37.6, { at: 'z' })], hyLows(45)))).toEqual({ card: 38, cue: null, lines: [POSSIBLE('tonight', 38)] })
    // CONTROL: warmer by a tenth, readable time -> retired
    expect(screenOf(planFor(40.1, [ADV(40)], hyLows(41))).lines).toEqual([WARMED(40.1, '2:05 PM')])
  })

  it('a retirement never leaves tonight without a line: the warmed line prints current\'s plan low, whatever `planLow` says', () => {
    const cur = currentLows(planFor(44, LADDER, hyLows(45)))
    for (const planLow of [undefined, null, 'n/a', 39]) {
      expect(texts(LADDER, { planLow, current: cur }), String(planLow)).toEqual([WARMED(44, '3 PM')])
    }
  })

  it('Protect rows follow the card: retired -> the plan\'s own "(low 44°F)" is back beside the plan low', () => {
    const rows = (plan) => buildCareNeeded(plan).filter((r) => r.need === 'cold').map((r) => r.reason)
    const after = rows(planFor(44, LADDER, hyLows(41.2)))
    expect(after.length).toBeGreaterThan(0)
    expect(after.some((r) => r.endsWith('(low 44°F)'))).toBe(true)
    expect(rows(planFor(44, LADDER)).some((r) => / \(low [^()]*\)$/.test(r))).toBe(false)   // before: one low, 38, no clause
  })
})

describe('ADVISORY_TRIP_F is the Lambda\'s advisory trip, not a guess (PARITY)', () => {
  it('equals frostEval\'s advisory trip with the env unset, and no crop band trips higher', () => {
    expect(process.env.FROST_ADVISORY_LOW_F, 'the shipped default is what this compares').toBeUndefined()
    expect(ADVISORY_TRIP_F).toBe(40)
    expect(frostEval.resolveThresholds().ADVISORY_LOW_F).toBe(ADVISORY_TRIP_F)
    const bands = Object.values(frostClass.resolveBandThresholds()).filter(Boolean)
    expect(bands.length).toBeGreaterThan(1)
    expect(Math.max(...bands.map((b) => b.ADVISORY_LOW_F))).toBe(ADVISORY_TRIP_F)
  })

  it('the split is the advisory tier\'s own decision: a D1 of 40.0 fires the email, 40.1 does not', () => {
    const T = frostEval.resolveThresholds()
    expect(frostEval.evalAdvisory([40, 50, 50], D1_3, T).fires).toBe(true)
    expect(frostEval.evalAdvisory([40.1, 50, 50], D1_3, T).fires).toBe(false)
  })
})

describe('Today — (4) mounted: the retirement reaches the card, the cue and the frost line together', () => {
  const readAll = (container) => {
    const q = within(container)
    return {
      card: q.getByTestId('weather-night-low').textContent,
      cue: q.queryByTestId('weather-cue-line')?.textContent ?? null,
      lines: q.queryAllByTestId('frost-alert-line').map((el) => el.textContent),
    }
  }

  it('THE GAP mounted: the ladder with the stored lows -> 44 on the card, the cool cue, and the warmed line alone', () => {
    planState.current = mountData(planFor(44, LADDER, hyLows(41.2)))
    const { container } = render(<Today />)
    expect(readAll(container)).toEqual({ card: '44°', cue: coldText(44), lines: [WARMED(44, '3 PM')] })
  })

  it('the same plan WITHOUT the stored lows (a row the Lambda half has not written): exactly today\'s screen', () => {
    planState.current = mountData(planFor(44, LADDER))
    const { container } = render(<Today />)
    expect(readAll(container)).toEqual({ card: '38°', cue: freezeText(38), lines: [POSSIBLE('tonight', 38)] })
  })

  it('an advisory-only night mounted (Dave\'s scope): 50 on the card, no cue, the warmed line citing 2:05 PM', () => {
    planState.current = mountData(planFor(50, [ADV()], hyLows(45)))
    const { container } = render(<Today />)
    expect(readAll(container)).toEqual({ card: '50°', cue: null, lines: [WARMED(50, '2:05 PM')] })
    const el = screen.getByTestId('frost-alert-line')
    expect([el.dataset.frostTier, el.dataset.frostNightOffset]).toEqual(['advisory', '0'])
  })
})

describe('Today — the frost lines mounted from plan.alerts_sent (V5-TODAYFROSTLINEGAPS-001)', () => {
  const readAll = (container) => {
    const q = within(container)
    return {
      card: q.getByTestId('weather-night-low').textContent,
      cue: q.queryByTestId('weather-cue-line')?.textContent ?? null,
      lines: q.queryAllByTestId('frost-alert-line').map((el) => el.textContent),
    }
  }

  it('(1) a watch and an advisory for tomorrow night: two lines under the cue, tonight first, the same element twice', () => {
    planState.current = mountData(planFor(41, [tomorrowNight(34, { at: at('18:00') }), watch(41, { at: at('19:00') })]))
    const { container } = render(<Today />)
    expect(readAll(container)).toEqual({ card: '41°', cue: coldText(41), lines: [WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)] })
    const cue = screen.getByTestId('weather-cue-line')
    const [a, b] = screen.getAllByTestId('frost-alert-line')
    expect(cue.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect([a.dataset.frostNightOffset, b.dataset.frostNightOffset]).toEqual(['0', '1'])
    expect(a.parentElement).toBe(cue.parentElement)                                       // items of Today's column, no wrapper
    expect(b.parentElement).toBe(cue.parentElement)
    expect(b.getAttribute('style')).toBe(a.getAttribute('style'))
    for (const el of [a, b]) expect(el.querySelectorAll('*')).toHaveLength(0)
  })

  it('(2) the watch with a colder second forecast: one low, 35, on the card, the cue and the line', () => {
    planState.current = mountData(planFor(41, [watch(41, { colder: colderTonight(35) })]))
    const { container } = render(<Today />)
    expect(readAll(container)).toEqual({ card: '35°', cue: freezeText(35), lines: [ASLOW('tonight', 35)] })
  })

  it('(3) a threshold email, the plan since warmed to 44: the plan\'s low everywhere, and the warmed line', () => {
    planState.current = mountData(planFor(44, [{ ...imminent(36), at: at('19:00') }]))
    const { container } = render(<Today />)
    expect(readAll(container)).toEqual({ card: '44°', cue: coldText(44), lines: [WARMED(44, '3 PM')] })
  })

  it('(3) while the plan low still freezes (39): the cue covers it and there is no line', () => {
    planState.current = mountData(planFor(39, [{ ...imminent(36), at: at('19:00') }]))
    const { container } = render(<Today />)
    expect(readAll(container)).toEqual({ card: '39°', cue: freezeText(39), lines: [] })
  })
})

// ══ Follow-up F1 (Dave, AskUserQuestion 2026-09-21 ~14:00 ET): TWO LINES FOR PLAIN ADVISORIES TOO ═════════════════════
// When tonight's line is a "Frost possible tonight" ADVISORY and an advisory for a LATER night also exists that plan
// date, Today shows both, tonight first, regardless of which was sent last (QA probes P1/P2). Kept: never two lines about
// the same night; the newest entry about the SAME night supersedes an older one; forced sends never count.
describe('F1 — advisories are ranked per night: tonight\'s and a later night\'s both show', () => {
  it('P1: a later-night advisory at 2 PM, then tonight\'s at 4 PM -> both, tonight first (the later night used to vanish)', () => {
    const list = [tomorrowNight(36.4, { at: at('18:00') }), tonight(37.6, { at: at('20:00') })]
    expect(texts(list)).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 36)])
    expect(agreedTonightLow(planFor(43, list))).toEqual({ lowF: 38, lowRaw: 37.6 })
  })

  it('P2: tonight\'s at 2 PM, then a later night\'s at 4 PM -> both, and tonight keeps its agreed low (it used to fall back)', () => {
    const list = [tonight(37.6, { at: at('18:00') }), tomorrowNight(36.4, { at: at('20:00') })]
    expect(texts(list)).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 36)])
    expect(agreedTonightLow(planFor(43, list))).toEqual({ lowF: 38, lowRaw: 37.6 })
    const rows = buildCareNeeded(planFor(43, list)).filter((r) => r.need === 'cold').map((r) => r.reason)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => / \(low [^()]*\)$/.test(r))).toBe(false)                    // one low for tonight
  })

  it('the newest entry about the SAME night supersedes an older one — tonight\'s and a later night\'s alike', () => {
    expect(texts([tonight(37.6, { at: at('18:00') }), tonight(35.2, { at: at('20:00') })])).toEqual([POSSIBLE('tonight', 35)])
    expect(texts([tonight(35.2, { at: at('20:00') }), tonight(37.6, { at: at('18:00') })])).toEqual([POSSIBLE('tonight', 35)])
    // two later nights: one later-night line, the newest (the advisory's coldest night moved)
    expect(texts([tomorrowNight(36.4, { at: at('18:00') }), tomorrowNight(31.4, { ...MONDAY, at: at('20:00') })])).toEqual([POSSIBLE('Monday night', 31)])
    expect(texts([tonight(37.6, { at: at('17:00') }), tomorrowNight(36.4, { at: at('18:00') }), tomorrowNight(31.4, { ...MONDAY, at: at('20:00') })]))
      .toEqual([POSSIBLE('tonight', 38), POSSIBLE('Monday night', 31)])
  })

  // CHANGED by follow-up F1b (orchestrator, 2026-09-21): this pinned the F1 consequence — a night MOVE of one civil-day
  // minimum showed both nights. Advisory statements with the same `date` are now ONE advisory: the newest attribution wins.
  it('ONE MINIMUM: a night move of D1 ("tomorrow night" at 2 PM corrected to "tonight" at 3 PM) shows only tonight', () => {
    const moved = [tonight(38, { nightOffset: 1, at: at('18:00') }), tonight(38, { at: at('19:00') })]
    expect(moved.map((a) => [a.dayOffset, a.date, a.nightOffset])).toEqual([[1, '2026-10-10', 1], [1, '2026-10-10', 0]])
    expect(texts(moved)).toEqual([POSSIBLE('tonight', 38)])
    expect(texts([...moved].reverse())).toEqual([POSSIBLE('tonight', 38)])            // array order is not send order
    expect(agreedTonightLow(planFor(43, moved))).toEqual({ lowF: 38, lowRaw: 38 })
  })

  it('ONE MINIMUM, the other correction: the newer names a LATER night -> only the later night, and tonight is no longer agreed', () => {
    const moved = [tonight(38, { at: at('18:00') }), tonight(38, { nightOffset: 1, at: at('19:00') })]
    expect(texts(moved)).toEqual([POSSIBLE('tomorrow night', 38)])
    expect(agreedTonightLow(planFor(43, moved))).toBeNull()
  })

  it('no usable `date`: not grouped, so the per-night-class rule holds — two lines', () => {
    for (const date of [undefined, null, '', 'bad']) {
      const pair = [tonight(38, { date, at: at('18:00') }), tomorrowNight(36.4, { date, at: at('19:00') })]
      expect(texts(pair), String(date)).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 36)])
    }
    // NEAR-MISS CONTROL: the same two nights sharing one usable date collapse to the newest
    expect(texts([tonight(38, { at: at('18:00') }), tomorrowNight(36.4, { date: '2026-10-10', dayOffset: 1, at: at('19:00') })]))
      .toEqual([POSSIBLE('tomorrow night', 36)])
  })

  it('two DIFFERENT minima (different dates) stay two lines, either order (P1/P2)', () => {
    const t = (hhmm) => tonight(37.6, { at: at(hhmm) })          // date 2026-10-10 (D1)
    const m = (hhmm) => tomorrowNight(36.4, { at: at(hhmm) })    // date 2026-10-11 (D2)
    expect(texts([m('18:00'), t('20:00')])).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 36)])
    expect(texts([t('18:00'), m('20:00')])).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 36)])
  })

  it('a watch email\'s carried "Colder ahead" is a statement about its date too: a newer one replaces an older tonight entry of that date', () => {
    const olderTonight = tonight(37.6, { at: at('18:00') })                                   // D1, before dawn -> tonight
    const w = watch(41, { at: at('19:00'), colder: { lowF: 36, dayOffset: 1, date: '2026-10-10', nightOffset: 1 } })   // D1 re-attributed
    expect(texts([olderTonight, w])).toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 36)])
    // a different date carried beside the tonight entry: both statements stand (tonight's colder advisory keeps tonight)
    const w2 = watch(41, { at: at('19:00'), colder: colderAhead(35) })                         // D2
    expect(texts([olderTonight, w2])).toEqual([POSSIBLE('tonight', 38), POSSIBLE('tomorrow night', 35)])
  })

  it('forced sends never count, in either night', () => {
    expect(texts([tonight(37.6, { at: at('18:00') }), tomorrowNight(34, { run: 'forced', at: at('20:00') })])).toEqual([POSSIBLE('tonight', 38)])
    expect(texts([tonight(30, { run: 'forced', at: at('21:00') }), tomorrowNight(36.4, { at: at('20:00') })])).toEqual([POSSIBLE('tomorrow night', 36)])
  })

  it('with a watch: a tonight advisory colder than the watch keeps tonight even when a later-night advisory is newer', () => {
    // (under the one-slot rule the newer later-night advisory hid the tonight advisory, and the WARMER watch took tonight)
    const list = [tonight(37.2, { at: at('18:00') }), tomorrowNight(34, { at: at('20:00') }), watch(41, { at: at('21:00') })]
    expect(texts(list)).toEqual([POSSIBLE('tonight', 37), POSSIBLE('tomorrow night', 34)])
    expect(agreedTonightLow(planFor(41, list))).toEqual({ lowF: 37, lowRaw: 37.2 })
    // ...and a WARMER tonight advisory still yields tonight to the watch, beside the later night
    expect(texts([tonight(42, { at: at('18:00') }), tomorrowNight(34, { at: at('20:00') }), watch(41, { at: at('21:00') })]))
      .toEqual([WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)])
  })

  it('Today: both advisory nights mounted, tonight first, the card and the cue on tonight\'s agreed 38', () => {
    planState.current = mountData(planFor(43, [tonight(37.6, { at: at('18:00') }), tomorrowNight(36.4, { at: at('20:00') })]))
    const { container } = render(<Today />)
    const q = within(container)
    expect(q.getByTestId('weather-night-low').textContent).toBe('38°')
    expect(q.getByTestId('weather-cue-line').textContent).toBe(freezeText(38))
    expect(q.getAllByTestId('frost-alert-line').map((el) => [el.textContent, el.dataset.frostNightOffset]))
      .toEqual([[POSSIBLE('tonight', 38), '0'], [POSSIBLE('tomorrow night', 36), '1']])
  })
})
