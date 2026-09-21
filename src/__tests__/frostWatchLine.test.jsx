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
import { buildFrostAlertLine, buildFrostAlertLines, pickAdvisory, resolveNight, FREEZE_BELOW_F } from '../lib/frostAlertLine.js'
import { agreedTonightLow, agreeCallout } from '../lib/tonightLow.js'
import { buildCareNeeded } from '../lib/careNeeded.js'
import {
  PLAN_DATE, GEN, planFor, tonight, tomorrowNight, imminent, coldText, freezeText,
} from './helpers/twoLowsFixtures.js'

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

  it('advisory-only lists pick exactly as before (a threshold imminent beside them changes nothing)', () => {
    const t = tonight(37.6, { at: at('19:05') })
    const m = tomorrowNight(36.4, { at: at('20:05') })
    expect(buildFrostAlertLine([t, m])).toEqual(buildFrostAlertLine([t, m, imminent(36)]))
    expect(buildFrostAlertLine([t, m]).nightOffset).toBe(1)
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

  it('only one applies -> exactly one line, as before; the newest advisory still supersedes an older one', () => {
    expect(texts([watch(41)])).toEqual([WATCH('tonight', 41)])
    expect(texts([tomorrowNight(36.4)])).toEqual([POSSIBLE('tomorrow night', 36)])
    expect(texts([tonight(37.6)])).toEqual([POSSIBLE('tonight', 38)])
    expect(texts([])).toEqual([])
    expect(texts([tomorrowNight(36.4, { at: at('18:00') }), tonight(37.6, { at: at('20:00') })])).toEqual([POSSIBLE('tonight', 38)])
    expect(texts([tonight(37.6, { at: at('18:00') }), tomorrowNight(36.4, { at: at('20:00') })])).toEqual([POSSIBLE('tomorrow night', 36)])
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
