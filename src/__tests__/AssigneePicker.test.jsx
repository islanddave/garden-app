import React from 'react'
// AssigneePicker tests (PLANT-ASSIGN-001). Mocks the roster hook + api seam (same pattern as the other
// component tests) so no Clerk/network is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn(async () => 'tk') }),
}))
vi.mock('../hooks/useMembers.js', () => ({
  useMembers: () => ({
    members: [
      { id: 'user_dave', display_name: 'Dave', email: 'd@x' },
      { id: 'user_jen', display_name: 'Jen', email: 'j@x' },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}))

import AssigneePicker from '../components/AssigneePicker.jsx'

describe('AssigneePicker', () => {
  beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue({}) })

  it('renders the roster plus an unassigned option (project)', () => {
    const { getByRole, getAllByRole } = render(
      <AssigneePicker entityType="project" entityId="p1" value={null} onChanged={() => {}} />
    )
    const opts = getAllByRole('option').map(o => o.textContent)
    expect(opts).toContain('Unassigned')
    expect(opts).toContain('Dave')
    expect(opts).toContain('Jen')
    expect(getByRole('combobox')).toBeTruthy()
  })

  it('a planting shows "Inherit from project" as the empty option', () => {
    const { getAllByRole } = render(
      <AssigneePicker entityType="plant" entityId="pl1" value={null} onChanged={() => {}} />
    )
    expect(getAllByRole('option').map(o => o.textContent)).toContain('Inherit from project')
  })

  it('PUTs the chosen assignee and calls onChanged', async () => {
    const onChanged = vi.fn()
    const { getByRole } = render(
      <AssigneePicker entityType="plant" entityId="pl1" value={null} onChanged={onChanged} />
    )
    fireEvent.change(getByRole('combobox'), { target: { value: 'user_jen' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [path, opts] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/plants/pl1')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual({ assignee_user_id: 'user_jen' })
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('user_jen'))
  })

  it('PUTs null when reverting to unassigned/inherit', async () => {
    const onChanged = vi.fn()
    const { getByRole } = render(
      <AssigneePicker entityType="project" entityId="p1" value={'user_dave'} onChanged={onChanged} />
    )
    fireEvent.change(getByRole('combobox'), { target: { value: '' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ assignee_user_id: null })
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null))
  })
})
