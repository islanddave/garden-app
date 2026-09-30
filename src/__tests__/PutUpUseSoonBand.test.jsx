// V4-HARVESTCENTER-001 (L10) — the Today "use soon" ambient card. Renders items with NEUTRAL framing
// (no loss-aversion, no "X days left" countdown), shows past_use_by as a distinct CALM tag, is hidden
// entirely when empty, and NEVER throws / surfaces an error on a fetch failure (supplementary glance).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { RETRY_DELAY_MS } from '../lib/useAmbientBandFetch.js'

const navigateMock = vi.fn()
const locationRef = { pathname: '/today' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
  Link: ({ children }) => <a>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import PutUpUseSoonBand from '../components/PutUpUseSoonBand.jsx'

const useSoon = (items) => fetchMock.mockImplementation((url) =>
  Promise.resolve(url === '/api/preservation/use-soon' ? { items } : null))

beforeEach(() => { navigateMock.mockReset(); fetchMock.mockReset() })

describe('PutUpUseSoonBand — Today "use soon" ambient card (L10)', () => {
  it('renders items with neutral framing (no loss-aversion, no countdown)', async () => {
    useSoon([
      { id: 'a', crop_display_name: 'Tomato', quantity_value: 14, quantity_unit: 'bags', method: 'whole_freeze', storage_label: 'Garage freezer', use_by_status: 'use_soon' },
    ])
    render(<PutUpUseSoonBand />)
    await screen.findByText('Cook these next')
    expect(screen.getByText('Tomato')).toBeTruthy()
    // Neutral: no loss-aversion or countdown language anywhere in the card.
    const card = screen.getByRole('region', { name: /From the Pantry/i })
    expect(card.textContent).not.toMatch(/days left|don't let|rot|exp'?ing|hurry/i)
  })

  it('shows a past_use_by row as a distinct CALM "past date" tag (not an alarm)', async () => {
    useSoon([
      { id: 'b', crop_display_name: 'Beans', quantity_value: 4, quantity_unit: 'jars', method: 'can_pressure', storage_label: 'Pantry', use_by_status: 'past_use_by' },
    ])
    render(<PutUpUseSoonBand />)
    await screen.findByText('Beans')
    expect(screen.getByText('past date')).toBeTruthy()
  })

  // A label-only jar (the ferment release: a name, no crop) leads with its label, not the fallback.
  it('a label-only row shows its label as the title', async () => {
    useSoon([
      { id: 'k', label: 'Napa kimchi', crop_display_name: null, crop_type_slug: null, quantity_value: 2, quantity_unit: 'jars', method: 'ferment', storage_label: 'Pantry', use_by_status: 'use_soon' },
    ])
    render(<PutUpUseSoonBand />)
    const title = await screen.findByText('Napa kimchi')
    expect(title.parentElement.firstChild).toBe(title)
    expect(screen.getAllByText('From the Pantry')).toHaveLength(1)
  })

  it('is hidden entirely when there is nothing to use soon', async () => {
    useSoon([])
    const { container } = render(<PutUpUseSoonBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/use-soon'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('shows nothing while the transient retry is still outstanding — never throws', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<PutUpUseSoonBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/use-soon'))
    // Real timers: the RETRY_DELAY_MS gap has not elapsed, so a one-off blip is still invisible.
    expect(container.querySelector('section')).toBeNull()
  })

  // Put-Up release 1a (V4 §6.1, §10.2) — the tap carries its destination: the put-up list, narrowed
  // to what this card showed. It opens as an overlay over Today (a `background` rides along), which
  // is what makes Back return here. PutUp.useSoonFilter.test.jsx proves the page honours the URL.
  it('the tap opens Put-Up on the list, filtered to use soon, over Today', async () => {
    useSoon([
      { id: 'a', crop_display_name: 'Tomato', quantity_value: 14, quantity_unit: 'bags', method: 'whole_freeze', storage_label: 'Garage freezer', use_by_status: 'use_soon' },
    ])
    render(<PutUpUseSoonBand />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Put-Up' }))
    expect(navigateMock).toHaveBeenCalledTimes(1)
    const [to, opts] = navigateMock.mock.calls[0]
    expect(to).toBe('/put-up?view=pantry&filter=use-soon')
    expect(opts.state.background.pathname).toBe('/today')
  })

  // BUG-READYBANDFETCH-001 — a persistent outage must not look like an empty shelf.
  it('a persistent fetch error renders the muted notice, not the empty state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fetchMock.mockRejectedValue(new Error('boom'))
      render(<PutUpUseSoonBand />)
      await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 50) })
      expect(screen.getByText(/Couldn’t check just now/i)).toBeTruthy()
    } finally { vi.useRealTimers() }
  })
})
