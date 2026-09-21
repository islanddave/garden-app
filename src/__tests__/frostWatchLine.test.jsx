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
import { buildFrostAlertLine, pickAdvisory, resolveNight } from '../lib/frostAlertLine.js'
import { agreedTonightLow } from '../lib/tonightLow.js'
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

  it('a watch outranks an advisory for a LATER night, sent before or after it', () => {
    for (const advAt of ['18:00', '21:00']) {
      const adv = tomorrowNight(34, { at: at(advAt) })
      expect(buildFrostAlertLine([adv, watch(41, { at: at('19:00') })]).text, advAt).toBe(WATCH('tonight', 41))
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
