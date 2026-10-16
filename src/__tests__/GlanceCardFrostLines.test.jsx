// V5-TODAYFROSTLINEGAPS-001 residue G4 / BUG-FROSTALERTNOAPP-001 residue R5 — the three frost-line cases on the
// REDESIGNED Today's mount.
//
// Dave's three decisions (2026-09-21) — two lines, one per night; "as low as" the email's colder second forecast;
// "Forecast warmed" after a threshold email — are unit-tested on Today V1's mount only (frostWatchLine.test.jsx
// "Today — the frost lines mounted from plan.alerts_sent"). V2 builds the same lines from GlanceCard.jsx with the
// same four inputs (buildFrostAlertLines: `alertsSent` for the second line, `lowShown` for the one low per night,
// `planLow` for the warmed line, `current`), so a V2 mount that drops one prints different words on the same plan.
//
// Finish plan §3.2–3.3 (Dave's D15, 2026-10-14) changed what V2 PRINTS of them, on purpose: tonight's line drops its
// low (the card's row A is the one place tonight's low is stated) — short under the card ("Frost watch tonight —
// clear and calm."), in full behind Details; a later night's line and a warmed line print as built; with no Protect
// section the first line stays under the card, and with one every line waits behind Details. Each case also holds
// the lines AS BUILT (lib/frostAlertLine.js buildFrostAlertLines, the four inputs the old page's FrostAlertLine
// rendered prop for prop) to the strings frostWatchLine.test.jsx expects — until S8c (L8) that half rendered the old
// component itself; the component went with the old page, the builder it rendered stays.
//
// Fixtures are the old page's own (helpers/twoLowsFixtures.js: engine-shaped plans, handler-shaped alerts_sent
// entries) and the cases are its own plans.
//
// MUTATIONS that turn it red (GlanceCard.jsx):
//   * the frost lines not built / not rendered               -> every case that prints a line (5 of 6)
//   * `planLow={weather.tonightLow}` dropped                -> (3) the warmed line
//   * `alertsSent` handed only the newest entry             -> all three (1) cases (the later night's line)
//   * the under-card line moved inside the `{open && …}`     -> the same 5, on their "closed" reading
//   * the Protect fold ignored (`protectShown` unread)       -> the Protect case
// (`lowShown` now reaches only the low tonight's line no longer prints on V2; the card's row A reads `agreed`.)
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: fetchMock }) }))

import GlanceCard from '../components/today/v2/GlanceCard.jsx'
import { agreedTonightLow, agreeCallout } from '../lib/tonightLow.js'
import { currentLows, buildFrostAlertLines } from '../lib/frostAlertLine.js'
import {
  PLAN_DATE, GEN, planFor, tomorrowNight, imminent, coldText, freezeText,
} from './helpers/twoLowsFixtures.js'

// frostWatchLine.test.jsx's entry builders and sentences, verbatim.
const watch = (lowF, over = {}) => ({ ...imminent(lowF), key: `sp1|${PLAN_DATE}|imminent|protect|w${lowF}`, trip: 'radiative', ...over })
const at = (hhmm) => `2026-10-09T${hhmm}:00.000Z`
const colderTonight = (lowF) => ({ lowF, dayOffset: 1, date: '2026-10-10', nightOffset: 0 })
const WATCH = (when, t) => `Frost watch ${when} — clear and calm, low ${t}°F. Plan cover for tender plants.`
const POSSIBLE = (when, t) => `Frost possible ${when} — low ${t}°F. Plan cover for tender plants.`
const ASLOW = (when, t) => `Frost watch ${when} — clear and calm, as low as ${t}°F. Plan cover for tender plants.`
const WARMED = (t, time) => `Forecast warmed to ${t}°F since the ${time} frost email.`

// TodayV2.jsx's own derivations (agreed, current, cueCallout) feeding the card, as GlanceCard.test.jsx's Harness.
function V2({ plan, protectShown = false }) {
  const [open, setOpen] = useState(false)
  const agreed = agreedTonightLow(plan)
  return (
    <GlanceCard plan={plan} generatedAt={GEN} planDate={PLAN_DATE} agreed={agreed} current={currentLows(plan)}
      cueCallout={agreeCallout(plan.weather?.callout, agreed, PLAN_DATE)} open={open} onToggle={() => setOpen((o) => !o)} protectShown={protectShown} />
  )
}
const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
const glance = () => screen.getByTestId('today-glance')
const toggle = () => glance().querySelector('[aria-expanded]')
const frostEls = (root = glance()) => within(root).queryAllByTestId('frost-alert-line')
const bareTemps = (root) => [...root.querySelectorAll('*')].filter((el) => !el.children.length && /^-?\d+°$/.test((el.textContent || '').trim())).map((el) => el.textContent.trim())
const readV2 = () => ({
  low: bareTemps(toggle())[1],
  cue: within(glance()).queryByTestId('weather-cue-line')?.textContent ?? null,
  lines: frostEls().map((el) => el.textContent),
})
// The lines as built, from the same four inputs the old page handed its FrostAlertLine (alertsSent / lowShown /
// planLow / current) — the full words, lows included.
const builtLines = (plan) => (buildFrostAlertLines(plan.alerts_sent, { lowShown: agreedTonightLow(plan)?.lowF, planLow: plan.weather?.tonightLow, current: currentLows(plan) }) || []).map((l) => l.text)
// No Protect section: the card closed (the first screen) shows the first line under it, short; open, every line
// behind Details, tonight's without its low. The lines as built keep their full words.
const SHORT = 'Frost watch tonight — clear and calm.'
const FULL = 'Frost watch tonight — clear and calm. Plan cover for tender plants.'
const bothStates = (plan, { low, cue, closed, open, built }) => {
  render(<V2 plan={plan} />)
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(readV2(), 'closed').toEqual({ low, cue, lines: closed })
  fireEvent.click(toggle())
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(frostEls().map((el) => el.textContent), 'open').toEqual(open)
  expect(builtLines(plan), 'the lines as built, unchanged').toEqual(built)
}

beforeEach(() => { fetchMock.mockClear() })
afterEach(cleanup)

describe('Today V2 glance — the frost lines mounted from plan.alerts_sent (V5-TODAYFROSTLINEGAPS-001)', () => {
  it('(1) a watch and an advisory for tomorrow night: tonight\'s under the cue, both behind Details, tonight first', () => {
    const plan = planFor(41, [tomorrowNight(34, { at: at('18:00') }), watch(41, { at: at('19:00') })])
    bothStates(plan, { low: '41°', cue: coldText(41), closed: [SHORT], open: [FULL, POSSIBLE('tomorrow night', 34)], built: [WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)] })
    const [a, b] = frostEls()
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect([a.dataset.frostNightOffset, b.dataset.frostNightOffset]).toEqual(['0', '1'])
    // Tonight's carries the warning mark; the later night's is advice (no mark).
    expect([a.querySelectorAll('svg').length, b.querySelectorAll('svg').length]).toEqual([1, 0])
  })

  it('(1) the entries in the other order: still two lines, tonight first', () => {
    const plan = planFor(41, [watch(41, { at: at('19:00') }), tomorrowNight(34, { at: at('21:00') })])
    bothStates(plan, { low: '41°', cue: coldText(41), closed: [SHORT], open: [FULL, POSSIBLE('tomorrow night', 34)], built: [WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)] })
  })

  it('(1) the agreed low is the card\'s: a plan low of 39 under a 41 watch reads 39 in row A and the cue; the later night keeps 34', () => {
    const plan = planFor(39, [tomorrowNight(34), watch(41)])
    bothStates(plan, { low: '39°', cue: freezeText(39), closed: [SHORT], open: [FULL, POSSIBLE('tomorrow night', 34)], built: [WATCH('tonight', 39), POSSIBLE('tomorrow night', 34)] })
  })

  it('(2) the watch with a colder second forecast: one low, 35, on the card and the cue; the line names none', () => {
    const plan = planFor(41, [watch(41, { colder: colderTonight(35) })])
    bothStates(plan, { low: '35°', cue: freezeText(35), closed: [SHORT], open: [FULL], built: [ASLOW('tonight', 35)] })
  })

  it('(3) a threshold email, the plan since warmed to 44: the plan\'s low everywhere, and the warmed line as built', () => {
    const plan = planFor(44, [{ ...imminent(36), at: at('19:00') }])
    bothStates(plan, { low: '44°', cue: coldText(44), closed: [WARMED(44, '3 PM')], open: [WARMED(44, '3 PM')], built: [WARMED(44, '3 PM')] })
    expect(frostEls()[0].dataset.frostTier).toBe('imminent')
    expect(frostEls()[0].querySelectorAll('svg')).toHaveLength(0) // a warmed line is no warning
  })

  it('(3) while the plan low still freezes (39): the cue covers it and there is no line', () => {
    const plan = planFor(39, [{ ...imminent(36), at: at('19:00') }])
    bothStates(plan, { low: '39°', cue: freezeText(39), closed: [], open: [], built: [] })
  })

  // Ported from FrostAlertLine.test.jsx ("the wiring") at S8c: no advisory on the day — an empty list, or the key
  // absent entirely — is no line at all, closed or open; never an empty strip.
  it('no advisory (alerts_sent empty, or absent): no frost line, closed or open', () => {
    for (const plan of [planFor(41, []), (() => { const p = planFor(41, []); delete p.alerts_sent; return p })()]) {
      render(<V2 plan={plan} />)
      expect(frostEls()).toEqual([])
      fireEvent.click(toggle())
      expect(screen.getByTestId('today-weather')).toBeTruthy()   // the details did open — not vacuous
      expect(frostEls()).toEqual([])
      cleanup()
    }
  })

  it('D15: a Protect section on the page takes them — none under the card, every line behind Details', () => {
    const plan = planFor(41, [tomorrowNight(34, { at: at('18:00') }), watch(41, { at: at('19:00') })])
    render(<V2 plan={plan} protectShown />)
    expect(readV2()).toEqual({ low: '41°', cue: null, lines: [] })
    fireEvent.click(toggle())
    expect(frostEls().map((el) => el.textContent)).toEqual([FULL, POSSIBLE('tomorrow night', 34)])
  })
})
