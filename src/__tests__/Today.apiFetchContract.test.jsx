/**
 * src/__tests__/Today.apiFetchContract.test.jsx — V5-TODAYSHAPE-001.
 *
 * WHY THIS FILE EXISTS. Today.test.jsx and Today.harvestSurface.test.jsx both mocked
 * `useApiFetch` as `() => ({ fetch })`, with no `getToken`, while `CareNeeded.jsx` destructures
 * `const { fetch, getToken } = useApiFetch()` and hands it straight to `fetchNotificationPrefs`.
 * 156 other mocks of the same module in this suite include `getToken`; those two did not.
 *
 * WHAT THE OMISSION ACTUALLY DID, measured rather than assumed. It was NOT causing a swallowed
 * error at runtime: `fetchNotificationPrefs` returns at its FIRST line — `if (!CRITTER_BASE) return
 * null` — because `VITE_API_CRITTERS` is not in vitest.config.ts's `env` block, so the unit run
 * never reaches `typeof getToken === 'function'` at all. The defect is therefore LATENT, not
 * active: the mock is a false model of the dependency, and it costs nothing today and everything on
 * the day the env var is added, the guard order changes, or a second consumer reads the token
 * earlier. Stated precisely because "the suite is green over a broken dependency" would be a
 * stronger claim than the evidence supports.
 *
 * WHAT THIS TEST GUARDS, and how it can fail. It mocks `notificationPrefsClient` instead of letting
 * the CRITTER_BASE guard hide the call, so the argument CareNeeded actually passes is observable.
 * Remove `getToken` from the mock below and this file goes red on `typeof getToken` — verified by
 * doing exactly that. That is the property the two repaired mocks now have and had no test for.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const { planState, fetchMock, toastMock, getTokenMock, prefsMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ id: 'ev' })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'harness-token'),
  prefsMock: vi.fn(async () => null),
}))

vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
// The seam that makes the omission observable at all: without this the CRITTER_BASE guard returns
// before the argument is ever looked at, and any assertion about it would be vacuous.
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: prefsMock,
  saveNotificationPrefs: vi.fn(async () => null),
}))

import Today from '../pages/Today.jsx'

beforeEach(() => { planState.current = null; sessionStorage.clear(); prefsMock.mockClear() })

describe('Today / CareNeeded — the useApiFetch contract', () => {
  it('hands fetchNotificationPrefs a CALLABLE getToken, not undefined', async () => {
    planState.current = {
      data: {
        has_plan: true, plan_date: '2026-09-08', generated_at: '2026-09-08T09:30:00Z',
        plan: { water_due: [{ plant_id: 'p1', name: 'Sungold', location_name: 'Bag Area' }], counts: { water_due: 1 } },
      },
      loading: false, error: null,
    }
    render(<Today />)
    await waitFor(() => expect(prefsMock).toHaveBeenCalled())
    const arg = prefsMock.mock.calls[0][0]
    // The assertion the two repaired mocks exist to satisfy. `arg.getToken` is `undefined` under a
    // `() => ({ fetch })` mock, and this line is what says so out loud.
    expect(typeof arg?.getToken).toBe('function')
  })
})
