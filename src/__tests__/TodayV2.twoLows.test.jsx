// V5-FROSTTWOMODELS-001 — one low per night on Today: the MOUNT. The pure half is tonightLow.test.js.
//
// V5-TODAYREDESIGN-001 S8c (L8): ported from TodayTwoLows.test.jsx when the old Today page was removed. The wiring
// is what these cases exist for: every helper in src/lib/tonightLow.js can be right while the page passes the wrong
// thing to the wrong component, and then it still prints two lows for one night with every unit test green. So each
// case hands TodayV2 an ENGINE-SHAPED stored plan (the REAL computeCallout and coldFor, helpers/twoLowsFixtures.js)
// and reads what the page renders: the glance card's row A low, the frost line (behind Details when Protect tonight
// is on the page — finish plan §3.3, D15), and every figure in Protect tonight's opened body. Protect's rows drop the
// "(low …)" clause on every night (lib/todayV2/protect.js), so the old file's per-row reason column has no V2 form;
// and tonight's frost line states no figure at all — row A states it (lib/todayV2/alerts.js frostLineText: "Frost
// possible tonight. Plan cover …"), so on a trigger night the page prints tonight's low exactly ONCE;
// the cue's own re-wording at the agreed low is TodayV2.test.jsx ("hands the plan date to the cue"); the glance card's
// own lines are GlanceCard.test.jsx and GlanceCardFrostLines.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, prefsState, auth, api } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' } },
  api: { fetch: vi.fn(async () => ({ accepted: 1 })), getToken: async () => 't' },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? [] : { locations: [] }, loading: false, error: null }) }))
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2 from '../pages/TodayV2.jsx'
import { ROWS, GRID_LOWS, GRID_ENTRIES, PLAN_DATE, GEN, planFor, tonight } from './helpers/twoLowsFixtures.js'
import { CUE_IMPRESSIONS_PATH } from '../lib/weatherCueImpressions.js'

const mountData = (plan) => ({ data: { has_plan: true, plan_date: PLAN_DATE, generated_at: GEN, plan }, loading: false, error: null, reload: vi.fn() })
// The old page's frost line for tonight carried the low; the redesign's does not (row A has it). A later night's
// line keeps its own figure.
const v2Line = (line) => (line == null ? null : line.replace(/^(Frost possible tonight) — low -?\d+°F\./, '$1.'))
const fresh = () => { localStorage.clear(); sessionStorage.clear() }   // Details and Protect opened here are remembered
const bareTemps = (root) => [...root.querySelectorAll('*')].filter((el) => !el.children.length && /^-?\d+(?:\.\d+)?°$/.test((el.textContent || '').trim())).map((el) => el.textContent.trim())

// What the page says about tonight's low: row A of the closed glance card, then — Details opened — the frost line,
// and Protect tonight's opened body (it lists no figure of its own, so any it carries is a second low).
function readPage() {
  const glance = screen.getByTestId('today-glance')
  const toggle = glance.querySelector('[aria-expanded]')
  const card = bareTemps(toggle)[1] ?? null
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  const line = screen.queryAllByTestId('frost-alert-line').map((el) => el.textContent)[0] ?? null
  const sec = screen.queryByTestId('today-sec-protect')
  let protect = null
  if (sec) {
    const h = sec.querySelector('[aria-expanded]')
    if (h.getAttribute('aria-expanded') !== 'true') fireEvent.click(h)
    protect = (within(sec).queryAllByTestId('protect-row').map((r) => r.textContent).join(' | ').match(/-?\d+(?:\.\d+)?°F?/g) || [])
  }
  return { card: card == null ? null : card.slice(0, -1), line, protect }
}

const impressions = () => api.fetch.mock.calls.filter((c) => c[0] === CUE_IMPRESSIONS_PATH).map((c) => JSON.parse(c[1].body))
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); api.fetch.mockClear() })
afterEach(cleanup)

describe('the spec table on Today — rows 1-12: the card and the frost line print the row\'s ONE low', () => {
  it.each(ROWS.map((r) => [r.n, r]))('row %i', (_n, row) => {
    planState.current = mountData(planFor(row.low, row.entries, row.hy))
    render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    const page = readPage()
    expect(page.card).toBe(row.after.card === '' ? null : row.after.card)
    expect(page.line).toBe(v2Line(row.after.line))
    if (page.protect) expect(page.protect).toEqual([])
  })

  // The cue impression (OPS-CUEINSTRUMENT-001) bills a cue the page PAINTED, once, at the model version the row
  // specifies (the agreed cue's on a trigger night). With Protect tonight on the page the cold-side cue folds into it
  // (finish plan §3.3, D15): a pick cue is its pick link and bills when that paints (ProtectTonight
  // useFoldedCueImpression); a folded cue with no pick words (freeze: the link keeps its own "Pick what's ripe first")
  // is painted nowhere and bills nothing — a change from the old page, which always printed the cue line (reported in
  // the L8 hand-back). The plan is dated Oct 9, so nothing
  // opens by itself here (stale, §3): Protect is opened so a pick link can paint.
  const billedRows = new Set()
  it.each(ROWS.map((r) => [r.n, r]))('row %i bills a painted cue as specified, and an unpainted one not at all', (_n, row) => {
    planState.current = mountData(planFor(row.low, row.entries, row.hy))
    render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    const sec = screen.queryByTestId('today-sec-protect')
    if (sec) fireEvent.click(sec.querySelector('[aria-expanded]'))
    // A pick link speaks the cue's words, or — on a night whose cue names no pick (freeze) — its own default.
    const pick = screen.queryByTestId('protect-pick')?.textContent || ''
    const painted = !!screen.queryByTestId('weather-cue-line') || (!!pick && !/^Pick what’s ripe first/.test(pick))
    const billed = impressions()
    if (row.after.model == null || !painted) expect(billed).toEqual([])
    else {
      expect(billed).toHaveLength(1)
      expect(billed[0].model_version).toBe(row.after.model)
      billedRows.add(row.n)
    }
  })
  it('…and the table is not vacuous: some rows painted their cue and billed it', () => {
    expect(billedRows.size).toBeGreaterThan(0)
  })

  it('no source name, asterisk or "adjusted" mark anywhere on a trigger night', () => {
    planState.current = mountData(planFor(43, [tonight(37.6)]))
    const { container } = render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    const page = readPage()
    expect(container.textContent).not.toMatch(/\*|adjusted|NWS|Open-Meteo forecast low|advisory low|station/i)
    // Control: the page did change — the card prints the agreed 38 (not the plan's 43), and the line no second one.
    expect(page.card).toBe('38')
    expect(page.line).toBe('Frost possible tonight. Plan cover for tender plants.')
  })
})

describe('the grid — plan low x entry x the REAL callout: ONE number for tonight when the trigger is on', () => {
  it('every combination', () => {
    const nums = (s) => (s == null ? [] : (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number))
    let on = 0, off = 0
    for (const low of GRID_LOWS) {
      for (const { name, entries, tonightLow } of GRID_ENTRIES) {
        fresh()
        planState.current = mountData(planFor(low, structuredClone(entries)))
        const { unmount } = render(<MemoryRouter><TodayV2 /></MemoryRouter>)
        const page = readPage()
        const where = `plan low ${low} x ${name}`
        if (tonightLow != null) {
          const T = Math.round(low == null ? tonightLow : Math.min(low, tonightLow))
          expect(page.card, where).toBe(String(T))
          expect(page.line, where).toBe('Frost possible tonight. Plan cover for tender plants.')
          expect([...new Set([...nums(page.card), ...nums(page.line)])], where).toEqual([T])
          if (page.protect) expect(page.protect, where).toEqual([])
          on++
        } else {
          // No trigger: exactly the plan's own low, as stored.
          expect(page.card, where).toBe(low == null ? null : String(low))
          off++
        }
        unmount()
        cleanup()
      }
    }
    expect([on, off]).toEqual([GRID_LOWS.length * 5, GRID_LOWS.length * 2])
  })
})

// FINDING at S8c (the old file's grid asserted the card printed nothing for a plan with no low and no trigger): the
// redesign's glance row A prints `${low}°` unconditionally (GlanceCard.jsx), so such a plan reads "null°". Reported
// in the L8 hand-back; pinned as a known failure so the fix flips this to a plain `it`.
describe('a plan with no tonight low and no frost trigger', () => {
  it.fails('row A prints no night low — never "null°"', () => {
    planState.current = mountData(planFor(null, []))
    render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    expect(screen.getByTestId('today-glance').querySelector('[aria-expanded]').textContent).not.toMatch(/null°/)
  })
})
