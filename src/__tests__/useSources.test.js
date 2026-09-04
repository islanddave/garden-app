// V4-SOURCEREG-001 / V5-SOURCEKIND-001 — the provenance vocabulary hooks.
// Pins the three properties the house pattern (useCropTypes) exists to guarantee: non-fatal
// degradation, deferral via `enabled`, and a local insert that reproduces the server's ORDER BY.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
import { useSources, useSourceKinds } from '../hooks/useSources.js'

const SOURCES = [
  { id: 'src-baker', name: 'Baker Creek', kind: 'seed_company', locality: 'Mansfield, MO' },
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME' },
]
const KINDS = [
  { slug: 'seed_company', display_name: 'Seed company', sort_order: 10 },
  { slug: 'nursery', display_name: 'Nursery', sort_order: 20 },
]

beforeEach(() => { fetchSpy.mockReset() })

describe('useSources', () => {
  it('loads the registry from /api/varieties/sources', async () => {
    fetchSpy.mockResolvedValueOnce(SOURCES)
    const { result } = renderHook(() => useSources())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sources.map(s => s.id)).toEqual(['src-baker', 'src-fedco'])
    expect(fetchSpy).toHaveBeenCalledWith('/api/varieties/sources')
  })

  it('degrades to [] on rejection, on a non-Promise return, and on a non-array body', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    const a = renderHook(() => useSources())
    await waitFor(() => expect(a.result.current.loading).toBe(false))
    expect(a.result.current.sources).toEqual([])

    fetchSpy.mockReturnValueOnce(undefined)
    const b = renderHook(() => useSources())
    await waitFor(() => expect(b.result.current.loading).toBe(false))
    expect(b.result.current.sources).toEqual([])

    fetchSpy.mockResolvedValueOnce({ error: 'nope' })
    const c = renderHook(() => useSources())
    await waitFor(() => expect(c.result.current.loading).toBe(false))
    expect(c.result.current.sources).toEqual([])
  })

  it('two instances mounted together issue ONE GET, and both get the list', async () => {
    // The real shape: an edit form for a row that already has an origin mounts the origin picker
    // and the acquired-from picker in the same commit. The fetch is held open so the second mount
    // lands INSIDE the window — resolving first would make this pass whether or not it coalesces.
    let resolveIt
    fetchSpy.mockReturnValueOnce(new Promise(r => { resolveIt = r }))
    const a = renderHook(() => useSources())
    const b = renderHook(() => useSources())
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await act(async () => { resolveIt(SOURCES) })
    await waitFor(() => expect(a.result.current.loading).toBe(false))
    await waitFor(() => expect(b.result.current.loading).toBe(false))
    // The joiner gets the SAME list, not an empty degrade — sharing the promise must not cost the
    // second instance its data.
    expect(a.result.current.sources.map(s => s.id)).toEqual(['src-baker', 'src-fedco'])
    expect(b.result.current.sources.map(s => s.id)).toEqual(['src-baker', 'src-fedco'])
  })

  it('the window CLOSES on settle — a later mount re-fetches rather than replaying a cache', async () => {
    // The negative control for the test above. Without it, "one GET" would also pass if the entry
    // were never cleared, which would be a cache serving a list that outlived its request.
    fetchSpy.mockResolvedValueOnce(SOURCES)
    const a = renderHook(() => useSources())
    await waitFor(() => expect(a.result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce([SOURCES[0]])
    const b = renderHook(() => useSources())
    await waitFor(() => expect(b.result.current.loading).toBe(false))

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(b.result.current.sources.map(s => s.id)).toEqual(['src-baker'])
  })

  it('a rejection reaches every joiner — both degrade, neither hangs', async () => {
    let rejectIt
    fetchSpy.mockReturnValueOnce(new Promise((_, rej) => { rejectIt = rej }))
    const a = renderHook(() => useSources())
    const b = renderHook(() => useSources())
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await act(async () => { rejectIt(new Error('boom')) })
    await waitFor(() => expect(a.result.current.loading).toBe(false))
    await waitFor(() => expect(b.result.current.loading).toBe(false))
    expect(a.result.current.sources).toEqual([])
    expect(b.result.current.sources).toEqual([])
  })

  it('enabled:false never fetches and still resolves loading', async () => {
    const { result } = renderHook(() => useSources({ enabled: false }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('inserts a created source locally in NAME order, matching the server ORDER BY', async () => {
    fetchSpy.mockResolvedValueOnce(SOURCES)
    const { result } = renderHook(() => useSources())
    await waitFor(() => expect(result.current.sources.length).toBe(2))

    const created = { id: 'src-comstock', name: 'Comstock Ferre', kind: 'seed_company', locality: 'Wethersfield, CT' }
    fetchSpy.mockResolvedValueOnce(created)
    let res
    await act(async () => { res = await result.current.createSource({ name: 'Comstock Ferre' }) })

    expect(res).toEqual({ source: created })
    // Between Baker and Fedco — not appended at the tail.
    expect(result.current.sources.map(s => s.id)).toEqual(['src-baker', 'src-comstock', 'src-fedco'])
    expect(fetchSpy).toHaveBeenLastCalledWith('/api/varieties/sources', {
      method: 'POST', body: JSON.stringify({ name: 'Comstock Ferre' }),
    })
  })

  it('a restore (same id, new spelling) replaces the row rather than duplicating it', async () => {
    fetchSpy.mockResolvedValueOnce(SOURCES)
    const { result } = renderHook(() => useSources())
    await waitFor(() => expect(result.current.sources.length).toBe(2))

    fetchSpy.mockResolvedValueOnce({ ...SOURCES[1], name: 'FEDCO Seeds', restored: true })
    await act(async () => { await result.current.createSource({ name: 'FEDCO Seeds' }) })

    expect(result.current.sources.map(s => s.id)).toEqual(['src-baker', 'src-fedco'])
    expect(result.current.sources.find(s => s.id === 'src-fedco').name).toBe('FEDCO Seeds')
  })

  it('surfaces a 409 steer as { error, existing, reason } rather than throwing', async () => {
    fetchSpy.mockResolvedValueOnce(SOURCES)
    const { result } = renderHook(() => useSources())
    await waitFor(() => expect(result.current.sources.length).toBe(2))

    const err = Object.assign(new Error('A source named Fedco Seeds already exists'), {
      body: { reason: 'exists', existing: SOURCES[1] },
    })
    fetchSpy.mockRejectedValueOnce(err)
    let res
    await act(async () => { res = await result.current.createSource({ name: 'fedco  seeds' }) })

    expect(res.reason).toBe('exists')
    expect(res.existing.id).toBe('src-fedco')
    expect(res.error).toBe('A source named Fedco Seeds already exists')
    // The list is untouched by a steer — nothing was created.
    expect(result.current.sources.map(s => s.id)).toEqual(['src-baker', 'src-fedco'])
  })
})

describe('useSourceKinds', () => {
  it('loads from /api/varieties/source-kinds', async () => {
    fetchSpy.mockResolvedValueOnce(KINDS)
    const { result } = renderHook(() => useSourceKinds())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sourceKinds.map(k => k.slug)).toEqual(['seed_company', 'nursery'])
  })

  it('enabled:false never fetches — the mint-panel deferral', async () => {
    const { result } = renderHook(() => useSourceKinds({ enabled: false }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('inserts a minted kind at the TAIL by sort_order, not at the head', async () => {
    fetchSpy.mockResolvedValueOnce(KINDS)
    const { result } = renderHook(() => useSourceKinds())
    await waitFor(() => expect(result.current.sourceKinds.length).toBe(2))

    // The server assigns max+10 precisely so a minted kind lands BELOW the common seeded ones.
    const created = { slug: 'seed_library', display_name: 'Seed Library', sort_order: 30 }
    fetchSpy.mockResolvedValueOnce(created)
    await act(async () => { await result.current.createSourceKind({ display_name: 'Seed Library' }) })

    expect(result.current.sourceKinds.map(k => k.slug)).toEqual(['seed_company', 'nursery', 'seed_library'])
  })

  it('POSTs display_name only — the slug is server-derived and must never be sent', async () => {
    fetchSpy.mockResolvedValueOnce(KINDS)
    const { result } = renderHook(() => useSourceKinds())
    await waitFor(() => expect(result.current.sourceKinds.length).toBe(2))

    fetchSpy.mockResolvedValueOnce({ slug: 'plant_swap', display_name: 'Plant swap', sort_order: 30 })
    await act(async () => { await result.current.createSourceKind({ display_name: 'Plant swap' }) })

    const [path, init] = fetchSpy.mock.calls.at(-1)
    expect(path).toBe('/api/varieties/source-kinds')
    expect(JSON.parse(init.body)).toEqual({ display_name: 'Plant swap' })
  })

  it('surfaces a label-fold steer as { error, existing, reason }', async () => {
    fetchSpy.mockResolvedValueOnce(KINDS)
    const { result } = renderHook(() => useSourceKinds())
    await waitFor(() => expect(result.current.sourceKinds.length).toBe(2))

    const err = Object.assign(new Error('“Seed Company” already exists'), {
      body: { reason: 'label', existing: KINDS[0] },
    })
    fetchSpy.mockRejectedValueOnce(err)
    let res
    await act(async () => { res = await result.current.createSourceKind({ display_name: 'Seed Company' }) })

    expect(res.reason).toBe('label')
    expect(res.existing.slug).toBe('seed_company')
    expect(result.current.sourceKinds.map(k => k.slug)).toEqual(['seed_company', 'nursery'])
  })
})
