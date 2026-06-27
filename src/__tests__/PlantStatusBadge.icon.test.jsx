import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import PlantStatusBadge from '../components/PlantStatusBadge.jsx'

afterEach(() => cleanup())

describe('PlantStatusBadge — V4-ICON-001 SVG glyph', () => {
  it('renders an SVG icon (not emoji text) + keeps the Status aria-label + label text', () => {
    const { container } = render(<PlantStatusBadge status="fruiting" />)
    const badge = container.querySelector('[aria-label="Status: Fruiting"]')
    expect(badge).toBeTruthy()
    expect(badge.querySelector('svg')).toBeTruthy()           // glyph is now an SVG
    expect(badge.textContent).toContain('Fruiting')           // label channel intact
  })
  it('unknown status renders the neutral glyph without throwing', () => {
    expect(() => render(<PlantStatusBadge status="zzz-unknown" />)).not.toThrow()
  })
  it('null status renders nothing', () => {
    const { container } = render(<PlantStatusBadge status={null} />)
    expect(container.firstChild).toBeNull()
  })
})
