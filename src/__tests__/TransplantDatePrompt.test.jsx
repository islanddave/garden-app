// V4-MATURITYBASIS-001 — the "add transplant date" affordance that occupies the suppressed
// Est.-harvest slot (design D3). Covers: low-key-not-headline rendering, the >=44px touch target
// (Dave is Android/Chrome-only), the PATCH contract, the sow-date floor, and the in-place window
// correction that is the entire point of the prompt.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import TransplantDatePrompt from '../components/planting/TransplantDatePrompt.jsx'
import CropCard from '../components/planting/CropCard.jsx'

const PLANTING = {
  id: 'plant-1', sown_at: '2026-04-20',
  variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-transplant' },
}

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue({}) })

const openSheet = () => fireEvent.click(screen.getByTestId('add-transplant-date'))

describe('TransplantDatePrompt', () => {
  it('renders nothing without a planting id', () => {
    const { container } = render(<TransplantDatePrompt planting={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('is a low-key affordance, not headline treatment', () => {
    render(<TransplantDatePrompt planting={PLANTING} />)
    const btn = screen.getByTestId('add-transplant-date')
    // Same type scale as the label it replaces; no card, no banner, no fill, no chip padding.
    // (jsdom drops the `border: none` shorthand entirely, so the border is asserted as unset
    // rather than as the literal 'none'.)
    expect(btn.style.fontSize).toBe('0.82rem')
    expect(btn.style.background).toBe('none')
    expect(btn.style.borderStyle).toBeFalsy()
    expect(btn.style.padding).toBe('0px')
    // >=44px touch target (Android/Chrome).
    expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    expect(btn.getAttribute('aria-label')).toMatch(/transplant date/i)
  })

  it('does not open a sheet until it is tapped', () => {
    render(<TransplantDatePrompt planting={PLANTING} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openSheet()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('PATCHes the planting and reports the date back through onSaved', async () => {
    const onSaved = vi.fn()
    render(<TransplantDatePrompt planting={PLANTING} onSaved={onSaved} />)
    openSheet()
    fireEvent.change(screen.getByLabelText(/Transplanted on/i), { target: { value: '2026-06-23' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/plants/plant-1')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toEqual({
      transplanted_at: '2026-06-23', transplanted_at_approx: false,
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      transplanted_at: '2026-06-23', transplanted_at_approx: false,
    }))
  })

  it('refuses a transplant date before the sow date and does not call the API', async () => {
    // A pre-sow transplant date would anchor the window EARLIER than the sow-anchored one this
    // whole change exists to push later — the original bug, re-entered by hand.
    render(<TransplantDatePrompt planting={PLANTING} />)
    openSheet()
    fireEvent.change(screen.getByLabelText(/Transplanted on/i), { target: { value: '2026-03-01' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/before the sow date/i))
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('pins the date input floor to the sow date', () => {
    render(<TransplantDatePrompt planting={PLANTING} />)
    openSheet()
    expect(screen.getByLabelText(/Transplanted on/i).getAttribute('min')).toBe('2026-04-20')
  })

  it('surfaces a save failure and keeps the sheet open', async () => {
    apiFetchSpy.mockRejectedValue(new Error('boom'))
    const onSaved = vi.fn()
    render(<TransplantDatePrompt planting={PLANTING} onSaved={onSaved} />)
    openSheet()
    fireEvent.change(screen.getByLabelText(/Transplanted on/i), { target: { value: '2026-06-23' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Couldn't save/i))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('TransplantDatePrompt -> corrected window, in place', () => {
  it('saving the date replaces the prompt with a transplant-anchored window', async () => {
    // The payoff: no refetch, no reload. CropCard is re-rendered with the patched record exactly
    // as PlantingDetail does it, and the window that appears is anchored on the NEW transplant
    // date (2026-06-23 + 70d = Sep 1), not on the sow date (2026-04-20 + 70d = Jun 29).
    function Harness() {
      const [pl, setPl] = React.useState(PLANTING)
      return <CropCard planting={pl} onUpdated={(patch) => setPl(prev => ({ ...prev, ...patch }))} />
    }
    render(<Harness />)
    expect(screen.getByTestId('add-transplant-date')).toBeTruthy()

    openSheet()
    fireEvent.change(screen.getByLabelText(/Transplanted on/i), { target: { value: '2026-06-23' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(screen.queryByTestId('add-transplant-date')).toBeNull())
    expect(screen.getByText(/Sep 1, 2026/)).toBeTruthy()
    expect(screen.queryByText(/Jun 29, 2026/)).toBeNull()
    expect(screen.getByText('(from transplant)')).toBeTruthy()
  })
})
