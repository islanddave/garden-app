// BUG-SILENTFAILSWEEP-001 — the Findings side of the resolve, which had NO catch at all.
//
// The card is the surface and stays the surface (FindingCard.test.jsx owns those assertions): the
// message belongs next to the button that was tapped, and a second page-level one would report a
// single tap twice. What was missing is that the page was RELYING on that, silently — the child's
// catch was the only thing between a failed resolve and an unhandled rejection, which is not a
// guarantee this page can make on a child's behalf.
//
// FindingsList is stubbed so the callback can be invoked directly, including WITHOUT awaiting it —
// the un-awaited call is the case the real card never produces and the next caller might.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { findingsState, apiFetchSpy, captured } = vi.hoisted(() => ({
  findingsState: { current: null },
  apiFetchSpy: vi.fn(),
  captured: { onResolve: null },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'test' }),
}))
vi.mock('../hooks/useFindings.js', () => ({ useFindings: () => findingsState.current }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => ({ data: null, loading: false }) }))
vi.mock('../hooks/useCritterCollection.js', () => ({ useCritterCollection: () => ({ collected: new Map(), loading: false }) }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../components/findings/FindingsList.jsx', () => ({
  default: ({ findings, onResolve }) => {
    if (onResolve) captured.onResolve = onResolve
    return (
      <div data-testid="findings-list">
        {(findings ?? []).map(fd => (
          <button key={fd.finding_id} type="button" onClick={() => onResolve?.('evt-1')}>
            resolve {fd.finding_id}
          </button>
        ))}
      </div>
    )
  },
}))

import Findings from '../pages/Findings.jsx'

const FINDING = {
  finding_id: 'issue:evt-1', decay_state: 'fresh', trend: 'worsening', statement: 'ACTIVE_ONE',
  assertion_mode: 'assert', confidence_band: 'low', confidence_basis: '', urgency_level: 'low',
}

// Node reports an unhandled rejection once the microtask queue drains. Registering a listener also
// means vitest's own handler is not the only one, so the assertion below is on what we recorded.
let unhandled = []
const record = (reason) => { unhandled.push(reason) }
const drain = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', record)
  captured.onResolve = null
  apiFetchSpy.mockReset()
  apiFetchSpy.mockResolvedValue({})
})
afterEach(() => { process.off('unhandledRejection', record) })

function renderWith(reload) {
  findingsState.current = { data: { findings: [FINDING] }, loading: false, error: null, reload }
  render(<Findings />)
}

describe('Findings.handleResolve — the contract the card depends on', () => {
  it('a failed resolve does NOT refresh the list underneath the card', async () => {
    // Refreshing on a resolve that never landed would re-render the finding as unchanged, which
    // reads as "handled, and the engine disagrees" rather than "that write did not happen".
    const reload = vi.fn()
    apiFetchSpy.mockImplementation((path, opts) => (
      opts?.method === 'PATCH' ? Promise.reject(new Error('nope')) : Promise.resolve({})
    ))
    renderWith(reload)
    await act(async () => { fireEvent.click(screen.getByText('resolve issue:evt-1')); await drain() })
    expect(reload).not.toHaveBeenCalled()
    expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(true)
  })

  it('a successful resolve DOES refresh it', async () => {
    const reload = vi.fn()
    renderWith(reload)
    await act(async () => { fireEvent.click(screen.getByText('resolve issue:evt-1')); await drain() })
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('the returned promise still rejects, so the card can surface the failure', async () => {
    apiFetchSpy.mockImplementation((path, opts) => (
      opts?.method === 'PATCH' ? Promise.reject(new Error('nope')) : Promise.resolve({})
    ))
    renderWith(vi.fn())
    await expect(captured.onResolve('evt-1')).rejects.toThrow('nope')
  })

  it('an un-awaited failed resolve is not an unhandled rejection', async () => {
    // The half the card cannot provide. Every caller today awaits; this pins that forgetting to is
    // a missing message rather than a page-level error.
    apiFetchSpy.mockImplementation((path, opts) => (
      opts?.method === 'PATCH' ? Promise.reject(new Error('nope')) : Promise.resolve({})
    ))
    renderWith(vi.fn())
    await act(async () => { captured.onResolve('evt-1'); await drain(); await drain() })
    expect(unhandled).toEqual([])
  })

  it('no event id is a no-op that still returns a promise', async () => {
    renderWith(vi.fn())
    await expect(captured.onResolve(null)).resolves.toBeUndefined()
    expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PATCH')).toBe(false)
  })
})
