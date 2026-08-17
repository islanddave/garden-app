// V4-OVERLAY-001 Slice 2 (§4) — Garden's mount-time param-strip (?add=1) must PRESERVE the location
// state when it rewrites the URL. The bug class: setSearchParams defaults navigate state to null, so a
// carried `background` (or any state) is silently dropped on mount. Harness modeled on
// Garden.editor.test with a non-null location.state to prove it survives the strip.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const BACKGROUND = { pathname: '/today', search: '' }
const { fetchSpy, getTokenSpy, searchParamsRef, setSearchParamsSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
  searchParamsRef: { current: new URLSearchParams('add=1') },
  setSearchParamsSpy: vi.fn((next) => {
    searchParamsRef.current = next instanceof URLSearchParams ? next : new URLSearchParams(next)
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/garden', search: '?add=1', state: { background: { pathname: '/today', search: '' } } }),
  useNavigate: () => () => {},
  useSearchParams: () => [searchParamsRef.current, setSearchParamsSpy],
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => <div data-testid="variety-picker" /> }))

import Garden from '../pages/Garden.jsx'

beforeEach(() => {
  fetchSpy.mockReset(); setSearchParamsSpy.mockClear()
  searchParamsRef.current = new URLSearchParams('add=1')
  fetchSpy.mockImplementation((url) => {
    if (url === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Spring', status: 'active', parent_project_id: null }])
    if (url === '/api/plants?view=grid') return Promise.resolve([])
    return Promise.resolve([])
  })
})

describe('Garden — ?add=1 strip preserves location.state (§4)', () => {
  it('spreads the carried background through the setSearchParams rewrite', async () => {
    render(<Garden />)
    await waitFor(() => {
      const stripCall = setSearchParamsSpy.mock.calls.find(([, opts]) => opts && opts.replace)
      expect(stripCall).toBeTruthy()
      expect(stripCall[1].state).toEqual({ background: BACKGROUND })
    })
  })
})
