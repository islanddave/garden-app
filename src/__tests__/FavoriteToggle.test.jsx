/**
 * src/__tests__/FavoriteToggle.test.jsx
 * V3-PERF-FAV-001 — FavoriteToggle reads favorite state from FavoritesContext
 * (one bulk fetch app-wide) instead of a per-mount GET. Locks: no per-toggle
 * fetch on mount (the N+1 fix), state from context, click POST/DELETE + optimistic
 * flip, and onClick stopPropagation so a star inside a card Link does not navigate.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

const { fetchSpy, userRef, favState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  userRef: { current: { id: 'user-1' } },
  favState: { set: new Set() },
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: userRef.current }),
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))
vi.mock('../context/FavoritesContext.jsx', () => ({
  useFavorites: () => ({
    isFavorite: (t, id) => favState.set.has(`${t}:${id}`),
    setFavorite: (t, id, v) => { const k = `${t}:${id}`; if (v) favState.set.add(k); else favState.set.delete(k) },
    favoritesLoaded: true,
  }),
}))

import FavoriteToggle from '../components/FavoriteToggle.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  userRef.current = { id: 'user-1' }
  favState.set = new Set()
})

describe('FavoriteToggle', () => {
  it('renders empty star and does NOT fetch on mount (N+1 fix)', () => {
    render(<FavoriteToggle entityType="project" entityId="proj-1" />)
    expect(screen.getByRole('button').textContent).toBe('☆')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('renders the filled star when already favorited (from context)', () => {
    favState.set = new Set(['plant:plant-1'])
    render(<FavoriteToggle entityType="plant" entityId="plant-1" />)
    expect(screen.getByRole('button').textContent).toBe('★')
  })

  it('renders nothing when there is no signed-in user', () => {
    userRef.current = null
    const { container } = render(<FavoriteToggle entityType="project" entityId="proj-1" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('POSTs on click, flips optimistically, and does NOT propagate to a host click handler', async () => {
    const hostClick = vi.fn()
    fetchSpy.mockResolvedValueOnce({ favorited: true })
    render(
      <div onClick={hostClick}>
        <FavoriteToggle entityType="project" entityId="proj-9" />
      </div>
    )
    expect(screen.getByRole('button').textContent).toBe('☆')
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('★'))
    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/favorites' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(JSON.parse(postCall[1].body)).toEqual({ entity_type: 'project', entity_id: 'proj-9' })
    expect(hostClick).not.toHaveBeenCalled()
  })

  it('DELETEs the favorite when toggled off', async () => {
    favState.set = new Set(['project:proj-2'])
    fetchSpy.mockResolvedValueOnce({})
    render(<FavoriteToggle entityType="project" entityId="proj-2" />)
    expect(screen.getByRole('button').textContent).toBe('★')
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('☆'))
    const delCall = fetchSpy.mock.calls.find(c => c[0] === '/api/favorites?entity_type=project&entity_id=proj-2' && c[1]?.method === 'DELETE')
    expect(delCall).toBeDefined()
  })
})
