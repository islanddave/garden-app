// PANEL Q1 (harvest-panel-decisions-20260812.md) — the cultivation lead line: one or two
// imperative lines, NO heading, NO count, cap 2. Content is a read of the sow engine's own
// window_closing output (latestSafeMs fall-sow close dates) — these tests run the REAL engine
// against fixture candidates on a fixed date, so a line here is a line the engine itself would
// print.
//
// V4-SOWMOREMENU-001 (BD-067) — the "renders NOTHING when empty" assertions in this file were
// INVERTED, not deleted, and they are the reason the inversion needs saying out loud: the region is
// now Today's durable door to /sow, so the empty case renders a bare "Sow now" link instead of
// null. The four cases that used to assert null (empty candidates, open-but-not-closing, fetch
// error, pre-resolve) still exist below and now assert the SAME THING they always did about
// CONTENT — no urgency lines are invented — while additionally pinning that the door survives each
// of those states. A fetch error degrading to a working link rather than to nothing is the point of
// the change; deleting these would have hidden exactly that.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import CultivationLead, { cultivationLines, CULTIVATION_LEAD_CAP } from '../components/today/CultivationLead.jsx'

// The component renders a <Link>, so every render needs a router above it.
const renderLead = (props = {}) => render(
  <MemoryRouter><CultivationLead {...props} /></MemoryRouter>
)

// 2026 anchors: FF (sowing-safety margin) = 09-28, FFobs (measured median first frost) = 10-29.
// Lettuce is fall-hardy (V4-HARDYSET-001), so a cool + annual DIRECT sow closes at FFobs - dtm:
// dtm 72 -> Aug 18 (6 days from the fixed TODAY, inside the 10-day closing window); dtm 75 -> Aug
// 15; dtm 77 -> Aug 13. The fall INDOOR pass is a SEPARATE clamp and now sits on the same anchor for
// hardy crops — FFobs - dtm - FALL_SLOWDOWN 14 — so the indoor fixture takes dtm 58 for the same
// Aug 18. (It carried 55 while that pass was still on FF + 28 - dtm - 14.)
//
// The dtm figures were raised by 14 to hold these dates when lettuce gained the hardy grace
// (V4-HARDYSET-001), then by a further 3 when BUG-FROSTANCHORWRONG-001 moved the hardy DIRECT clamp
// off the safety margin onto the measured anchor, and the indoor fixture by 3 when
// V4-FALLINDOORHARDY-001 did the same to the INDOOR pass. Every EXPECTED string below is unchanged
// across all three, deliberately: the contract under test is the lead line's wording, cap and
// ordering, and none of that moved — only the shared clamps that decide which packets are closing.
// Retuning the input rather than the assertions keeps that visible.
const TODAY = '2026-08-12'
const lettuce = (over = {}) => ({
  variety_name: 'Winter Density', item_name: 'Lettuce packet', crop_type_slug: 'lettuce',
  lifecycle: 'annual', sow_season: 'cool', days_to_maturity_max: 72, days_to_maturity_min: null,
  // Class B ("after last frost"), NOT class C. This fixture carried
  // 'as soon as the soil can be worked' until 2026-09-01, when BUG-SOWCLASSC-001 moved class C's
  // close onto a SPRING bound — because a spring clause producing an August sow date was the
  // reported defect, and this fixture was reproducing it: the lead read "Sow Winter Density by
  // Aug 18" off an instruction that says to sow as soon as the ground thaws.
  //
  // Retuning the INPUT rather than the expected strings is this file's own stated convention (see
  // the note above — the dtm figures have been retuned three times for the same reason). The
  // contract under test is the lead line's wording, cap and ordering, none of which moved. Class B
  // still closes at latestSafe, so a fall-hardy cool annual still lands on FFobs - dtm = Aug 18 and
  // every EXPECTED string below is unchanged.
  //
  // It also demonstrates the thing worth being sure of: the August FALL sowing is still reachable.
  // BUG-SOWCLASSC-001 removed a spring clause's ability to masquerade as a fall window; it did not
  // remove fall windows.
  direct_sow_timing: 'after last frost', start_method: null,
  ...over,
})

beforeEach(() => { fetchMock.mockReset() })

describe('cultivationLines (pure, real engine)', () => {
  it('emits an imperative line with the engine-computed close date', () => {
    expect(cultivationLines([lettuce()], TODAY)).toEqual(['Sow Winter Density by Aug 18.'])
  })

  it('uses the indoor verb when the closing window is an indoor start', () => {
    const basil = lettuce({
      variety_name: 'Genovese Basil', direct_sow_timing: null, days_to_maturity_max: 58,
      start_method: 'start_indoors', start_indoor_weeks_min: 4, start_indoor_weeks_max: 4,
    })
    expect(cultivationLines([basil], TODAY)).toEqual(['Start Genovese Basil indoors by Aug 18.'])
  })

  it('caps at 2, most urgent first — never a third orient decision', () => {
    expect(CULTIVATION_LEAD_CAP).toBe(2)
    const lines = cultivationLines([
      lettuce({ variety_name: 'A', days_to_maturity_max: 72 }), // Aug 18
      lettuce({ variety_name: 'B', days_to_maturity_max: 77 }), // Aug 13
      lettuce({ variety_name: 'C', days_to_maturity_max: 75 }), // Aug 15
    ], TODAY)
    expect(lines).toEqual(['Sow B by Aug 13.', 'Sow C by Aug 15.'])
  })

  it('yields nothing when no window is closing — an open-but-not-closing window is /sow business', () => {
    // dtm 30 -> close Sep 29, 48 days out: open, not closing.
    expect(cultivationLines([lettuce({ days_to_maturity_max: 30 })], TODAY)).toEqual([])
  })

  it('yields nothing for empty or junk input, never a throw', () => {
    expect(cultivationLines([], TODAY)).toEqual([])
    expect(cultivationLines(null, TODAY)).toEqual([])
    expect(cultivationLines(undefined, TODAY)).toEqual([])
  })

  // V4-SEEDZEROVIEW-001. Today was the SECOND surface offering an empty packet — the ledger row
  // named only /sow, but both read the same payload through the same bucketizer. There is no
  // predicate in this component; the assertions below are what proves the engine's divert reaches
  // here, which is the whole reason the fix went in bucketize rather than in each surface.
  it('never names a packet there is none of left', () => {
    expect(cultivationLines([lettuce({ quantity_on_hand: 0 })], TODAY)).toEqual([])
    expect(cultivationLines([lettuce({ quantity_on_hand: '0' })], TODAY)).toEqual([])
  })

  it('still names an UNTRACKED packet — NULL is "not counted", not "used up"', () => {
    // The deliberate split from InventoryDetail's `?? 0` collapse. On a planning line, hiding an
    // uncounted packet forfeits the sowing silently; see isDepleted's note.
    expect(cultivationLines([lettuce({ quantity_on_hand: null })], TODAY))
      .toEqual(['Sow Winter Density by Aug 18.'])
  })

  it('still names a half-empty packet — a fraction is stock', () => {
    expect(cultivationLines([lettuce({ quantity_on_hand: '0.5' })], TODAY))
      .toEqual(['Sow Winter Density by Aug 18.'])
  })

  it('drops only the empty packet from a mixed list, keeping order and cap', () => {
    const lines = cultivationLines([
      lettuce({ variety_name: 'A', days_to_maturity_max: 72 }),                       // Aug 18
      lettuce({ variety_name: 'B', days_to_maturity_max: 77, quantity_on_hand: 0 }),  // Aug 13, empty
      lettuce({ variety_name: 'C', days_to_maturity_max: 75 }),                       // Aug 15
    ], TODAY)
    // Without the filter B would take the first slot and evict A under the cap of 2 — so this
    // pins that an empty packet cannot crowd out a real one, not just that it goes unnamed.
    expect(lines).toEqual(['Sow C by Aug 15.', 'Sow A by Aug 18.'])
  })
})

describe('CultivationLead component', () => {
  it('renders one or two imperative lines with NO heading and NO count', async () => {
    fetchMock.mockResolvedValue({ items: [lettuce()] })
    renderLead({ todayISO: TODAY })
    const lead = await screen.findByText('Sow Winter Density by Aug 18.')
    const region = screen.getByTestId('cultivation-lead')
    expect(lead).toBeTruthy()
    expect(region.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(region.textContent).not.toMatch(/Showing \d+|\d+ of \d+/i)
    // No urgency grammar — a date is information, a countdown is pressure.
    expect(region.textContent).not.toMatch(/days left|hurry|don'?t|!/i)
  })

  // V4-SOWMOREMENU-001 — the door itself. Kept separate from the content assertions above so a
  // regression tells you WHICH half broke: the route out, or what it says.
  it('is a tap target to /sow, at the 44px floor, in every state', async () => {
    fetchMock.mockResolvedValue({ items: [lettuce()] })
    renderLead({ todayISO: TODAY })
    const region = await screen.findByTestId('cultivation-lead')
    expect(region.tagName).toBe('A')
    expect(region.getAttribute('href')).toBe('/sow')
    expect(region.style.minHeight).toBe('44px')
    // BUG-LINKICONBLUE-001 — this row shipped in v4.58.0 with no ink of its own, so its sprout
    // inherited the browser's default link blue through Icon's `stroke="currentColor"`. jsdom
    // applies no UA stylesheet and would have reported that as black, so the check is on the inline
    // style — the property whose absence was the bug — not on a computed colour.
    expect(region.style.color, 'a Link wrapping an Icon must set its own color').not.toBe('')
  })

  it('keeps the /sow door when the engine yields no content (empty candidates)', async () => {
    fetchMock.mockResolvedValue({ items: [] })
    renderLead({ todayISO: TODAY })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/inventory-items/sow-candidates'))
    const region = screen.getByTestId('cultivation-lead')
    expect(region.getAttribute('href')).toBe('/sow')
    // Names its destination when it is the only thing in the row — self-explanatory on a cold open.
    expect(region.textContent).toBe('Sow now')
  })

  it('invents no line when every window is open-but-not-closing', async () => {
    fetchMock.mockResolvedValue({ items: [lettuce({ days_to_maturity_max: 30 })] })
    renderLead({ todayISO: TODAY })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.getByTestId('cultivation-lead').textContent).toBe('Sow now')
  })

  it('swallows a fetch error — degrades to the bare door, never throws onto Today', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    renderLead({ todayISO: TODAY })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const region = screen.getByTestId('cultivation-lead')
    expect(region.getAttribute('href')).toBe('/sow')
    expect(region.textContent).toBe('Sow now')
    expect(region.textContent).not.toMatch(/boom|error|failed/i)
  })

  it('shows no urgency line before the first load resolves', () => {
    fetchMock.mockResolvedValue({ items: [lettuce()] })
    renderLead({ todayISO: TODAY })
    expect(screen.getByTestId('cultivation-lead').textContent).toBe('Sow now')
  })

  // V4-SEEDZEROVIEW-001 — the rendered half of the pure assertions above. Today must degrade to the
  // bare door, not to an imperative to sow a packet Dave has none of.
  it('degrades to the bare door when the only closing packet is empty', async () => {
    fetchMock.mockResolvedValue({ items: [lettuce({ quantity_on_hand: 0 })] })
    renderLead({ todayISO: TODAY })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/inventory-items/sow-candidates'))
    const region = screen.getByTestId('cultivation-lead')
    expect(region.textContent).toBe('Sow now')
    expect(region.textContent).not.toMatch(/Winter Density/)
    expect(region.getAttribute('href')).toBe('/sow')
  })

  // ── The seed-diversion buckets, from Today's side ──────────────────────────────────────────────
  //
  // WHY THESE EXIST, and it is a coverage gap rather than a bug report. The pre-promote blast-radius
  // pass on v4.94.0 (_lane_reports/prepromote-impact-20260902.md, IMPORTANT #2 and #3) found that
  // bucketize had gained an 11th bucket, `in_process`, which diverts candidates AHEAD of the
  // depletion divert — and that this component was the ONE bucketize consumer the change did not
  // touch. It reads `buckets.window_closing` alone, so anything newly diverted silently stops
  // appearing on Today. `grep -c "seed_stage|in_process|fermenting|drying"` over this file returned
  // 0: the engine's divert was well covered in isolation, and the one existing consumer that was not
  // rewritten had no test for it at all. That is the green-tests-broken-prod shape exactly.
  //
  // The behaviour is INTENDED — an unfinished lot should not put an imperative on Today — so these
  // pin it rather than reporting it. Both diversions are covered, because they arrive by different
  // routes: seed_stage for a lot being processed, provenance-plus-zero for one never started.

  it('a lot still drying does not put an imperative on Today', async () => {
    fetchMock.mockResolvedValue({ items: [lettuce({ seed_stage: 'drying' })] })
    renderLead({ todayISO: TODAY })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/inventory-items/sow-candidates'))
    const region = screen.getByTestId('cultivation-lead')
    expect(region.textContent).toBe('Sow now')
    expect(region.textContent, 'Today told Dave to sow seed that is still on a screen in the shed')
      .not.toMatch(/Winter Density/)
  })

  it('BUG-SEEDZEROSOWABLE-001 — nor does a lot saved today and not yet started', async () => {
    fetchMock.mockResolvedValue({
      items: [lettuce({ quantity_on_hand: 0, seed_stage: null, source_plant_id: 'pl-1' })],
    })
    renderLead({ todayISO: TODAY })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/inventory-items/sow-candidates'))
    expect(screen.getByTestId('cultivation-lead').textContent).toBe('Sow now')
  })

  it('but a STORED lot with seed in it is back on Today — the divert is not a one-way door', async () => {
    // The forward half, and the reason the two above are not simply "seed lots never appear". A lot
    // that finished the process and has a count is ordinary sowable seed again.
    fetchMock.mockResolvedValue({
      items: [lettuce({ seed_stage: 'stored', quantity_on_hand: 20, source_plant_id: 'pl-1' })],
    })
    renderLead({ todayISO: TODAY })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/inventory-items/sow-candidates'))
    expect(screen.getByTestId('cultivation-lead').textContent).toMatch(/Sow Winter Density by Aug 18/)
  })
})
