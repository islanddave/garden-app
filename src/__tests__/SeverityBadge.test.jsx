// Unit tests for src/components/SeverityBadge.jsx — stale-only since FLAG-REMOVAL (2026-06-10).

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SeverityBadge from '../components/SeverityBadge.jsx'

describe('SeverityBadge — render variants', () => {
  it('renders stale variant', () => {
    render(<SeverityBadge severity={null} reason="stale" />)
    const badge = screen.getByTestId('severity-badge')
    expect(badge.textContent).toContain('Stale')
    expect(badge.getAttribute('data-variant')).toBe('stale')
    expect(badge.getAttribute('title')).toContain('21+ days')
  })

  it('renders stale with daysStale suffix', () => {
    render(<SeverityBadge severity={null} reason="stale" daysStale={42} />)
    expect(screen.getByTestId('severity-badge').textContent).toContain('42d')
  })

  it('renders nothing when reason is unknown', () => {
    const { container } = render(<SeverityBadge severity={3} reason="unknown" />)
    expect(container.firstChild).toBeNull()
  })

  it('FLAG-REMOVAL regression: reason="flagged" renders nothing at any severity', () => {
    for (const severity of [1, 2, 3, null]) {
      const { container, unmount } = render(<SeverityBadge severity={severity} reason="flagged" />)
      expect(container.firstChild).toBeNull()
      unmount()
    }
  })

  it('renders an inline SVG icon', () => {
    render(<SeverityBadge reason="stale" />)
    expect(screen.getByTestId('severity-badge').querySelector('svg')).toBeTruthy()
  })
})
