// PANEL Q1 (harvest-panel-decisions-20260812.md) — the cultivation lead line: one or two
// imperative lines, NO heading, NO count, cap 2, renders NOTHING when empty. Content is a read of
// the sow engine's own window_closing output (latestSafeMs fall-sow close dates) — these tests run
// the REAL engine against fixture candidates on a fixed date, so a line here is a line the engine
// itself would print.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import CultivationLead, { cultivationLines, CULTIVATION_LEAD_CAP } from '../components/today/CultivationLead.jsx'

// 2026 anchors: FF (sowing-safety margin) = 09-28, FFobs (measured median first frost) = 10-29.
// Lettuce is fall-hardy (V4-HARDYSET-001), so a cool + annual DIRECT sow closes at FFobs - dtm:
// dtm 72 -> Aug 18 (6 days from the fixed TODAY, inside the 10-day closing window); dtm 75 -> Aug
// 15; dtm 77 -> Aug 13. The fall INDOOR pass is a different clamp on the OTHER anchor and did not
// move — FF + (28 - dtm - FALL_SLOWDOWN 14) — so the indoor fixture keeps dtm 55 for the same Aug 18.
//
// The dtm figures were raised by 14 to hold these dates when lettuce gained the hardy grace
// (V4-HARDYSET-001), then by a further 3 when BUG-FROSTANCHORWRONG-001 moved the hardy clamp off the
// safety margin onto the measured anchor. Every EXPECTED string below is unchanged across both,
// deliberately: the contract under test is the lead line's wording, cap and ordering, and none of
// that moved — only the shared clamp that decides which packets are closing. Retuning the input
// rather than the assertions keeps that visible.
const TODAY = '2026-08-12'
const lettuce = (over = {}) => ({
  variety_name: 'Winter Density', item_name: 'Lettuce packet', crop_type_slug: 'lettuce',
  lifecycle: 'annual', sow_season: 'cool', days_to_maturity_max: 72, days_to_maturity_min: null,
  direct_sow_timing: 'as soon as the soil can be worked', start_method: null,
  ...over,
})

beforeEach(() => { fetchMock.mockReset() })

describe('cultivationLines (pure, real engine)', () => {
  it('emits an imperative line with the engine-computed close date', () => {
    expect(cultivationLines([lettuce()], TODAY)).toEqual(['Sow Winter Density by Aug 18.'])
  })

  it('uses the indoor verb when the closing window is an indoor start', () => {
    const basil = lettuce({
      variety_name: 'Genovese Basil', direct_sow_timing: null, days_to_maturity_max: 55,
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
})

describe('CultivationLead component', () => {
  it('renders one or two imperative lines with NO heading and NO count', async () => {
    fetchMock.mockResolvedValue({ items: [lettuce()] })
    render(<CultivationLead todayISO={TODAY} />)
    const lead = await screen.findByTestId('cultivation-lead')
    expect(lead.textContent).toBe('Sow Winter Density by Aug 18.')
    expect(lead.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(lead.textContent).not.toMatch(/Showing \d+|\d+ of \d+|more/i)
    // No urgency grammar — a date is information, a countdown is pressure.
    expect(lead.textContent).not.toMatch(/days left|hurry|don'?t|!/i)
  })

  it('renders NOTHING when the engine yields no content (empty candidates)', async () => {
    fetchMock.mockResolvedValue({ items: [] })
    const { container } = render(<CultivationLead todayISO={TODAY} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/inventory-items/sow-candidates'))
    expect(container.firstChild).toBeNull()
  })

  it('renders NOTHING when every window is open-but-not-closing', async () => {
    fetchMock.mockResolvedValue({ items: [lettuce({ days_to_maturity_max: 30 })] })
    const { container } = render(<CultivationLead todayISO={TODAY} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('swallows a fetch error — renders nothing, never throws onto Today', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<CultivationLead todayISO={TODAY} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing before the first load resolves', () => {
    fetchMock.mockResolvedValue({ items: [lettuce()] })
    const { container } = render(<CultivationLead todayISO={TODAY} />)
    expect(container.firstChild).toBeNull()
  })
})
