// BUG-GARDENSPOTCREEP-001 (rimpact-gardencreep #6) — AssigneePicker on the REAL useMembers, served from the SWR store.
// AssigneePicker.test.jsx mocks the hook, as the other consumer suites do, so the error contract the cached roster
// brings was pinned only at hook level: with the household already in the store, the picker is usable on its first
// render, and a revalidate that FAILS keeps the cached options with no error (only a cold failure shows one).
// The identity mock supplies a Clerk sub (`user`), which is what puts useCachedFetch in CACHED mode.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

const { fetchMock, identity } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  identity: { current: { user: { id: 'sub-A' }, profile: { id: 'sub-A' }, loading: false } },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn(async () => 'tk') }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => identity.current, useAuth: () => identity.current }))

import AssigneePicker from '../components/AssigneePicker.jsx'
import * as cache from '../lib/dataCache.js'

const KEY = () => cache.keyFor('sub-A', '/api/members')
const HOUSEHOLD = { members: [{ id: 'sub-A', display_name: 'Dave N' }, { id: 'user_jen', display_name: 'Jen' }] }
const options = () => screen.getAllByRole('option').map((o) => o.textContent)

beforeEach(() => {
  cache.__resetDataCache()
  fetchMock.mockReset()
})

describe('AssigneePicker with the household already in the store', () => {
  it('a failing revalidate keeps the cached options, enabled, and shows no error', async () => {
    await cache.warm(KEY(), () => Promise.resolve(HOUSEHOLD))
    await waitFor(() => expect(cache.peek(KEY())).toMatchObject({ status: 'value', isValidating: false }))
    fetchMock.mockRejectedValue(new Error('Failed to load caretakers'))
    render(<AssigneePicker entityType="plant" entityId="pl1" value={null} onChanged={() => {}} />)
    // Usable on the first render: the household is there, nothing is loading.
    expect(options()).toEqual(['Inherit from project', 'Dave N', 'Jen'])
    expect(screen.getByRole('combobox').disabled).toBe(false)
    expect(screen.queryByText('Loading caretakers…')).toBeNull()
    // The mount's revalidate goes out and fails; the picker does not change.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/members'))
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(cache.peek(KEY()).isValidating).toBe(false)
    expect(options()).toEqual(['Inherit from project', 'Dave N', 'Jen'])
    expect(screen.queryByText('Failed to load caretakers')).toBeNull()
  })

  it('control: a COLD failure still says so (nothing to fall back on)', async () => {
    fetchMock.mockRejectedValue(new Error('Failed to load caretakers'))
    render(<AssigneePicker entityType="plant" entityId="pl1" value={null} onChanged={() => {}} />)
    expect(await screen.findByText('Failed to load caretakers')).toBeTruthy()
    expect(options()).toEqual(['Inherit from project'])
  })
})
