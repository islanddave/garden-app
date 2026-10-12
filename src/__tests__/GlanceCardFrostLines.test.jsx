// V5-TODAYFROSTLINEGAPS-001 residue G4 / BUG-FROSTALERTNOAPP-001 residue R5 — the three frost-line cases on the
// REDESIGNED Today's mount.
//
// Dave's three decisions (2026-09-21) — two lines, one per night; "as low as" the email's colder second forecast;
// "Forecast warmed" after a threshold email — are unit-tested on Today V1's mount only (frostWatchLine.test.jsx
// "Today — the frost lines mounted from plan.alerts_sent"). V2 mounts the same component from GlanceCard.jsx with
// the same four props, and GlanceCard.test.jsx covers one watch line. Same component is not same output: each
// case below depends on a different prop (`alertsSent` for the second line, `lowShown` for the one low per night,
// `planLow` for the warmed line), so a V2 mount that drops one prints different words on the same plan.
//
// Fixtures are V1's own (helpers/twoLowsFixtures.js: engine-shaped plans, handler-shaped alerts_sent entries) and
// the cases are V1's own plans, so the expected strings here are the strings that suite expects. Each case also
// renders the line the way Today.jsx mounts it and holds the two to the same text.
//
// MUTATIONS that turn it red (each applied to GlanceCard.jsx, seen red, reverted — lane t3-frosttests-20261011):
//   * the FrostAlertLine mount removed                     -> every case that prints a line (5 of 6)
//   * `planLow={weather.tonightLow}` dropped                -> (3) the warmed line
//   * `lowShown={agreed?.lowF}` dropped                     -> (1) the agreed-low case
//   * `alertsSent` handed only the newest entry             -> all three (1) cases
//   * the mount moved inside the `{open && …}` details      -> the same 5, on their "closed" reading
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: fetchMock }) }))

import GlanceCard from '../components/today/v2/GlanceCard.jsx'
import FrostAlertLine from '../components/today/FrostAlertLine.jsx'
import { agreedTonightLow, agreeCallout } from '../lib/tonightLow.js'
import { currentLows } from '../lib/frostAlertLine.js'
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
function V2({ plan }) {
  const [open, setOpen] = useState(false)
  const agreed = agreedTonightLow(plan)
  return (
    <GlanceCard plan={plan} generatedAt={GEN} planDate={PLAN_DATE} agreed={agreed} current={currentLows(plan)}
      cueCallout={agreeCallout(plan.weather?.callout, agreed)} open={open} onToggle={() => setOpen((o) => !o)} />
  )
}
// Today.jsx's mount of the line, prop for prop (Today.jsx: alertsSent / lowShown / planLow / current).
function V1Line({ plan }) {
  return <FrostAlertLine alertsSent={plan.alerts_sent} lowShown={agreedTonightLow(plan)?.lowF} planLow={plan.weather?.tonightLow} current={currentLows(plan)} />
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
const v1Lines = (plan) => {
  const { container, unmount } = rtlRender(<V1Line plan={plan} />)
  const out = [...container.querySelectorAll('[data-testid="frost-alert-line"]')].map((el) => el.textContent)
  unmount()
  return out
}
// The card closed (the first screen), then open: the same lines both ways, and never a remount between.
const bothStates = (plan, expected) => {
  render(<V2 plan={plan} />)
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(readV2(), 'closed').toEqual(expected)
  const before = frostEls()
  fireEvent.click(toggle())
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(frostEls().map((el) => el.textContent), 'open').toEqual(expected.lines)
  frostEls().forEach((el, i) => expect(el).toBe(before[i]))
  expect(v1Lines(plan), 'the same text Today V1 prints').toEqual(expected.lines)
}

beforeEach(() => { fetchMock.mockClear() })
afterEach(cleanup)

describe('Today V2 glance — the frost lines mounted from plan.alerts_sent (V5-TODAYFROSTLINEGAPS-001)', () => {
  it('(1) a watch and an advisory for tomorrow night: two lines under the cue, tonight first', () => {
    const plan = planFor(41, [tomorrowNight(34, { at: at('18:00') }), watch(41, { at: at('19:00') })])
    bothStates(plan, { low: '41°', cue: coldText(41), lines: [WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)] })
    const cue = screen.getByTestId('weather-cue-line')
    const [a, b] = frostEls()
    expect(cue.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect([a.dataset.frostNightOffset, b.dataset.frostNightOffset]).toEqual(['0', '1'])
    expect(a.parentElement).toBe(cue.parentElement)                 // items of the card's column, no wrapper
    expect(b.parentElement).toBe(cue.parentElement)
  })

  it('(1) the entries in the other order: still two lines, tonight first', () => {
    const plan = planFor(41, [watch(41, { at: at('19:00') }), tomorrowNight(34, { at: at('21:00') })])
    bothStates(plan, { low: '41°', cue: coldText(41), lines: [WATCH('tonight', 41), POSSIBLE('tomorrow night', 34)] })
  })

  it('(1) the agreed low reaches tonight\'s line only: a plan low of 39 under a 41 watch reads 39; the later night keeps 34', () => {
    const plan = planFor(39, [tomorrowNight(34), watch(41)])
    bothStates(plan, { low: '39°', cue: freezeText(39), lines: [WATCH('tonight', 39), POSSIBLE('tomorrow night', 34)] })
  })

  it('(2) the watch with a colder second forecast: one low, 35, on the card, the cue and the line', () => {
    const plan = planFor(41, [watch(41, { colder: colderTonight(35) })])
    bothStates(plan, { low: '35°', cue: freezeText(35), lines: [ASLOW('tonight', 35)] })
  })

  it('(3) a threshold email, the plan since warmed to 44: the plan\'s low everywhere, and the warmed line', () => {
    const plan = planFor(44, [{ ...imminent(36), at: at('19:00') }])
    bothStates(plan, { low: '44°', cue: coldText(44), lines: [WARMED(44, '3 PM')] })
    expect(frostEls()[0].dataset.frostTier).toBe('imminent')
  })

  it('(3) while the plan low still freezes (39): the cue covers it and there is no line', () => {
    const plan = planFor(39, [{ ...imminent(36), at: at('19:00') }])
    bothStates(plan, { low: '39°', cue: freezeText(39), lines: [] })
  })
})
