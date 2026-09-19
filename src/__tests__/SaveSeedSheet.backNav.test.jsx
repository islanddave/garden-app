// BUG-SEEDSHEETBACK-001 — Android Back closes the Save-seed sheet, not the page under it.
//
// Filed MIN-3 by the v4.94.0→v4.95.0 pre-promote pass. Sheet's `armsBack` defaults OFF and is an
// explicit per-render-site opt-in — deliberately, because one useDismissable call serves every Sheet
// and blanket enrolment would orphan a pushed history entry on BottomNav's navigate-and-close rows.
// SaveSeedSheet was authored without it, which put it in the wrong category: it is a close-in-place
// sheet, the kind the prop exists for.
//
// THE COST, on Dave's actual device. He is Android-only in an installed PWA, where Back is a system
// gesture rather than a chrome button. With no marker armed, Back fell through to a plain history
// pop — and reached through the /log menu door (POI-SEEDDOORMENU-001) this sheet renders INSIDE the
// overlayable /log route, so a single Back unwound the entire route and took the half-typed lot
// name, the count and the process choice with it.
//
// The assertion is on the MARKER rather than on a simulated traversal: arming is the fact under
// test, jsdom's history semantics are exercised exhaustively by BackNav.history.test.jsx, and a
// test that re-derives them here would be measuring that file's subject rather than this one's.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'

const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }))

const flags = { DISMISS_REGISTRY_ENABLED: true, BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))
vi.mock('react-router-dom', () => ({
  // A spy rather than a fresh vi.fn() per call since V5-SEEDSTAB-001: the ending's navigate is now
  // asserted here (the last describe), and the two arming tests never read it.
  useNavigate: () => navigateSpy,
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(async () => ({ id: 'lot-1' })), getToken: vi.fn(async () => 'tok') }),
  apiFetch: vi.fn(async () => ({})),
}))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: () => <div data-testid="variety-picker-stub" />,
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const PLANTING = {
  id: 'pl-1', name: 'Brandywine — bed 3',
  variety_ref: { id: 'var-brandy', name: 'Brandywine' },
}

const armed = () => !!readMarker(window.history.state)

const mount = async (onClose = vi.fn()) => {
  const out = await act(async () => render(
    <DismissRegistryProvider>
      <SaveSeedSheet planting={PLANTING} onClose={onClose} />
    </DismissRegistryProvider>,
  ))
  await act(async () => { await Promise.resolve() })
  return out
}

beforeEach(() => {
  flags.DISMISS_REGISTRY_ENABLED = true
  flags.BACKNAV_ENABLED = true
  navigateSpy.mockReset()
  window.history.replaceState({ __base: 1 }, '')
})

describe('BUG-SEEDSHEETBACK-001 — the sheet takes the Back press', () => {
  it('arms a Back marker while open', async () => {
    expect(armed(), 'a marker existed before the sheet mounted — the test cannot prove anything').toBe(false)
    await mount()
    expect(screen.getByTestId('save-seed-submit')).toBeTruthy()
    expect(armed(), 'the sheet did not arm Back — a system Back will unwind the page under it').toBe(true)
  })

  it('does not arm when Back navigation is disabled — the flag still governs', async () => {
    // The opt-in must not become a way around the kill switch. If BACKNAV_ENABLED is off the whole
    // mechanism is off, armsBack or not.
    flags.BACKNAV_ENABLED = false
    await mount()
    expect(screen.getByTestId('save-seed-submit')).toBeTruthy()
    expect(armed()).toBe(false)
  })
})

// V5-SEEDSTAB-001 — the same marker, seen from the ending. SaveSeedSheet.test.jsx pins "replace while
// a marker is current" with the marker written onto the entry by hand; this is the arrangement the
// app actually runs, where the only marker is the one this sheet's own arming pushed. If the arming
// and the ending ever disagreed about what a current marker looks like, the hand-written case would
// stay green while every real save pushed — stranding the marker, so the first Back from the
// destination re-shows the page the sheet was opened on.
describe('V5-SEEDSTAB-001 — an armed sheet ends with a replace', () => {
  const saveUntracked = async () => {
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
  }

  it('armed by the provider: the navigate REPLACES', async () => {
    await mount()
    expect(armed(), 'precondition: the sheet armed its own marker').toBe(true)
    await saveUntracked()
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy.mock.calls[0]).toEqual(['/inventory/lot-1', { replace: true }])
  })

  it('Back navigation off, so nothing is armed: the plain one-argument push', async () => {
    // The control. Without it, a sheet that replaced unconditionally would pass the case above.
    flags.BACKNAV_ENABLED = false
    await mount()
    expect(armed()).toBe(false)
    await saveUntracked()
    expect(navigateSpy.mock.calls[0]).toEqual(['/inventory/lot-1'])
  })
})
