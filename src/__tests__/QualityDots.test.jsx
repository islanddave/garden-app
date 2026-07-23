import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import QualityDots from '../components/QualityDots.jsx'

describe('QualityDots', () => {
  it('renders a labelled group for a valid rating', () => {
    const { getByRole } = render(<QualityDots value={3} />)
    expect(getByRole('img').getAttribute('aria-label')).toBe('Quality 3 of 5')
  })
  it('renders nothing for null (a missing rating is not zero quality)', () => {
    expect(render(<QualityDots value={null} />).container.firstChild).toBeNull()
  })
  it('renders nothing for out-of-range or non-integer values', () => {
    expect(render(<QualityDots value={6} />).container.firstChild).toBeNull()
    expect(render(<QualityDots value={2.5} />).container.firstChild).toBeNull()
    expect(render(<QualityDots value={0} />).container.firstChild).toBeNull()
  })
})
