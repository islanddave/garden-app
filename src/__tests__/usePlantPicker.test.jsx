// new-file: new subject (src/hooks/usePlantPicker.js, the one reader of the picker projection)
// Guards the household-scoped cache key (`${sub}|${path}`) every picker reader now shares (OPS-CODEREVIEW-001 E2c).
// Trap: identity must come from `user`; a provider-less mount degrades useCachedFetch to PLAIN and caches nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, screen, act, fireEvent } from '@testing-library/react'
import React from 'react'

const { fetchSpy, authState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  authState: { user: { id: 'userA' } },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => authState }))

import { usePlantPicker, PICKER_PATH } from '../hooks/usePlantPicker.js'
import { __resetDataCache, peek, keyFor, revalidateLive } from '../lib/dataCache.js'
import VoiceHarvest from '../pages/VoiceHarvest.jsx'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

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

// VoiceHarvest's mapping of the picker's data/error onto its list and loadError banner, in CACHED mode
// (a signed-in user, as on the phones). The VoiceHarvest suites mount provider-less, which is PLAIN mode.
describe('VoiceHarvest on the cached picker (R-E2C-1 Q2)', () => {
  const ROWS = [{
    id: 'p1', name: 'Suyo Long', archived_at: null,
    variety_ref: { id: 'v-p1', name: 'Suyo Long cultivar', crop_type_slug: 'cucumber', default_unit: null },
  }]
  const LOAD_ERROR = 'Could not load your plantings'
  let mic
  beforeEach(() => { mic = installFakeSpeechRecognition(vi) })
  afterEach(() => { vi.unstubAllGlobals() })

  // `picker` answers the picker path; everything else the page reads (crop types, aliases) gets [].
  const serve = (picker) => fetchSpy.mockImplementation((path) => (path === PICKER_PATH ? picker() : Promise.resolve([])))
  // Settled through another reader, as EventNew or the Log event chooser leaves it.
  async function warmCache() {
    serve(() => Promise.resolve(ROWS))
    const host = render(<Probe />)
    await waitFor(() => expect(host.getByTestId('ids').textContent).toBe('p1'))
    host.unmount()
  }
  // The crop slug is said, so the Crop slot reading the planting's NAME proves the list was there to match.
  async function cropSlotAfterSaying(text) {
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    await act(async () => { mic.latest().deliverFinal(text) })
    await act(async () => { mic.latest().endSession() })
    return screen.getByTestId('voice-harvest-record').textContent
  }
  const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n }); return { promise, resolve, reject } }

  it('a warm entry paints at once, while its revalidate is still out', async () => {
    await warmCache()
    serve(() => new Promise(() => {}))   // hangs: only the cache can supply the list
    render(<VoiceHarvest />)
    expect(await cropSlotAfterSaying('cucumber')).toContain('Suyo Long')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a failed background revalidate keeps the list and shows no banner', async () => {
    await warmCache()
    const revalidate = deferred()
    serve(() => revalidate.promise)
    render(<VoiceHarvest />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(PICKER_PATH))
    await act(async () => { revalidate.reject(new Error('offline')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(await cropSlotAfterSaying('cucumber')).toContain('Suyo Long')
  })

  it('a cold failure says it could not load, and nothing is said while the first load is out', async () => {
    const first = deferred()
    serve(() => first.promise)
    render(<VoiceHarvest />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(PICKER_PATH))
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { first.reject(new Error()) })
    expect(screen.getByRole('alert').textContent).toBe(LOAD_ERROR)
  })

  it('a body that is not a list says the same', async () => {
    serve(() => Promise.resolve({ message: 'Internal Server Error' }))
    render(<VoiceHarvest />)
    expect((await screen.findByRole('alert')).textContent).toBe(LOAD_ERROR)
  })

  it('a later success clears the banner and fills the list', async () => {
    serve(() => Promise.reject(new Error()))
    render(<VoiceHarvest />)
    expect((await screen.findByRole('alert')).textContent).toBe(LOAD_ERROR)
    serve(() => Promise.resolve(ROWS))
    await act(async () => { revalidateLive() })   // the wake revalidation, the path that retries a watched key
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(await cropSlotAfterSaying('cucumber')).toContain('Suyo Long')
  })
})
