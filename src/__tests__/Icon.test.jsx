// V4-ICON-001 (Pass B V101) — Icon component render contract (RTL, no jest-dom per repo harness).
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import Icon from '../components/Icon.jsx'

afterEach(() => cleanup())
const svgOf = (c) => c.querySelector('svg')

describe('Icon', () => {
  it('titled icon is role=img with an aria-label', () => {
    const { container } = render(<Icon name="nav.today" title="Today" />)
    const s = svgOf(container)
    expect(s.getAttribute('role')).toBe('img')
    expect(s.getAttribute('aria-label')).toBe('Today')
    expect(s.innerHTML.length).toBeGreaterThan(0)
  })
  it('decorative icon is aria-hidden with no role', () => {
    const { container } = render(<Icon name="care.pause" decorative />)
    const s = svgOf(container)
    expect(s.getAttribute('aria-hidden')).toBe('true')
    expect(s.getAttribute('role')).toBeNull()
  })
  it('falls back to the registry accessibleName when no title', () => {
    const { container } = render(<Icon name="facet.location" />)
    expect(svgOf(container).getAttribute('aria-label')).toBe('Location')
  })
  it('unknown name renders the neutral glyph without throwing', () => {
    expect(() => render(<Icon name="zzz.nope" decorative />)).not.toThrow()
  })
  it('size selects the master at the §2 crossover (24 vs 18 differ)', () => {
    const big = render(<Icon name="nav.garden" decorative size={24} />).container.querySelector('svg').innerHTML
    cleanup()
    const small = render(<Icon name="nav.garden" decorative size={18} />).container.querySelector('svg').innerHTML
    expect(big).not.toBe(small) // garden has a dedicated 18px master
  })
  it('mono glyph strokes via currentColor (consumer recolors)', () => {
    const { container } = render(<Icon name="facet.type" decorative />)
    expect(svgOf(container).getAttribute('stroke')).toBe('currentColor')
  })
  it('color-candidate filled variant renders authored multi-region fills', () => {
    const { container } = render(<Icon name="care.drop" variant="filled" decorative />)
    expect(svgOf(container).innerHTML).toMatch(/data-region="body"/)
  })
})
