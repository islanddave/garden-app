// Audit I36 (Dave 2026-10-15, "Household only") — GET /api/projects/types stopped returning
// created_by, a household member's Clerk sub, and says is_system / is_own instead. The page reads
// those, and falls back to created_by only for an older Lambda's response (the minutes between the
// Lambda deploy and the SPA deploy).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const apiFetchSpy = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }))

const { default: ProjectTypes, typeFlags } = await import('../pages/ProjectTypes.jsx')

describe('typeFlags — the new contract', () => {
  it('reads is_own / is_system and ignores a stray created_by', () => {
    expect(typeFlags({ is_own: true, is_system: false }, 'user-1')).toEqual({ isOwn: true, isSystem: false })
    expect(typeFlags({ is_own: false, is_system: true }, 'user-1')).toEqual({ isOwn: false, isSystem: true })
    // A household mate's type: neither own nor system, so no Delete and no badge.
    expect(typeFlags({ is_own: false, is_system: false }, 'user-1')).toEqual({ isOwn: false, isSystem: false })
    expect(typeFlags({ is_own: false, is_system: false, created_by: 'user-1' }, 'user-1'))
      .toEqual({ isOwn: false, isSystem: false })
  })

  it('falls back to created_by for an older Lambda that sends no flags', () => {
    expect(typeFlags({ created_by: 'user-1' }, 'user-1')).toEqual({ isOwn: true, isSystem: false })
    expect(typeFlags({ created_by: 'user-2' }, 'user-1')).toEqual({ isOwn: false, isSystem: false })
    expect(typeFlags({ created_by: null }, 'user-1')).toEqual({ isOwn: false, isSystem: true })
  })
})

describe('ProjectTypes page — rendering from the flags alone', () => {
  beforeEach(() => apiFetchSpy.mockReset())

  it('an own type shows Delete, a built-in shows the system badge, a mate\'s shows neither', async () => {
    apiFetchSpy.mockResolvedValue([
      { id: 'a', name: 'Mine', category: 'garden', icon: '🌱', is_own: true, is_system: false },
      { id: 'b', name: 'Built in', category: 'garden', icon: '🌿', is_own: false, is_system: true },
      { id: 'c', name: 'Mates', category: 'garden', icon: '🪴', is_own: false, is_system: false },
    ])
    render(<MemoryRouter><ProjectTypes /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Mine')).toBeTruthy())
    expect(screen.getAllByText('Delete')).toHaveLength(1)
    expect(screen.getAllByText('system')).toHaveLength(1)
  })
})
