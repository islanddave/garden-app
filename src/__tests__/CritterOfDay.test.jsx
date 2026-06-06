import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import roster from '../data/critters-roster.json'
import { pickCritterOfDay, todayUTCDate } from '../lib/critterOfDay.js'

// Stable getToken across renders (mirrors useCritterCollection.test.jsx).
const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn().mockResolvedValue('test-token') }))
vi.mock('@clerk/react', () => ({ useAuth: () => ({ getToken: getTokenMock }) }))

vi.mock('../lib/sharedStateClient.js', () => ({
  getFeaturedOfDay: vi.fn(),
  putFeaturedOfDay: vi.fn().mockResolvedValue(null),
}))

import { getFeaturedOfDay, putFeaturedOfDay } from '../lib/sharedStateClient.js'
import CritterOfDay from '../components/CritterOfDay.jsx'

const todayPick = pickCritterOfDay(roster, todayUTCDate())

describe('CritterOfDay — ambient spotlight (V3-DELIGHT D1)', () => {
  beforeEach(() => { vi.clearAllMocks(); putFeaturedOfDay.mockResolvedValue(null) })

  it('falls back to the deterministic local pick and PINS it when the day is unset', async () => {
    getFeaturedOfDay.mockResolvedValueOnce({ date: todayUTCDate(), featured: null, updated_at: null })
    render(<CritterOfDay collected={new Map()} />)
    expect(await screen.findByText(todayPick.name)).toBeTruthy()
    await waitFor(() => expect(putFeaturedOfDay).toHaveBeenCalledTimes(1))
    expect(putFeaturedOfDay.mock.calls[0][0].payload).toEqual({ id: todayPick.id })
  })

  it('renders the STORED featured critter and does NOT clobber it', async () => {
    const stored = roster[0]
    getFeaturedOfDay.mockResolvedValueOnce({ date: todayUTCDate(), featured: { id: stored.id }, updated_at: 'x' })
    render(<CritterOfDay collected={new Map()} />)
    expect(await screen.findByText(stored.name)).toBeTruthy()
    await waitFor(() => expect(getFeaturedOfDay).toHaveBeenCalled())
    expect(putFeaturedOfDay).not.toHaveBeenCalled()
  })

  it('treats a malformed stored payload as fallback (local pick); never PUTs, never crashes', async () => {
    getFeaturedOfDay.mockResolvedValueOnce({ date: todayUTCDate(), featured: { nope: 1 }, updated_at: 'x' })
    render(<CritterOfDay collected={new Map()} />)
    expect(await screen.findByText(todayPick.name)).toBeTruthy()
    await waitFor(() => expect(getFeaturedOfDay).toHaveBeenCalled())
    expect(putFeaturedOfDay).not.toHaveBeenCalled()
  })

  it('shows celebration copy when the critter is collected', async () => {
    getFeaturedOfDay.mockResolvedValue(null) // endpoint no-op -> local pick
    render(<CritterOfDay collected={new Map([[todayPick.id, { count: 1 }]])} />)
    expect(await screen.findByText(todayPick.name)).toBeTruthy()
    expect(screen.getByText("You've spotted this one")).toBeTruthy()
  })

  it('uses de-FOMO presence copy (never "waiting") when uncollected, and survives endpoint failure', async () => {
    getFeaturedOfDay.mockResolvedValue(null)
    render(<CritterOfDay collected={new Map()} />)
    expect(await screen.findByText(todayPick.name)).toBeTruthy()
    expect(screen.getByText('Lives in the garden')).toBeTruthy()
    expect(screen.queryByText(/waiting/i)).toBeNull()
    expect(putFeaturedOfDay).not.toHaveBeenCalled() // null result -> no pin
  })
})
