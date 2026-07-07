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

  it('V4-FLAG-001: renders flagged severity variants 1/2/3 with distinct labels + data-variant', () => {
    const labels = { 1: 'Keeping an eye on it', 2: 'Needs attention', 3: 'Urgent' }
    for (const severity of [1, 2, 3]) {
      const { getByTestId, unmount } = render(<SeverityBadge severity={severity} reason="flagged" />)
      const b = getByTestId('severity-badge')
      expect(b.getAttribute('data-variant')).toBe(`flagged-${severity}`)
      expect(b.textContent).toContain(labels[severity])
      expect(b.querySelector('svg')).toBeTruthy() // V4-ICON-001: glyph, not emoji
      unmount()
    }
  })

  it('renders nothing for reason="flagged" with a null/out-of-range severity', () => {
    for (const severity of [null, 0, 4]) {
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
