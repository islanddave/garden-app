// Today fetched /api/plants TWICE on one paint: StorageDeadlineAlert and CareNeeded each ran their
// own mount-time read of the same list, with no shared cache between them. For Dave that response is
// 243 rows carrying 225 presigned URLs (~0.5-1 MB), so the duplicate was the single largest avoidable
// payload on the app's highest-traffic surface. Both now read through useCachedFetch, so dataCache's
// in-flight dedup collapses them to one request.
//
// These tests mount with a Clerk sub present, which is the PRODUCTION configuration and the only one
// where dedup is even reachable: useCachedFetch deliberately falls back to an uncached per-component
// plain fetch when there is no sub, so that nothing is ever cached under an absent identity. The
// sibling component tests run without that provider and therefore still exercise the plain path —
// which is why they are not redundant with these.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { fetchMock, toastMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import CareNeeded from '../components/today/CareNeeded.jsx'
import StorageDeadlineAlert from '../components/today/StorageDeadlineAlert.jsx'
import { __resetDataCache } from '../lib/dataCache.js'

// ONE /api/plants response that serves BOTH consumers — the projections are identical because the
// two call sites request the identical bare path. StorageDeadlineAlert reads status + variety_ref +
// name; CareNeeded reads id + location_id + container_type + the featured photo. Disjoint fields,
// same rows: nothing has to be filtered differently, which is what makes a single fetch correct.
const PLANTS = () => ([
  {
    id: 'p1', name: 'Bhut Jolokia', status: 'vegetative',
    location_id: 'loc1', container_type: 'pot', metadata: { bed: null },
    featured_photo_id: 'ph1', featured_photo_view_url: 'https://s3.invalid/a.jpg?sig=1',
    featured_photo_thumb_url: 'https://s3.invalid/thumbs/a.jpg?sig=1',
    variety_ref: { id: 'v1', name: 'Bhut Jolokia', crop_type_slug: 'pepper' },
  },
  {
    id: 'p-sp1', name: 'Beauregard', status: 'vegetative',
    location_id: 'loc1', container_type: 'in_ground', metadata: null,
    featured_photo_id: null, featured_photo_view_url: null, featured_photo_thumb_url: null,
    variety_ref: { id: 'v2', name: 'Beauregard', crop_type_slug: 'sweet_potato' },
  },
])
const LOCATIONS = () => ([{ id: 'loc1', name: 'Bed 3', full_path: 'Back Garden › Bed 3' }])

const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [{ id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false }],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

const callsTo = (path) => fetchMock.mock.calls.filter(c => c[0] === path).length

beforeEach(() => {
  __resetDataCache()
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/plants') return Promise.resolve(PLANTS())
    if (path === '/api/locations/with-path') return Promise.resolve(LOCATIONS())
    return Promise.resolve({ id: 'ev-new' })
  })
  sessionStorage.clear()
})

describe('Today — /api/plants is fetched once per paint, not once per component', () => {
  it('StorageDeadlineAlert + CareNeeded mounting together issue ONE /api/plants request', async () => {
    render(
      <>
        <StorageDeadlineAlert todayISO="2026-10-01" />
        <CareNeeded plan={plan()} />
      </>,
    )
    // Both consumers reach their data...
    await waitFor(() => expect(screen.getByTestId('storage-deadline-sweet_potato')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Back Garden › Bed 3')).toBeTruthy())
    // ...off a single request. Was 2 before this lane (one mount effect per component).
    expect(callsTo('/api/plants')).toBe(1)
  })

  it('the household lens (N CareNeeded + the alert) still issues ONE /api/plants request', async () => {
    // Today renders CareNeeded once for the current user and once more per household plan, so the
    // duplication scaled with caretakers: 2 + N reads of the same list. Dedup is per key, not per
    // pair, so it collapses all of them.
    render(
      <>
        <StorageDeadlineAlert todayISO="2026-10-01" />
        <CareNeeded plan={plan()} />
        <CareNeeded plan={plan()} />
      </>,
    )
    await waitFor(() => expect(screen.getAllByText('Back Garden › Bed 3').length).toBe(2))
    expect(callsTo('/api/plants')).toBe(1)
    // NOT deduped, and deliberately left alone: /api/locations/with-path stays a plain per-instance
    // fetch. Routing the remaining list reads through the cache is a separate, wider decision.
    expect(callsTo('/api/locations/with-path')).toBe(2)
  })

  it('both consumers render the SAME shared response correctly — no projection mismatch', async () => {
    render(
      <>
        <StorageDeadlineAlert todayISO="2026-10-01" />
        <CareNeeded plan={plan()} />
      </>,
    )
    // The alert speaks from variety_ref.crop_type_slug on the shared rows...
    await waitFor(() => expect(screen.getByTestId('storage-deadline-sweet_potato')).toBeTruthy())
    expect(screen.getByText(/Start checking sweet potatoes for lifting/)).toBeTruthy()
    expect(screen.getByText('Beauregard')).toBeTruthy()
    // ...while CareNeeded groups by location_id/full_path off the very same rows, rather than
    // falling back to the project-name proxy ('Peppers') it uses when enrichment is unavailable.
    await waitFor(() => expect(screen.getByText('Back Garden › Bed 3')).toBeTruthy())
    expect(screen.queryByText('Peppers')).toBeNull()
  })

  it('a revisit paints from cache and revalidates once, without re-rendering a changed list', async () => {
    const first = render(<><StorageDeadlineAlert todayISO="2026-10-01" /><CareNeeded plan={plan()} /></>)
    await waitFor(() => expect(screen.getByText('Back Garden › Bed 3')).toBeTruthy())
    expect(callsTo('/api/plants')).toBe(1)
    first.unmount()

    // Remount: the cached list paints immediately, and exactly ONE background revalidate fires for
    // the pair (not one per component).
    render(<><StorageDeadlineAlert todayISO="2026-10-01" /><CareNeeded plan={plan()} /></>)
    expect(screen.getByTestId('storage-deadline-sweet_potato')).toBeTruthy()   // no loading gap
    await waitFor(() => expect(callsTo('/api/plants')).toBe(2))
    await waitFor(() => expect(screen.getByText('Back Garden › Bed 3')).toBeTruthy())
  })
})

describe('Today — the shared cache cannot mislead a write', () => {
  it('one-tap log takes its ids from the plan, never from the cached plants list', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<><StorageDeadlineAlert todayISO="2026-10-01" /><CareNeeded plan={plan()} /></>)
    await waitFor(() => expect(screen.getByText('Back Garden › Bed 3')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalledTimes(1))
    const [, opts] = fetchMock.mock.calls.find(c => c[0] === '/api/events')
    const body = JSON.parse(opts.body)
    // Both ids come from buildCareNeeded(plan) — the uncached daily-plan read — so no staleness in
    // the shared plants cache can route a log at the wrong planting. This is the property that makes
    // caching safe on a surface Dave logs against.
    expect(body.plant_id).toBe('p1')
    expect(body.project_id).toBe('prP')
  })
})
