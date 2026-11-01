// new-file: new subject (src/hooks/usePlantPicker.js, the one reader of the picker projection)
// Guards the household-scoped cache key (`${sub}|${path}`) every picker reader now shares (OPS-CODEREVIEW-001 E2c).
// Trap: identity must come from `user`; a provider-less mount degrades useCachedFetch to PLAIN and caches nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import React from 'react'

const { fetchSpy, authState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  authState: { user: { id: 'userA' } },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => authState }))

import { usePlantPicker, PICKER_PATH } from '../hooks/usePlantPicker.js'
import { __resetDataCache, peek, keyFor } from '../lib/dataCache.js'

beforeEach(() => { fetchSpy.mockReset(); __resetDataCache(); authState.user = { id: 'userA' } })

function Probe({ testid = 'ids', ...opts }) {
  const { data, loading } = usePlantPicker(opts)
  return <span data-testid={testid} data-loading={String(loading)}>{(data ?? []).map((p) => p.id).join(',')}</span>
}

describe('usePlantPicker', () => {
  it('caches under the signed-in user, so a second user never paints the first one\'s list', async () => {
    fetchSpy.mockResolvedValue([{ id: 'a-1' }, { id: 'a-2' }])
    const first = render(<Probe />)
    await waitFor(() => expect(first.getByTestId('ids').textContent).toBe('a-1,a-2'))
    // PIN: the server contract string; the grid-view census and ~40 test mocks key on it.
    expect(fetchSpy).toHaveBeenCalledWith('/api/plants?view=picker')
    expect(peek(keyFor('userA', PICKER_PATH))?.data?.map((p) => p.id)).toEqual(['a-1', 'a-2'])
    first.unmount()

    authState.user = { id: 'userB' }
    fetchSpy.mockReset()
    fetchSpy.mockImplementation(() => new Promise(() => {}))   // hangs: only a cache hit could paint
    const second = render(<Probe />)
    expect(second.getByTestId('ids').textContent).toBe('')
    expect(second.getByTestId('ids').dataset.loading).toBe('true')
    expect(peek(keyFor('userB', PICKER_PATH))?.data).toBeUndefined()
  })

  it('two readers on one screen share one request', async () => {
    fetchSpy.mockResolvedValue([{ id: 'p-1' }])
    const view = render(<><Probe testid="host" /><Probe testid="child" /></>)
    await waitFor(() => expect(view.getByTestId('child').textContent).toBe('p-1'))
    expect(view.getByTestId('host').textContent).toBe('p-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('projectId scopes the path, and enabled:false sends nothing', async () => {
    fetchSpy.mockResolvedValue([{ id: 's-1' }])
    const idle = render(<Probe enabled={false} />)
    expect(idle.getByTestId('ids').dataset.loading).toBe('false')
    expect(fetchSpy).not.toHaveBeenCalled()
    idle.unmount()

    const scoped = render(<Probe projectId="proj-9" />)
    await waitFor(() => expect(scoped.getByTestId('ids').textContent).toBe('s-1'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/plants?view=picker&project_id=proj-9')
  })
})
