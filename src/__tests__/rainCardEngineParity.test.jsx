// BUG-RAINFCSTONEMODEL-001 — the Today card's rain line and the engine's rain callout, rendered one under the
// other, must print the SAME amount and the SAME chance for tomorrow. Before this change there were two
// independent `amount x PoP / 100` computations (engine.js computeCallout, WeatherWidget) and no test that
// the two agreed. This sweeps the stored-plan path across the amount and chance values that straddle both
// gates and asserts, numerically, that whenever the callout speaks it matches the card.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import engine from '../../lambda/daily-plan/engine.js'
import WeatherWidget from '../components/today/WeatherWidget.jsx'

const { computeCallout } = engine
const WX = { tonightLow: 60, highToday: 75, code: 3, hot: false }   // no freeze/cold/heat: the rain branch can win

describe('card and callout print one tomorrow', () => {
  it('agree on amount and chance across the gate edges', () => {
    let spoke = 0
    for (const amt of [0.14, 0.3, 0.49, 0.5, 0.58, 1.72]) {
      for (const pop of [null, 29, 30, 37, 50, 60, 64, 100]) {
        const h = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: amt, tomorrow_pop: pop, upcoming_precip_in: amt }
        const c = computeCallout(WX, h)
        const { container } = render(<WeatherWidget weather={WX} hydrology={h} generatedAt="2026-09-25T20:00:00Z" planDate="2026-09-25" />)
        const card = container.textContent
        cleanup()
        if (!c || c.icon !== 'rain') continue
        spoke++
        const m = c.text.match(/^(\d+\.\d{2})" rain tomorrow(?: \((\d+)% chance\))? — /)
        expect(m, c.text).toBeTruthy()
        expect(Number(m[1])).toBe(amt)
        expect(card).toContain(`${amt.toFixed(2)}″ tomorrow`)
        if (pop != null) {
          expect(Number(m[2])).toBe(pop)
          expect(card).toContain(`${amt.toFixed(2)}″ tomorrow · ${pop}% chance`)
        }
      }
    }
    expect(spoke).toBeGreaterThan(10)   // anti-vacuity: the callout fired on enough cells to mean something
  })
})
