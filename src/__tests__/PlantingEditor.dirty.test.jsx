// V4-PLANTEDITORDIRTY-001 — proves PlantingEditor's `onDirty` signal, the prop that lets a host join
// the 3-piece dirty contract (EventNew.jsx:950-991) over an editor whose field state it does not own.
//
// The assertions that matter most are the negative ones. This is a SHARED component with three real
// consumers, and the two failure modes it can introduce are both silent: reporting dirty for a
// machine-seeded prefill would hold a service-worker update for anyone who merely opened
// /garden?source_inventory_item_id=… (BUG-STALECLIENT-001's failure mode, deferred rather than
// cancelled precisely so it cannot recur), and failing to release on unmount would strand the host
// holding the gate with no form left on screen to resolve it.
//
// Nothing here spies on setForm or on the internal `dirty` state: the test drives real DOM input
// through the real PlantForm and reads the callback, which is the whole of the contract a host sees.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => null }))
// V4-SOURCEREG-001 — PlantForm now mounts SourcePicker, which reaches Clerk through useApiFetch.
// PlantingEditor takes its own `fetch` as a PROP, so nothing here mocked the module; without this
// every case dies on "useAuth can only be used within <ClerkProvider>", which would read as a dirty
// -signal defect and is the auth layer. Empty list — the picker degrades to "no suggestions" by
// design, and the source wiring is covered in PlantForm.sourcePicker.test.jsx.
// STABLE identities: the real useApiFetch memoises `fetch` on [getToken], and useSources keys its
// effect on that identity. A factory that minted a fresh vi.fn per call re-fires the effect on
// every render and spins the worker to an OOM kill — measured here, 46s to "Worker exited
// unexpectedly", which does NOT read as a mock problem.
const { emptyFetch } = vi.hoisted(() => ({ emptyFetch: async () => [] }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: emptyFetch, getToken: async () => 'tok' }),
  apiFetch: emptyFetch,
}))

import PlantingEditor from '../components/PlantingEditor.jsx'

const PROJECTS = [{ id: 'proj1', name: 'Beds' }]
const PLANT = {
  id: 'p1', name: 'Black Krim', quantity: 2, project_id: 'proj1',
  variety_ref: null, notes: 'leggy', status: 'seed',
}

let fetchSpy

beforeEach(() => {
  fetchSpy = vi.fn((path, opts = {}) => {
    if ((opts.method ?? 'GET') !== 'GET') return Promise.resolve({ id: 'new-1', name: 'Saved' })
    if (path === '/api/locations/with-path') return Promise.resolve([])
    return Promise.resolve(null)
  })
})

async function renderEditor(props = {}) {
  const onDirty = vi.fn()
  let utils
  await act(async () => {
    utils = render(
      <PlantingEditor
        mode="add" plants={[]} projects={PROJECTS} fetch={fetchSpy}
        onDirty={onDirty} {...props}
      />,
    )
  })
  return { onDirty, ...utils }
}

const lastDirty = (onDirty) => onDirty.mock.calls.at(-1)?.[0]

describe('PlantingEditor onDirty', () => {
  it('reports clean on mount — a merely-opened editor must not hold the gate', async () => {
    const { onDirty } = await renderEditor()
    expect(onDirty).toHaveBeenCalled()
    expect(lastDirty(onDirty)).toBe(false)
    expect(onDirty.mock.calls.every(([d]) => d === false)).toBe(true)
  })

  it('flips true on the first keystroke (add mode)', async () => {
    const { onDirty } = await renderEditor()
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(true))
  })

  it('flips true on a non-text field too — a status pick is unsaved work', async () => {
    const { onDirty } = await renderEditor()
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '6' } })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(true))
  })

  it('flips true on edit-mode input, seeded from the planting', async () => {
    const { onDirty } = await renderEditor({ mode: 'edit', plant: PLANT, plants: [PLANT] })
    expect(lastDirty(onDirty)).toBe(false)
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: 'leggy, potted on' } })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(true))
  })

  it('flips back to false on a successful add — the save is the thing that makes it clean', async () => {
    const { onDirty } = await renderEditor()
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(true))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add planting' })) })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(false))
  })

  it('flips back to false on a successful edit save', async () => {
    const { onDirty } = await renderEditor({ mode: 'edit', plant: PLANT, plants: [PLANT] })
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: 'potted on' } })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(true))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(false))
  })

  it('stays dirty when the save FAILS — the typing is still only in the browser', async () => {
    fetchSpy.mockImplementation((path, opts = {}) => {
      if ((opts.method ?? 'GET') !== 'GET') return Promise.reject(new Error('boom'))
      if (path === '/api/locations/with-path') return Promise.resolve([])
      return Promise.resolve(null)
    })
    const { onDirty } = await renderEditor()
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(true))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add planting' })) })
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy())
    expect(lastDirty(onDirty)).toBe(true)
  })

  it('releases on unmount — Cancel/close must not strand the host holding the gate', async () => {
    const { onDirty, unmount } = await renderEditor()
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    await waitFor(() => expect(lastDirty(onDirty)).toBe(true))
    act(() => { unmount() })
    expect(lastDirty(onDirty)).toBe(false)
  })

  it('a packet PREFILL does not report dirty — seeded fields are not the user\'s unsaved work', async () => {
    fetchSpy.mockImplementation((path, opts = {}) => {
      if ((opts.method ?? 'GET') !== 'GET') return Promise.resolve({ id: 'new-1' })
      if (path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/inventory-items/inv-9') {
        return Promise.resolve({
          id: 'inv-9', name: 'Sungold packet', brand: 'Johnny\'s',
          source: 'Spring haul; internal', purchase_date: '2026-02-01',
        })
      }
      return Promise.resolve(null)
    })
    const { onDirty } = await renderEditor({ sourceInventoryItemId: 'inv-9' })
    // The prefill genuinely landed — otherwise this asserts nothing.
    await waitFor(() => expect(screen.getByLabelText(/Name/i).value).toBe('Sungold packet'))
    expect(onDirty.mock.calls.every(([d]) => d === false)).toBe(true)
  })

  it('a variety deep-link prefill does not report dirty either', async () => {
    fetchSpy.mockImplementation((path, opts = {}) => {
      if ((opts.method ?? 'GET') !== 'GET') return Promise.resolve({ id: 'new-1' })
      if (path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/varieties/var-3') return Promise.resolve({ id: 'var-3', name: 'Sungold' })
      return Promise.resolve(null)
    })
    const { onDirty } = await renderEditor({ varietyId: 'var-3' })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/varieties/var-3'))
    expect(onDirty.mock.calls.every(([d]) => d === false)).toBe(true)
  })

  it('a consumer that passes NO onDirty still renders, types and saves', async () => {
    const onCreated = vi.fn()
    await act(async () => {
      render(
        <PlantingEditor mode="add" plants={[]} projects={PROJECTS} fetch={fetchSpy} onCreated={onCreated} />,
      )
    })
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    expect(screen.getByLabelText(/Name/i).value).toBe('Sungold')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add planting' })) })
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it('survives an INLINE-ARROW onDirty without a spurious release on every render', async () => {
    // The ref indirection exists for this: with `onDirty` in the effect deps, a new arrow each
    // render would fire onDirty(false) → onDirty(true) on every keystroke, and a release NOTIFIES
    // reloadGate's listeners rather than being inert.
    const seen = []
    function Host() {
      const [n, setN] = React.useState(0)
      return (
        <>
          <button onClick={() => setN(v => v + 1)}>rerender</button>
          <span data-testid="n">{n}</span>
          <PlantingEditor
            mode="add" plants={[]} projects={PROJECTS} fetch={fetchSpy}
            onDirty={d => seen.push(d)}
          />
        </>
      )
    }
    await act(async () => { render(<Host />) })
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    await waitFor(() => expect(seen.at(-1)).toBe(true))
    const afterTyping = seen.length
    act(() => { fireEvent.click(screen.getByText('rerender')) })
    expect(screen.getByTestId('n').textContent).toBe('1')
    expect(seen.length).toBe(afterTyping)   // a bare re-render reports nothing at all
    expect(seen.at(-1)).toBe(true)
  })
})
