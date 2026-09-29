// V5-TODAYREDESIGN-001 S3 — rainCardEngineParity's sweep, pointed at the redesigned Today's glance card (plan-v2
// §8 S3 "rainCardEngineParity gains glance-closed and glance-open cases"). The card's callout and the glance must
// print the SAME amount and chance for tomorrow, closed (row B, the card's own rain sentences) and open (the
// WeatherWidget it opens into, rendered once). A sibling file rather than an edit, so the forecast session's
// rainCardEngineParity.test.jsx stays byte-identical; the sweep and the anti-vacuity bar are its own.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// The glance mounts the weather cue, which beacons through apiFetch; the sweep has no signed-in user to give it.
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: async () => ({}) }) }))

import engine from '../../lambda/daily-plan/engine.js'
import GlanceCard from '../components/today/v2/GlanceCard.jsx'

const { computeCallout } = engine
const WX = { tonightLow: 60, highToday: 75, code: 3, hot: false }   // no freeze/cold/heat: the rain branch can win

describe('the glance card and the callout print one tomorrow', () => {
  it('closed and open agree with the callout on amount and chance across the gate edges', () => {
    let spoke = 0
    for (const amt of [0.14, 0.3, 0.49, 0.5, 0.58, 1.72]) {
      for (const pop of [null, 29, 30, 37, 50, 60, 64, 100]) {
        const h = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: amt, tomorrow_pop: pop, upcoming_precip_in: amt }
        const c = computeCallout(WX, h)
        const plan = { weather: WX, hydrology: h, water_due: [] }
        const closed = render(<GlanceCard plan={plan} generatedAt="2026-09-25T20:00:00Z" planDate="2026-09-25" open={false} onToggle={() => {}} />).container
        const closedText = closed.textContent
        expect(closed.querySelector('[data-testid="today-weather"]')).toBeNull()
        cleanup()
        const open = render(<GlanceCard plan={plan} generatedAt="2026-09-25T20:00:00Z" planDate="2026-09-25" open onToggle={() => {}} />).container
        const openText = open.textContent
        expect(open.querySelectorAll('[data-testid="today-weather"]')).toHaveLength(1)
        cleanup()
        if (!c || c.icon !== 'rain') continue
        spoke++
        const m = c.text.match(/^(\d+\.\d{2})" rain tomorrow(?: \((\d+)% chance\))? — /)
        expect(m, c.text).toBeTruthy()
        expect(Number(m[1])).toBe(amt)
        for (const card of [closedText, openText]) {
          expect(card).toContain(`${amt.toFixed(2)}″ tomorrow`)
          if (pop != null) {
            expect(Number(m[2])).toBe(pop)
            expect(card).toContain(`${amt.toFixed(2)}″ tomorrow · ${pop}% chance`)
          }
        }
      }
    }
    expect(spoke).toBeGreaterThan(10)   // anti-vacuity: the callout fired on enough cells to mean something
  })
})
