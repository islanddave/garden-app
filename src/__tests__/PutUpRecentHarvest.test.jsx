// V4-PUTUPENGINE-001 slice 2 — the landing page's one "start something new" slot.
//
// Put-Up R2b: this file held the recent-harvest picker's tests (the list on the "Log a put-up" form, a pick
// carried to the wire with its harvest link, the reload gate on a picked harvest). The picker left with the
// form and is not rebuilt on the door; its tests left with it. The one test that stays is about the page.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import PutUp from '../pages/PutUp.jsx'

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    return Promise.resolve(null)
  })
}
function renderPage() {
  return render(<MemoryRouter initialEntries={[{ pathname: '/put-up' }]}><PutUp /></MemoryRouter>)
}

beforeEach(() => {
  fetchMock.mockReset()
  wire()
  sessionStorage.clear()
})

// B′ release 2 (V4 §2.2, §10.1): the read view's full-width "Log a put-up" CTA is retired — the page
// header's Put something up door is the one "start something new" slot now, on every segment.
describe('the start-something-new slot is the page-level door', () => {
  it('the Pantry carries the door, and no second CTA', async () => {
    renderPage()
    await screen.findByTestId('putup-door')
    expect(screen.queryByTestId('putup-primary-cta')).toBeNull()
  })
})
