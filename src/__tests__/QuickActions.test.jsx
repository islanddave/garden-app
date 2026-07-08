// V4-PLANTINGUI-001 — QuickActions: water (POST watering) + photo (deep-link).
// V4-STATUSTAP-001: status moved to the hero StatusPicker (see StatusPicker.test.jsx); the
// former inline status <select> and its tests were removed from here.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { navigateSpy, setPendingSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn(), setPendingSpy: vi.fn() }))
vi.mock('react-router-dom', async (orig) => { const actual = await orig(); return { ...actual, useNavigate: () => navigateSpy } })
vi.mock('../lib/pendingCapture.js', () => ({ setPendingCapture: setPendingSpy, takePendingCapture: vi.fn() }))

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

  it('no longer renders a status control (moved to the hero StatusPicker)', () => {
    renderQA()
    expect(screen.queryByRole('combobox', { name: /status/i })).toBeNull()
  })

  it('Photo opens a picker; on pick it parks the file and jumps into the photo log flow (V4-PHOTOQUICK-001)', () => {
    navigateSpy.mockReset(); setPendingSpy.mockReset()
    const { container } = renderQA()
    fireEvent.click(screen.getByRole('button', { name: /Add a photo/i }))
    const input = container.querySelector('input[type="file"]')
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(setPendingSpy).toHaveBeenCalledWith(file)
    expect(navigateSpy).toHaveBeenCalledWith('/log?project=proj1&plant=pl1&event_type=photo&fromquick=1')
  })
})
