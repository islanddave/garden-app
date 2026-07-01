// Slice 7 (V4-THEME-001) CareNeeded interaction tests. No jest-dom (L-182): role/attr/text +
// toBe/toBeTruthy/toBeNull only. Mocks: react-router Link, useApiFetch, ToastContext.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchMock, toastMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import CareNeeded from '../components/today/CareNeeded.jsx'

const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    { id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false },
    { id: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 1, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  // V4-TODAYLOC-001: enrichment endpoints (mount) return [] so grouping stays project-proxy;
  // event writes return a created id.
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ id: 'ev-new' }))
  sessionStorage.clear()
})

describe('CareNeeded — Slice 7', () => {
  it('renders location-grouped need rows with a dominant Log target (default By location)', () => {
    render(<CareNeeded plan={plan()} />)
    expect(screen.getByText('Needs care today')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.getByRole('group', { name: /Group by/i })).toBeTruthy()
    const logBtns = screen.getAllByRole('button', { name: /^Log Water for/i })
    expect(logBtns.length).toBe(2)
  })

  it('one-tap log POSTs the mapped event, drops the row, and offers undo', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const [path, opts] = fetchMock.mock.calls.find(c => c[0] === '/api/events')
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.event_type).toBe('watering')
    expect(body.plant_id).toBe('p1')
    expect(body.project_id).toBe('prP')
    expect(toastMock.showUndo).toHaveBeenCalledTimes(1)
  })

  it('on write failure the row stays and an error toast shows (no fade-and-forget)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(toastMock.show).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })

  it('skip suppresses a row for today without writing an event', () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Skip Habanero today/i }))
    expect(screen.queryByText('Habanero')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the all-clear empty state when nothing needs care', () => {
    render(<CareNeeded plan={{ water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [], rain_skipped: [] }} />)
    expect(screen.getByText(/All caught up/i)).toBeTruthy()
  })

  it('bulk chip opens a scoped fly-up and fans out one POST per checked row', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log all watering \(2\)/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Log all \(2\)/i }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(2))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalled())
  })
})
