/**
 * BUG-SEEDEXTRACTOR-001 — the flag-OFF world, which is what actually ships.
 *
 * "Photo of packets" and "Paste an order" have NEVER worked in production: both POST
 * /api/inventory-items/extract-seeds, which needs ANTHROPIC_API_KEY in the garden-app/secrets
 * bundle. That secret holds only CLERK_SECRET_KEY and NEON_DATABASE_URL, so the Lambda returns 501
 * and the UI shows "isn't configured yet". Dave 2026-09-03: don't provision the key, hide the dead
 * buttons, revisit well down the line.
 *
 * Two chooser tiles that always fail are worse than two tiles that do not exist — they read as
 * capability, and cost a tap and a disappointment every time.
 *
 * The sibling AddSeeds.test.jsx pins the flag TRUE and keeps covering the full extract flow. This
 * file covers the shipped default. Both branches tested, per the house convention.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

// No override — the REAL module, so this asserts the value that actually ships. A pinned `false`
// here would pass forever even if the flag were flipped true in source, which is the one failure
// mode this file exists to prevent.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import AddSeeds from '../pages/AddSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { SEED_BULK_EXTRACT_ENABLED } from '../lib/featureFlags.js'

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockResolvedValue({})
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><AddSeeds /></ToastProvider>) })
}

describe('BUG-SEEDEXTRACTOR-001 — bulk intake tiles are hidden while unprovisioned', () => {
  it('ships with the flag OFF', () => {
    // The anchor for everything below. If someone provisions the key and flips this, the two
    // assertions after it SHOULD fail — that is the signal to delete this file, not to weaken it.
    expect(SEED_BULK_EXTRACT_ENABLED).toBe(false)
  })

  it('offers no door that cannot work', async () => {
    await renderPage()
    expect(screen.queryByText('Photo of packets')).toBeNull()
    expect(screen.queryByText('Paste an order')).toBeNull()
  })

  it('still offers the one intake path that DOES work', async () => {
    // The half that makes this a gate rather than a removal. Hiding the broken tiles must not take
    // the working one with them — "One item" is genuinely how seeds get added today, and a chooser
    // with nothing in it would be a worse dead end than the one being fixed.
    await renderPage()
    expect(screen.getByText('One item')).toBeTruthy()
  })

  it('never reaches the extractor endpoint on load', async () => {
    // Belt and braces: the tiles are gone, so nothing should be probing a 501 route behind the
    // scenes either. Asserts the absence of a call, not just the absence of a button.
    await renderPage()
    const hitExtract = fetchSpy.mock.calls.some(([url]) => String(url).includes('extract-seeds'))
    expect(hitExtract).toBe(false)
  })
})
