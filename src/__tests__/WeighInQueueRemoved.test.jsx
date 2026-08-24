// V4-WEIGHQUEUEKILL-001 (BD-044) — the weigh-in queue is GONE, and stays gone.
//
// Removed on Dave's instruction: "I never use that... it's a nice idea, but it's just not
// functionally useful for me and the way I log these." Asked directly whether he meant the whole
// section or only the tap-in-weighing-order semantics, he said the whole section.
//
// Four test files went with it — EventNew.harvestSessionQueue / harvestTrayImpression /
// harvestTrayFetchFailure / harvestTrayViewport, 34 cases. This file is what replaced them, and it
// is deliberately small: there is nothing left to characterise, only a removal to hold.
//
// It exists at all because the removed feature was WELL ARGUED. Its rationale is still on disk in
// four ledger rows (V4-HARVSESSION-002, V4-HARVTRAYVIEWPORT-001, BUG-HARVTRAYEMPTY-001,
// BUG-TRAYFETCHSILENT-001) and reads persuasively — a pre-flight queue for a rapid weigh-in loop is
// a good idea in the abstract. It just is not how Dave works. Without a guard, the next reader of
// those rows re-derives it; with one, bringing it back is a deliberate act that turns this red.
//
// The FETCH assertion is the load-bearing half. Removing the render while leaving the loader is the
// standard half-removal, and it would cost two requests on every single weigh-in mount to populate
// something nobody can see.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => () => {},
  useSearchParams: () => [new URLSearchParams('session=harvest'), () => {}],
}))
// importOriginal, not a bare object: useUploadPhoto reads a named `apiFetch` export at module load,
// so a mock that omits it fails the whole FILE to load rather than any individual case.
vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: async () => 't' }),
  apiFetch: apiFetchSpy,
}))
vi.mock('../context/ToastContext.jsx', () => ({ useToast: () => ({ showUndo: vi.fn(), show: vi.fn() }) }))

import EventNew from '../pages/EventNew.jsx'

beforeEach(() => {
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path) => {
    if (String(path).startsWith('/api/projects')) return Promise.resolve([{ id: 'pr1', name: 'Bed', status: 'active' }])
    if (String(path).startsWith('/api/plants')) return Promise.resolve([{ id: 'pl1', name: 'Sungold', project_id: 'pr1' }])
    return Promise.resolve([])
  })
})

async function renderSession() {
  await act(async () => { render(<EventNew />) })
}

describe('BD-044 — the weigh-in queue stays removed', () => {
  it('renders no queue section, tray, or tap-in-weighing-order affordance', async () => {
    await renderSession()
    expect(screen.queryByText(/Weigh-in queue/i)).toBeNull()
    expect(screen.queryByText(/tap in weighing order/i)).toBeNull()
    expect(screen.queryByTestId('harvest-tray-load-failed')).toBeNull()
    expect(screen.queryByTestId('harvest-tray-retry')).toBeNull()
  })

  it('makes NO tray fetches on a weigh-in mount — the loader went with the render', async () => {
    await renderSession()
    const paths = apiFetchSpy.mock.calls.map(c => String(c[0]))
    expect(paths.some(p => p.startsWith('/api/events/harvest-ready'))).toBe(false)
    expect(paths.some(p => p.startsWith('/api/harvests?include=entries'))).toBe(false)
    // Sanity: the component really did mount and fetch its normal dependencies, so the two
    // assertions above mean "not requested" rather than "nothing ran at all".
    expect(paths.length).toBeGreaterThan(0)
  })

  it('the session itself is untouched — Dave LOVES it; only the queue went', async () => {
    await renderSession()
    expect(screen.getByTestId('harvest-session-lock')).toBeTruthy()
  })
})
