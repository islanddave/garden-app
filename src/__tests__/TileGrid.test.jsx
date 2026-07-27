// V4-THEME-001 — TileGrid layout primitive guard (dark). No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
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

  // BUG-PHOTOTHUMB-001 — opt-in windowing. Native lazy never fires in this app and an unbounded
  // eager photo grid freezes the renderer, so photo-bearing grids bound their own tile count.
  describe('windowSize (BUG-PHOTOTHUMB-001)', () => {
    const MANY = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, n: 'Plant ' + i }))

    // jsdom reports scrollHeight 0, which makes the hook's "near the bottom?" check true forever,
    // so the mount-time onScroll() would grow the window immediately and mask the cap. Pretend the
    // document is taller than the viewport — the real condition on a long grid.
    beforeEach(() => {
      Object.defineProperty(document.documentElement, 'scrollHeight', { value: 99999, configurable: true })
    })

    it('omitted -> every tile renders and there is no Show more (unchanged behavior)', () => {
      render(<TileGrid items={MANY} renderItem={(it) => <span>{it.n}</span>} />)
      expect(screen.getAllByRole('listitem').length).toBe(30)
      expect(screen.queryByRole('button', { name: /Show more/ })).toBe(null)
    })

    it('set -> caps the rendered tiles and offers Show more with the remaining count', () => {
      render(<TileGrid items={MANY} windowSize={10} renderItem={(it) => <span>{it.n}</span>} />)
      expect(screen.getAllByRole('listitem').length).toBe(10)
      expect(screen.getByRole('button', { name: /Show more \(20 left\)/ })).toBeDefined()
    })

    it('Show more grows the window by one page', async () => {
      render(<TileGrid items={MANY} windowSize={10} renderItem={(it) => <span>{it.n}</span>} />)
      await act(async () => {
        screen.getByRole('button', { name: /Show more/ }).dispatchEvent(
          new MouseEvent('click', { bubbles: true }))
      })
      expect(screen.getAllByRole('listitem').length).toBe(20)
      expect(screen.getByRole('button', { name: /Show more \(10 left\)/ })).toBeDefined()
    })

    it('windowSize >= item count -> no Show more', () => {
      render(<TileGrid items={ITEMS} windowSize={24} renderItem={(it) => <span>{it.n}</span>} />)
      expect(screen.getAllByRole('listitem').length).toBe(3)
      expect(screen.queryByRole('button', { name: /Show more/ })).toBe(null)
    })
  })
})
