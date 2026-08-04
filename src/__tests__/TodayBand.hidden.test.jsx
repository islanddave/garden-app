// TodayBand.hidden.test.jsx — V4-HIDETODAYBAND-001 (BD-002). THE SHIPPED-VALUE PIN.
//
// BD-002 was "HIDE the always-on needs-attention bar, don't remove it." The component, the ranked
// todayBand() helper, the /api/dashboard signals and every other TodayBand test stay intact; this file
// pins the three things that actually have to be true for "hidden" to mean anything:
//   1. the flag really ships TRUE (importActual — no mock, so a silent flip fails HERE, deliberately,
//      rather than quietly changing what 49 of the app's 50 routes look like);
//   2. nothing renders;
//   3. the reclaimed viewport is REAL — --today-band-height is explicitly written '0px' rather than
//      left at whatever a previous mount wrote, because App.jsx's shell padding is
//      calc(... + var(--today-band-height, 0px)) and that var is the entire mechanism.
// Plus: hidden means no work — the bar's refetch-on-every-navigation must not fire.
//
// Its counterpart TodayBand.test.jsx owns the rollback-lever proof (mocks the flag false and exercises
// the full component), so neither file breaks by construction on a future flip.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

const navigateMock = vi.fn()
const locationRef = { pathname: '/garden' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
}))
const fetchMock = vi.fn(() => Promise.resolve({ water_due: [], harvest_ready: [], heads_up: [] }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))

import TodayBand from '../components/TodayBand.jsx'
import { TODAY_BAND_HIDDEN } from '../lib/featureFlags.js'

const bandVar = () => document.documentElement.style.getPropertyValue('--today-band-height')

beforeEach(() => {
  navigateMock.mockReset(); fetchMock.mockClear()
  locationRef.pathname = '/garden'
  document.documentElement.style.removeProperty('--today-band-height')
})

describe('TodayBand — V4-HIDETODAYBAND-001 shipped hidden (BD-002)', () => {
  it('the flag ships TRUE (a flip is a deliberate decision, not a quiet one)', () => {
    expect(TODAY_BAND_HIDDEN).toBe(true)
  })

  it('renders nothing on a non-/today route', async () => {
    const { container } = render(<TodayBand />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-tier]')).toBeNull()
  })

  it('reclaims the inset: --today-band-height is explicitly 0px, not merely unset', async () => {
    // Seed the var non-zero first, so passing requires an explicit write rather than absence.
    document.documentElement.style.setProperty('--today-band-height', '56px')
    render(<TodayBand />)
    await act(async () => { await Promise.resolve() })
    expect(bandVar()).toBe('0px')
  })

  it('issues no /api/dashboard fetch while hidden', async () => {
    render(<TodayBand />)
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays hidden on /today too (the pre-existing exemption is unaffected)', async () => {
    locationRef.pathname = '/today'
    const { container } = render(<TodayBand />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('button')).toBeNull()
    expect(bandVar()).toBe('0px')
  })
})
