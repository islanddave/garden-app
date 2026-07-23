import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import StatTile from '../components/StatTile.jsx'

describe('StatTile', () => {
  it('renders label + primary + secondary', () => {
    render(<StatTile label="Last harvest" primary="Sungold" secondary="today" />)
    expect(screen.getByText('Last harvest')).toBeTruthy()
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.getByText('today')).toBeTruthy()
  })
  it('renders a link when `to` is given', () => {
    render(<StatTile label="L" primary="P" to="/x" />)
    expect(screen.getByText('P').closest('a').getAttribute('href')).toBe('/x')
  })
  it('renders a button that fires onClick when `onClick` is given', () => {
    const onClick = vi.fn()
    render(<StatTile label="L" primary="P" onClick={onClick} />)
    fireEvent.click(screen.getByText('P').closest('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
