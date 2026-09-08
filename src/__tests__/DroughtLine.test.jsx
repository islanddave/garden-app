// V5-DROUGHTSPACE-001 — the garden-wide drought line, rendered.
//
// ⚠ THIS SUITE CANNOT PROVE THE WIRING, AND SAYS SO RATHER THAN IMPLYING OTHERWISE.
// FrostAlertLine.test.jsx's sibling block mounts Today.jsx with a plan-shaped payload precisely because
// the likeliest failure of a line like this is being mounted on the wrong prop path and rendering
// nothing forever while every test stays green. Today.jsx was outside this lane's write scope, so
// DroughtLine is NOT MOUNTED anywhere and there is no Today render to assert against. What follows
// covers the component in isolation only. The mount, and a Today-level test alongside it, are the
// remaining work — see the header of DroughtLine.jsx.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DroughtLine from '../components/today/DroughtLine.jsx'
import { P } from '../lib/constants.js'

// jsdom normalises inline hex colours to rgb(), so the palette guard below has to compare in rgb.
// Derived from P rather than hardcoded: a palette retune must move this assertion with it, not break it.
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

const NOTE = 'The garden has not had a deep soak in 28 days — no day at or above 0.60 in of rain, and '
  + 'no garden-wide deep watering. Check soil moisture at root depth.'
const PLAN = { drought: { note: NOTE, dry_days: 28, deep_soak_in: 0.6, last_deep_soak: '2026-08-03', last_deep_water: null, truncated: false } }

describe('DroughtLine', () => {
  it('renders the garden-wide sentence ONCE for the whole Space', () => {
    render(<DroughtLine plan={PLAN} />)
    const el = screen.getByTestId('drought-line')
    expect(el.textContent).toBe(NOTE)
    expect(screen.getAllByTestId('drought-line')).toHaveLength(1)
    expect(el.getAttribute('data-drought-days')).toBe('28')
    expect(el.getAttribute('data-drought-truncated')).toBe('false')
  })

  it('takes the WHOLE plan, not plan.drought — the prop path a Today mount would use', () => {
    // Handing it the inner object must render nothing. Without this, a mount written as
    // <DroughtLine plan={plan.drought} /> would be silently broken and every other test would pass.
    const { container } = render(<DroughtLine plan={PLAN.drought} />)
    expect(container.firstChild).toBe(null)
  })

  it('renders NOTHING on a quiet day — never a blank strip, never a heading over silence', () => {
    expect(render(<DroughtLine plan={{ weather: {}, counts: {} }} />).container.firstChild).toBe(null)
    expect(render(<DroughtLine plan={null} />).container.firstChild).toBe(null)
    expect(render(<DroughtLine />).container.firstChild).toBe(null)
  })

  it('never renders the "no rain in N days" wording, even if the payload carries it', () => {
    const slipped = { drought: { note: 'No rain in 28 days.', dry_days: 28 } }
    expect(render(<DroughtLine plan={slipped} />).container.firstChild).toBe(null)
  })

  it('stays out of the crowded warn family: no gold, no fill, no boxed border', () => {
    // WeatherCueLine.test.jsx guards its sibling against the warn palette BY NAME for the stated reason
    // that a third warn item turns the other two into wallpaper. Same argument, same guard.
    render(<DroughtLine plan={PLAN} />)
    const style = screen.getByTestId('drought-line').getAttribute('style')
    expect(style).toContain(`border-left: 3px solid ${rgb(P.sage)}`)
    for (const off of [P.warnBorder, P.gold, P.terra]) expect(style).not.toContain(rgb(off))
    expect(style).not.toMatch(/background/i)
  })

  it('is an in-page line and nothing more — no interrupt surface on Dave\'s PWA', () => {
    const { container } = render(<DroughtLine plan={PLAN} />)
    expect(container.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], button')).toHaveLength(0)
  })
})
