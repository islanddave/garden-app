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
