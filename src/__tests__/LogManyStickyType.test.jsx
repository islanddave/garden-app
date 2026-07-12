// logmany-sticky-eventtype — Log Many remembers the last chosen event type (localStorage,
// key 'quicklog.lastEventType'), mirroring how it already persists scope. On a cold remount the
// remembered type pre-fills the picker so the user skips re-selecting it; an explicit in-session
// change is never overridden (the localStorage read only runs on mount).
//
// Selection is style-only in EventTypePicker (no aria marker), so we assert eventType via the
// confirm button label — `Log ${verbLabel} on ${committedCount}` — which is derived from state
// and is a stable rendered signal (ScopeChecklist is stubbed → committedCount is 0).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const navigate = vi.fn()
// Stable mock identities so LogMany's loader effect (deps [fetch, params]) doesn't re-fire
// every render — a fresh URLSearchParams/fetch per render self-triggers the effect in a loop.
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
const apiFetch = vi.fn(() => Promise.resolve([]))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  Link: ({ children }) => children,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))
vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ScopeChecklist: ({ onSelectionChange }) => (
      <button type="button" onClick={() => onSelectionChange({ committedCount: 3, excludedIds: [] })}>
        stub-commit-scope
      </button>
    ),
  }
})

import LogMany from '../pages/LogMany.jsx'

const KEY = 'quicklog.lastEventType'

describe('LogMany — sticky event type (logmany-sticky-eventtype)', () => {
  beforeEach(() => { navigate.mockClear(); localStorage.clear() })

  it('defaults to Watered on a cold mount with nothing remembered', async () => {
    render(<LogMany />)
    await screen.findByText('Watered')
    expect(screen.getByText('Log watered on 0')).toBeTruthy()
  })

  it('pre-fills the remembered event type on remount', async () => {
    localStorage.setItem(KEY, 'flowering')
    render(<LogMany />)
    await screen.findByText('Flowering')
    expect(screen.getByText('Log flowering on 0')).toBeTruthy()
    expect(screen.queryByText('Log watered on 0')).toBeNull()
  })

  it('ignores a bogus remembered value and falls back to the default', async () => {
    localStorage.setItem(KEY, 'not_a_real_event')
    render(<LogMany />)
    await screen.findByText('Watered')
    expect(screen.getByText('Log watered on 0')).toBeTruthy()
  })

  it('does not persist an in-session pick until confirm (persist is confirm-only, like scope)', async () => {
    localStorage.setItem(KEY, 'watering')
    render(<LogMany />)
    const flowering = await screen.findByText('Flowering')
    fireEvent.click(flowering.closest('button'))
    expect(screen.getByText('Log flowering on 0')).toBeTruthy()
    expect(localStorage.getItem(KEY)).toBe('watering')
  })

  it('persists the chosen event type to localStorage on confirm', async () => {
    render(<LogMany />)
    const flowering = await screen.findByText('Flowering')
    fireEvent.click(flowering.closest('button'))
    fireEvent.click(screen.getByText('stub-commit-scope'))
    fireEvent.click(await screen.findByText('Log flowering on 3'))
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe('flowering'))
  })
})
