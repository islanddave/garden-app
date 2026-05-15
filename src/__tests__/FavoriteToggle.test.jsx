/**
 * src/__tests__/FavoriteToggle.test.jsx
 * V1.2a-3 Increment A — FavoriteToggle component tests.
 *
 * FavoriteToggle had zero coverage. It is now placed INSIDE the project card's
 * <Link> (I3-affordance fix), so the load-bearing behavior is that its onClick
 * suppresses propagation to the host element — otherwise tapping the star would
 * navigate into the project. These tests lock that, plus the GET/POST/DELETE
 * favorites contract.
 *
 * Mocks:
 *   - useAuth         -> a signed-in user
 *   - useApiFetch     -> fetchSpy
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

const { fetchSpy, userRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  userRef: { current: { id: 'user-1' } },
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: userRef.current }),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import FavoriteToggle from '../components/FavoriteToggle.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  userRef.current = { id: 'user-1' }
})

describe('FavoriteToggle', () => {
  it('renders the empty star and checks favorite status on mount', async () => {
    fetchSpy.mockResolvedValueOnce({ favorited: false })
    render(<FavoriteToggle entityType="project" entityId="proj-1" />)
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('☆'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/favorites?entity_type=project&entity_id=proj-1')
  })

  it('renders the filled star when the entity is already favorited', async () => {
    fetchSpy.mockResolvedValueOnce({ favorited: true, id: 'fav-1' })
    render(<FavoriteToggle entityType="plant" entityId="plant-1" />)
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('★'))
  })

  it('renders nothing when there is no signed-in user', () => {
    userRef.current = null
    const { container } = render(<FavoriteToggle entityType="project" entityId="proj-1" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('POSTs a favorite on click and does NOT propagate to a host click handler', async () => {
    fetchSpy.mockResolvedValueOnce({ favorited: false }) // mount check
    const hostClick = vi.fn()
    render(
      <div onClick={hostClick}>
        <FavoriteToggle entityType="project" entityId="proj-9" />
      </div>
    )
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('☆'))

    fetchSpy.mockResolvedValueOnce({ favorited: true, id: 'fav-9' }) // POST response
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })

    // The star flipped, a POST went out, and the host onClick never fired
    // (stopPropagation) — this is what keeps the in-<Link> placement safe.
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('★'))
    const postCall = fetchSpy.mock.calls.find(
      c => c[0] === '/api/favorites' && c[1]?.method === 'POST'
    )
    expect(postCall).toBeDefined()
    expect(JSON.parse(postCall[1].body)).toEqual({ entity_type: 'project', entity_id: 'proj-9' })
    expect(hostClick).not.toHaveBeenCalled()
  })

  it('DELETEs the favorite when toggled off', async () => {
    fetchSpy.mockResolvedValueOnce({ favorited: true, id: 'fav-1' }) // mount check
    render(<FavoriteToggle entityType="project" entityId="proj-2" />)
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('★'))

    fetchSpy.mockResolvedValueOnce({ favorited: false }) // DELETE response
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })

    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('☆'))
    const delCall = fetchSpy.mock.calls.find(
      c => c[0] === '/api/favorites?entity_type=project&entity_id=proj-2' && c[1]?.method === 'DELETE'
    )
    expect(delCall).toBeDefined()
  })
})
