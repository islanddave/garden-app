// V4-THEME-001 — TileGrid layout primitive guard (dark). No jest-dom (L-182).
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TileGrid from '../components/forms/TileGrid.jsx'

const ITEMS = [{ id: 'a', n: 'Basil' }, { id: 'b', n: 'Sage' }, { id: 'c', n: 'Thyme' }]

describe('TileGrid (V4-THEME-001)', () => {
  it('renders a list with one listitem per item via renderItem', () => {
    render(<TileGrid items={ITEMS} ariaLabel="Plants" renderItem={(it) => <span>{it.n}</span>} />)
    const list = screen.getByRole('list')
    expect(list.getAttribute('aria-label')).toBe('Plants')
    expect(screen.getAllByRole('listitem').length).toBe(3)
    expect(screen.getByText('Basil')).toBeDefined()
  })

  it('fixed columns -> repeat(N, minmax(0,1fr))', () => {
    render(<TileGrid items={ITEMS} columns={2} renderItem={(it) => <span>{it.n}</span>} />)
    expect(screen.getByRole('list').style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
  })

  it('minTileWidth -> auto-fill minmax', () => {
    render(<TileGrid items={ITEMS} minTileWidth={140} renderItem={(it) => <span>{it.n}</span>} />)
    expect(screen.getByRole('list').style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(140px, 1fr))')
  })

  it('empty items + empty node -> renders the empty state, not a list (RES-2)', () => {
    render(<TileGrid items={[]} empty="No plants yet" renderItem={() => null} />)
    expect(screen.queryByRole('list')).toBe(null)
    expect(screen.getByText('No plants yet')).toBeDefined()
  })

  it('empty items + no empty node -> renders nothing', () => {
    const { container } = render(<TileGrid items={[]} renderItem={() => null} />)
    expect(container.firstChild).toBe(null)
  })
})
