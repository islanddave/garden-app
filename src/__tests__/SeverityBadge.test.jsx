// Unit tests for src/components/SeverityBadge.jsx — render variants per V002.1 §B.

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SeverityBadge from '../components/SeverityBadge.jsx'

describe('SeverityBadge — render variants', () => {
  it('renders flagged severity=3 as Urgent', () => {
    render(<SeverityBadge severity={3} reason="flagged" />)
    const badge = screen.getByTestId('severity-badge')
    expect(badge.textContent).toContain('Urgent')
    expect(badge.getAttribute('data-variant')).toBe('flagged3')
    expect(badge.getAttribute('title')).toContain('Urgent')
  })

  it('renders flagged severity=2 as Issue', () => {
    render(<SeverityBadge severity={2} reason="flagged" />)
    const badge = screen.getByTestId('severity-badge')
    expect(badge.textContent).toContain('Issue')
    expect(badge.getAttribute('data-variant')).toBe('flagged2')
    expect(badge.getAttribute('title')).toContain('48h')
  })

  it('renders flagged severity=1 as Watch', () => {
    render(<SeverityBadge severity={1} reason="flagged" />)
    const badge = screen.getByTestId('severity-badge')
    expect(badge.textContent).toContain('Watch')
    expect(badge.getAttribute('data-variant')).toBe('flagged1')
    expect(badge.getAttribute('title')).toContain('monitor only')
  })

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

  it('renders nothing for flagged with no severity', () => {
    const { container } = render(<SeverityBadge severity={null} reason="flagged" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an inline SVG icon', () => {
    render(<SeverityBadge severity={3} reason="flagged" />)
    expect(screen.getByTestId('severity-badge').querySelector('svg')).toBeTruthy()
  })
})
