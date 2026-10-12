/**
 * src/__tests__/CropTypesAdmin.test.jsx — V4-CROPTYPERETIRE-001, the page at /admin/crop-types.
 *
 * Mocks useApiFetch -> fetchSpy, which answers from a small in-memory "server" so a retire or a
 * bring back is read back by the page's own re-read.
 *
 * Covers the page's states (loading, list, refused with the server's reason, not admin, not switched
 * on, load failed), the two requests it sends, and that every control is at least 44px tall.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import CropTypesAdmin, { NOT_SWITCHED_ON, NOT_ADMIN_ACTION, UNREACHABLE } from '../pages/CropTypesAdmin.jsx'

const ZERO = { varieties: 0, put_ups: 0, pantry_items: 0, batches: 0, put_up_sources: 0 }
const FOOD = "Food types like bread and cheese are part of Put Up and can't be retired."
const seed = () => [
  { slug: 'tatsoi', display_name: 'Tatsoi', category: 'vegetable', retired: false, retired_at: null, counts: ZERO, can_retire: true, why_not: null },
  { slug: 'pepper', display_name: 'Pepper', category: 'vegetable', retired: false, retired_at: null, counts: { ...ZERO, varieties: 40 }, can_retire: false, why_not: 'Still used by 40 varieties.' },
  { slug: 'bread', display_name: 'Bread', category: 'non_plant_food', retired: false, retired_at: null, counts: ZERO, can_retire: false, why_not: FOOD },
  { slug: 'mache', display_name: 'Mache', category: 'vegetable', retired: true, retired_at: '2026-10-01T00:00:00.000Z', counts: ZERO, can_retire: false, why_not: null },
]
const httpError = (status, message, body = {}) => Object.assign(new Error(message), { status, body: { error: message, ...body } })

// A stand-in for the three routes. `refuse` makes the next write fail with that error.
let types
let refuse
function server(path, opts) {
  if (path === '/api/varieties/crop-types/admin') return Promise.resolve({ types: types.map(t => ({ ...t })) })
  if (refuse) { const e = refuse; refuse = null; return Promise.reject(e) }
  const body = JSON.parse(opts.body)
  if (path === '/api/varieties/crop-types/retire' && opts.method === 'POST') {
    const t = types.find(x => x.slug === body.slug)
    Object.assign(t, { retired: true, can_retire: false })
    return Promise.resolve({ ...t })
  }
  if (path === '/api/varieties/crop-types' && opts.method === 'POST' && body.restore_slug) {
    const t = types.find(x => x.slug === body.restore_slug)
    Object.assign(t, { retired: false, can_retire: true })
    return Promise.resolve({ slug: t.slug, display_name: t.display_name, restored: true })
  }
  return Promise.reject(new Error(`unexpected request ${opts?.method} ${path}`))
}

beforeEach(() => {
  types = seed()
  refuse = null
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(server)
})

const row = (slug) => screen.getByTestId(`crop-type-${slug}`)
const sectionOf = (slug) => row(slug).closest('section').querySelector('h2').textContent

describe('CropTypesAdmin — states', () => {
  it('says it is loading until the list arrives', async () => {
    let release
    fetchSpy.mockImplementationOnce(() => new Promise((r) => { release = r }))
    render(<CropTypesAdmin />)
    expect(screen.getByText('Loading crop types…')).toBeTruthy()
    expect(screen.queryByText('Crop types')).toBeNull()
    release({ types: seed() })
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
    expect(screen.queryByText('Loading crop types…')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith('/api/varieties/crop-types/admin')
  })

  it('lists every type under what can be done with it, with the reason a type has to stay', async () => {
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
    expect(sectionOf('tatsoi')).toBe('Can be retired (1)')
    expect(sectionOf('mache')).toBe('Retired (1)')
    expect(sectionOf('pepper')).toBe("Can't be retired (2)")
    expect(sectionOf('bread')).toBe("Can't be retired (2)")
    expect(within(row('tatsoi')).getByText('Nothing uses it.')).toBeTruthy()
    expect(within(row('pepper')).getByText('Still used by 40 varieties.')).toBeTruthy()
    expect(within(row('bread')).getByText(FOOD)).toBeTruthy()
    // Only a type that can be retired offers Retire; only a retired one offers Bring back.
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Retire Tatsoi', 'Bring back Mache'])
  })

  it('shows the neutral placard, and nothing else, to someone who is not the admin', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(httpError(403, 'Admin only')))
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText('Nothing to see here.')).toBeTruthy())
    expect(screen.queryByText('Crop types')).toBeNull()
    expect(screen.queryByText(NOT_SWITCHED_ON)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says retiring is not switched on when the server has no admin set, not a blank or a raw 403', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(httpError(403, 'Admin only', { code: 'admin_not_configured' })))
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText("Retiring isn't switched on for this garden yet.")).toBeTruthy())
    expect(NOT_SWITCHED_ON).toBe("Retiring isn't switched on for this garden yet.")
    expect(screen.queryByText('Nothing to see here.')).toBeNull()
    expect(screen.queryByText(/Admin only|403/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a failed load says so and offers Try again, which loads the list', async () => {
    fetchSpy.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { status: 0 })))
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(`Couldn't load crop types. ${UNREACHABLE}`))
    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
  })
})

describe('CropTypesAdmin — retire and bring back', () => {
  it('Retire sends the slug, prints the result in the row, and the type reads back retired', async () => {
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Retire Tatsoi'))
    await waitFor(() => expect(within(row('tatsoi')).getByRole('status').textContent).toBe('Retired Tatsoi.'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/varieties/crop-types/retire', { method: 'POST', body: JSON.stringify({ slug: 'tatsoi' }) })
    await waitFor(() => expect(sectionOf('tatsoi')).toBe('Retired (2)'))
    expect(within(row('tatsoi')).getByLabelText('Bring back Tatsoi')).toBeTruthy()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('Bring back sends restore_slug to the crop-types POST, and the type reads back live', async () => {
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Bring back Mache'))
    await waitFor(() => expect(within(row('mache')).getByRole('status').textContent).toBe('Brought back Mache.'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/varieties/crop-types', { method: 'POST', body: JSON.stringify({ restore_slug: 'mache' }) })
    await waitFor(() => expect(sectionOf('mache')).toBe('Can be retired (2)'))
  })

  it('a refused retire prints the server\'s reason in the row and the type stays live', async () => {
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
    refuse = httpError(409, 'Still used by 3 pantry items and 1 batch.', { code: 'in_use' })
    types[0] = { ...types[0], can_retire: false, why_not: 'Still used by 3 pantry items and 1 batch.' }
    fireEvent.click(screen.getByLabelText('Retire Tatsoi'))
    await waitFor(() => expect(within(row('tatsoi')).getByRole('status').textContent).toBe('Still used by 3 pantry items and 1 batch.'))
    await waitFor(() => expect(sectionOf('tatsoi')).toBe("Can't be retired (3)"))
    expect(within(row('tatsoi')).queryByRole('button')).toBeNull()
  })

  it.each([
    ['is not the admin', httpError(403, 'Admin only'), NOT_ADMIN_ACTION],
    ['could not be reached', Object.assign(new Error('Failed to fetch'), { status: 0 }), UNREACHABLE],
  ])('a retire that %s says so in plain words in the row', async (_n, err, words) => {
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
    refuse = err
    fireEvent.click(screen.getByLabelText('Retire Tatsoi'))
    await waitFor(() => expect(within(row('tatsoi')).getByRole('status').textContent).toBe(words))
    expect(sectionOf('tatsoi')).toBe('Can be retired (1)')
  })

  it('every control is at least 44px tall', async () => {
    render(<CropTypesAdmin />)
    await waitFor(() => expect(screen.getByText('Crop types')).toBeTruthy())
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(parseInt(b.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
  })
})
