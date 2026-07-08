// V4-STATUSTAP-001 — StatusPicker (hero status control): renders the badge (or a "Set status"
// pill when unset), and the overlaid native <select> PUTs /api/plants/:id {status}.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import StatusPicker from '../components/planting/StatusPicker.jsx'

beforeEach(() => { apiFetchSpy.mockReset() })

describe('StatusPicker', () => {
  it('renders the multi-channel status badge when a status is set', () => {
    render(<StatusPicker planting={{ id: 'pl1', status: 'seedling' }} />)
    expect(screen.getByLabelText('Status: Seedling')).toBeDefined()
    // The picker is a single combobox regardless of state.
    expect(screen.getByRole('combobox', { name: /change planting status/i })).toBeDefined()
  })

  it('renders a "Set status" affordance (no badge) when status is unset', () => {
    render(<StatusPicker planting={{ id: 'pl1', status: null }} />)
    expect(screen.getByText('Set status')).toBeDefined()
    expect(screen.queryByLabelText(/^Status:/)).toBeNull()
  })

  it('PUTs /api/plants/:id {status} and calls onStatusChanged on change', async () => {
    apiFetchSpy.mockResolvedValue({ status: 'flowering' })
    const onStatusChanged = vi.fn()
    render(<StatusPicker planting={{ id: 'pl1', status: 'seedling' }} onStatusChanged={onStatusChanged} />)
    const select = screen.getByRole('combobox', { name: /change planting status/i })
    await act(async () => { fireEvent.change(select, { target: { value: 'flowering' } }) })
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/plants/pl1')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual({ status: 'flowering' })
    await waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith('flowering'))
  })

  it('does not PUT when the status is unchanged', async () => {
    render(<StatusPicker planting={{ id: 'pl1', status: 'seedling' }} />)
    const select = screen.getByRole('combobox', { name: /change planting status/i })
    await act(async () => { fireEvent.change(select, { target: { value: 'seedling' } }) })
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('returns null for a missing planting', () => {
    const { container } = render(<StatusPicker planting={null} />)
    expect(container.firstChild).toBeNull()
  })
})
