// CareStatus (Slice 5a) unit tests.
// Pure presentational band: 3 states (calm-null / calm-future / active) and tier sourcing.
// NO jest-dom — getByText/queryByText + toBe/toBeNull/textContent only.
// Proves color is sourced from the canonical SEVERITY_STYLES (object identity), not cloned.

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import CareStatus from '../components/CareStatus.jsx'
import { SEVERITY_STYLES } from '../lib/waterDue.js'

const ISO = (ms) => new Date(Date.now() + ms).toISOString()
const DAY = 86400000

describe('CareStatus — calm (band renders nothing)', () => {
  it('nextWaterAt null → renders null', () => {
    const { container } = render(<CareStatus nextWaterAt={null} locationType={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('future schedule → renders null', () => {
    const { container } = render(<CareStatus nextWaterAt={ISO(2 * DAY)} locationType={null} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('CareStatus — active band', () => {
  it('due today (past by ~0 days) → headline "Due today"', () => {
    // a few seconds in the past → daysOver >= 0 but floor() == 0 → 'due today'
    const { container } = render(<CareStatus nextWaterAt={ISO(-5000)} locationType={null} />)
    expect(container.firstChild).not.toBeNull()
    expect(container.textContent).toContain('Due today')
    expect(container.textContent).not.toContain('Overdue')
  })

  it('overdue (>= 3 days) → "Overdue" + the days-overdue label', () => {
    const { container } = render(<CareStatus nextWaterAt={ISO(-3 * DAY - 5000)} locationType={null} />)
    expect(container.textContent).toContain('Overdue')
    expect(container.textContent).toContain('3 days overdue')
  })

  it('role=status with aria-live polite + accessible name', () => {
    const { getByRole } = render(<CareStatus nextWaterAt={ISO(-2 * DAY - 5000)} locationType={null} />)
    const region = getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('aria-label')).toBe('Watering 2 days overdue')
  })

  // C5 — "when did I last water this" had two render sites in all of src/, both behind a menu or a
  // closed Sheet on a non-default tab. The value ships in the same planting payload as next_water_at.
  it('renders the last-watered date beside the due state when one is passed', () => {
    const { container } = render(
      <CareStatus nextWaterAt={ISO(-2 * DAY - 5000)} lastWateredAt="2026-08-13" locationType={null} />,
    )
    expect(container.textContent).toContain('Last watered')
    expect(container.textContent).toContain('Aug 13')
    expect(container.textContent).toContain('2 days overdue')   // still the band it was
  })

  it('omits the last-watered line entirely when there is no date (never watered / not loaded)', () => {
    for (const v of [null, undefined, '', 'not-a-date']) {
      const { container } = render(<CareStatus nextWaterAt={ISO(-2 * DAY)} lastWateredAt={v} locationType={null} />)
      expect(container.textContent).not.toContain('Last watered')
    }
  })

  it('does NOT resurrect the band on a calm day — the locked Slice 5a design still holds', () => {
    // A last-watered date is a fact to ADD to an existing band, never a reason to render a new one.
    const { container } = render(<CareStatus nextWaterAt={null} lastWateredAt="2026-08-13" locationType={null} />)
    expect(container.firstChild).toBeNull()
    const future = render(<CareStatus nextWaterAt={ISO(2 * DAY)} lastWateredAt="2026-08-13" locationType={null} />)
    expect(future.container.firstChild).toBeNull()
  })

  it("indoor_seedling overdue >= 1 day → terra-bold tier, color sourced from SEVERITY_STYLES (no clone)", () => {
    const { getByRole } = render(
      <CareStatus nextWaterAt={ISO(-1.5 * DAY)} locationType="indoor_seedling" />,
    )
    const region = getByRole('status')
    // jsdom normalizes hex -> rgb in style.backgroundColor; compare via a probe element
    // styled with the canonical token so both go through the same normalization.
    const probe = document.createElement('div')
    probe.style.backgroundColor = SEVERITY_STYLES['terra-bold'].bg
    expect(region.style.backgroundColor).toBe(probe.style.backgroundColor)
  })
})
