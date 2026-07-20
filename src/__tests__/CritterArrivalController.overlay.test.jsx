// V4-OVERLAY-001 Slice 2 (§7) — CritterArrivalController suppress-and-queue while a /log|/log/many
// overlay is open, flush on dismiss. Uses the REAL OverlayProvider + MemoryRouter so the open-overlay
// signal (background present + overlay pathname === /log[/many]) is exercised end to end.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import { MemoryRouter, useNavigate } from 'react-router-dom'
import { OverlayProvider } from '../context/OverlayContext.jsx'

const getTokenMock = vi.fn().mockResolvedValue('tk')
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ getToken: getTokenMock }) }))

const fetchActiveCrittersMock = vi.fn()
vi.mock('../lib/critterClient.js', () => ({ fetchActiveCritters: (...a) => fetchActiveCrittersMock(...a) }))

vi.mock('../components/CritterArrival.jsx', () => ({
  default: ({ critter }) => critter ? <div data-testid="critter-arrival" data-critter-id={critter.id} /> : null,
}))

import CritterArrivalController from '../components/CritterArrivalController.jsx'

function critter(over = {}) {
  return { id: 'c-fresh', species_id: 3, earned_at: new Date().toISOString(), viewed_at: null, ...over }
}

// Harness: renders the controller under OverlayProvider; a button dismisses the overlay (navigate to
// the background url with no state), which flips the open-overlay signal off.
function Dismisser() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/today', { replace: true })}>dismiss</button>
}

function renderOverlayOpen() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/log', state: { background: { pathname: '/today', search: '' } } }]}>
      <OverlayProvider>
        <Dismisser />
        <CritterArrivalController />
      </OverlayProvider>
    </MemoryRouter>
  )
}

beforeEach(() => { sessionStorage.clear(); fetchActiveCrittersMock.mockReset() })
afterEach(() => { cleanup() })

describe('CritterArrivalController — overlay suppression (§7)', () => {
  it('does NOT flash a fresh critter while a /log overlay is open', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter()])
    await act(async () => { renderOverlayOpen() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByTestId('critter-arrival')).toBeNull()
  })

  it('flushes the queued critter once the overlay is dismissed', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-queued' })])
    await act(async () => { renderOverlayOpen() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByTestId('critter-arrival')).toBeNull()

    await act(async () => { screen.getByText('dismiss').click(); await Promise.resolve(); await Promise.resolve() })
    const el = screen.queryByTestId('critter-arrival')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('data-critter-id')).toBe('c-queued')
  })
})
