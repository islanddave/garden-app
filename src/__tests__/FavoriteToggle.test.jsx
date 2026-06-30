/**
 * src/__tests__/FavoriteToggle.test.jsx
 * V3-PERF-FAV-001 — FavoriteToggle reads favorite state from FavoritesContext
 * (one bulk fetch app-wide) instead of a per-mount GET. Unit contract: no
 * per-toggle fetch on mount (the N+1 fix), star reflects the context value, and
 * a click calls setFavorite optimistically + POST/DELETEs + stops propagation so
 * a star inside a card Link does not navigate the host. (The visual flip is driven
 * by the real context re-rendering and is covered at the integration level.)
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { fetchSpy, userRef, favState, setFavSpy } = vi.hoisted(() => {
  const favState = { set: new Set() }
  return {
    favState,
    fetchSpy: vi.fn(),
    userRef: { current: { id: 'user-1' } },
    setFavSpy: vi.fn((t, id, v) => { const k = `${t}:${id}`; if (v) favState.set.add(k); else favState.set.delete(k) }),
  }
})

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: userRef.current }),
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))
vi.mock('../context/FavoritesContext.jsx', () => ({
  useFavorites: () => ({
    isFavorite: (t, id) => favState.set.has(`${t}:${id}`),
    setFavorite: setFavSpy,
    favoritesLoaded: true,
  }),
}))

import FavoriteToggle from '../components/FavoriteToggle.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  setFavSpy.mockClear()
  userRef.current = { id: 'user-1' }
  favState.set = new Set()
})

describe('FavoriteToggle', () => {
  it('renders empty heart and does NOT fetch on mount (N+1 fix)', () => {
    render(<FavoriteToggle entityType="project" entityId="proj-1" />)
    expect(screen.getByRole('button').textContent).toBe('♡')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('renders the filled heart when already favorited (from context)', () => {
    favState.set = new Set(['plant:plant-1'])
    render(<FavoriteToggle entityType="plant" entityId="plant-1" />)
    expect(screen.getByRole('button').textContent).toBe('♥')
  })

  it('renders nothing when there is no signed-in user', () => {
    userRef.current = null
    const { container } = render(<FavoriteToggle entityType="project" entityId="proj-1" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('POSTs + optimistically favorites on click, and does NOT propagate to a host click handler', async () => {
    const hostClick = vi.fn()
    fetchSpy.mockResolvedValueOnce({ favorited: true })
    render(
      <div onClick={hostClick}>
        <FavoriteToggle entityType="project" entityId="proj-9" />
      </div>
    )
    expect(screen.getByRole('button').textContent).toBe('♡')
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(setFavSpy).toHaveBeenCalledWith('project', 'proj-9', true)
    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/favorites' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(JSON.parse(postCall[1].body)).toEqual({ entity_type: 'project', entity_id: 'proj-9' })
    expect(hostClick).not.toHaveBeenCalled()
  })

  it('DELETEs + optimistically unfavorites when toggled off', async () => {
    favState.set = new Set(['project:proj-2'])
    fetchSpy.mockResolvedValueOnce({})
    render(<FavoriteToggle entityType="project" entityId="proj-2" />)
    expect(screen.getByRole('button').textContent).toBe('♥')
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(setFavSpy).toHaveBeenCalledWith('project', 'proj-2', false)
    const delCall = fetchSpy.mock.calls.find(c => c[0] === '/api/favorites?entity_type=project&entity_id=proj-2' && c[1]?.method === 'DELETE')
    expect(delCall).toBeDefined()
  })
})
