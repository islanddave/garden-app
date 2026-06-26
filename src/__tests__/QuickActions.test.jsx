// V4-PLANTINGUI-001 — QuickActions: water (POST watering), status (PUT status), photo (deep-link).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import QuickActions from '../components/planting/QuickActions.jsx'

const PL = { id: 'pl1', project_id: 'proj1', status: 'seedling' }

function renderQA(props = {}) {
  return render(
    <MemoryRouter>
      <QuickActions planting={PL} {...props} />
    </MemoryRouter>,
  )
}

beforeEach(() => { apiFetchSpy.mockReset() })

describe('QuickActions', () => {
  it('Water POSTs a watering event and calls onLogged (no provider = no throw)', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'ev1', event_type: 'watering' })
    const onLogged = vi.fn()
    renderQA({ onLogged })
    fireEvent.click(screen.getByRole('button', { name: /Log watering/i }))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ project_id: 'proj1', plant_id: 'pl1', event_type: 'watering' })
    await waitFor(() => expect(onLogged).toHaveBeenCalled())
  })

  it('Status change PUTs /api/plants/:id {status} and calls onStatusChanged', async () => {
    apiFetchSpy.mockResolvedValue({ status: 'flowering' })
    const onStatusChanged = vi.fn()
    renderQA({ onStatusChanged })
    const select = screen.getByRole('combobox', { name: /Change status/i })
    await act(async () => { fireEvent.change(select, { target: { value: 'flowering' } }) })
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/plants/pl1')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual({ status: 'flowering' })
    await waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith('flowering'))
  })

  it('does not PUT when status is unchanged', async () => {
    renderQA()
    const select = screen.getByRole('combobox', { name: /Change status/i })
    await act(async () => { fireEvent.change(select, { target: { value: 'seedling' } }) })
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('Photo deep-links to the log flow for this planting', () => {
    renderQA()
    const link = screen.getByRole('link', { name: /Add a photo/i })
    expect(link.getAttribute('href')).toBe('/log?project=proj1&plant=pl1')
  })
})
