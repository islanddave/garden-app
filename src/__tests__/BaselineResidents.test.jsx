import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import BaselineResidents from '../components/BaselineResidents.jsx'

describe('BaselineResidents', () => {
  it('renders the container with aria-hidden=true', () => {
    render(<BaselineResidents />)
    const el = screen.getByTestId('baseline-residents')
    expect(el.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders 2 sprite images (robin + honeybee)', () => {
    render(<BaselineResidents />)
    const imgs = screen.getByTestId('baseline-residents').querySelectorAll('img')
    expect(imgs.length).toBe(2)
  })

  it('sprite filenames are the baseline species files', () => {
    render(<BaselineResidents />)
    const imgs = screen.getByTestId('baseline-residents').querySelectorAll('img')
    const srcs = Array.from(imgs).map(i => i.getAttribute('src'))
    expect(srcs).toContain('/critters/C013-american-robin.svg')
    expect(srcs).toContain('/critters/C001-honeybee.svg')
  })

  it('pointerEvents:none on container (purely decorative)', () => {
    render(<BaselineResidents />)
    const el = screen.getByTestId('baseline-residents')
    expect(el.style.pointerEvents).toBe('none')
  })

  it('data-baseline-species-id attribute carries the species_id (1 + 2)', () => {
    render(<BaselineResidents />)
    const imgs = screen.getByTestId('baseline-residents').querySelectorAll('img')
    const ids = Array.from(imgs).map(i => i.getAttribute('data-baseline-species-id'))
    expect(ids).toContain('1')
    expect(ids).toContain('2')
  })
})
