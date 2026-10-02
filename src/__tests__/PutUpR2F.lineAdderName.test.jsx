// Put-Up R2a, lane F (D3, ruling h; PLAN-R2-V4-RULINGS F-1) — LineAdder's ONE new optional prop,
// `initialName`: the text the name field opens holding. Put it up unmounts a row's adder when the row's
// details close; it hands the name that was typed and not added back through this prop when the adder
// mounts again, so the name is hidden and never dropped.
//
// THE CONTRACT THIS FILE PINS: with the prop ABSENT the adder is exactly what it was — it opens empty, its
// first report is null, it asks the search nothing at open — and none of the hosts that hold no name pass
// it. (Their own suites — PutUpWhatWentIn, PutUpHowItWasMade, PutUpUxB.lineAdder, PutUpUxB.batchDetail —
// pass unedited, which is the other half of the proof.)
// MUTATIONS (each run, each red here):
//   ignore the prop (the field always opens empty)                -> "with a name: the field opens holding it…"
//   String(initialName) with no guard                             -> "absent, undefined, null or empty…" (the null arm)
//   follow the prop on every render                               -> "it is read once, at mount…"
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import { P } from '../lib/constants.js'
import LineAdder from '../components/putup/LineAdder.jsx'

const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const name = () => screen.getByTestId('line-add-name')
const submit = () => screen.getByTestId('line-add-submit')
const searches = () => fetchMock.mock.calls.filter(([p]) => String(p).includes('line-search')).map(([p]) => p)
// Past the search's debounce (250 ms), with the answer's promise settled.
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(400) })

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  fetchMock.mockImplementation(() => Promise.resolve({ plantings: [], put_ups: [] }))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('LineAdder — `initialName` absent: the adder is what it always was', () => {
  it.each([
    ['absent', {}], ['undefined', { initialName: undefined }], ['null', { initialName: null }], ['empty', { initialName: '' }],
  ])('absent, undefined, null or empty: the field opens empty, the first report is null, nothing is searched (%s)', async (_, props) => {
    const onPendingChange = vi.fn()
    render(<LineAdder onAdd={vi.fn()} onPendingChange={onPendingChange} {...props} />)
    expect(name().value).toBe('')
    expect(onPendingChange.mock.calls).toEqual([[null]])
    expect(submit().style.backgroundColor).toBe('transparent')            // nothing held: the quiet Add
    await settle()
    expect(searches()).toEqual([])
    expect(screen.queryByTestId('line-add-hits')).toBeNull()
    expect(onPendingChange.mock.calls).toEqual([[null]])
  })

  // The hosts that hold no name for their adder. A new caller of the prop is a decision, not a drift.
  it('What went in, How it was made and a sitting on batch detail mount the adder and pass no initialName', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../components/putup')
    const src = (f) => readFileSync(resolve(root, f), 'utf8')
    for (const f of ['WhatWentIn.jsx', 'HowItWasMadeSheet.jsx', 'BatchDetailView.jsx']) {
      expect([f, src(f).includes('<LineAdder')]).toEqual([f, true])
      expect([f, src(f).includes('initialName')]).toEqual([f, false])
    }
  })
})

describe('LineAdder — `initialName`: the name field opens holding it', () => {
  it('with a name: the field opens holding it, the first report is that name, Add is filled, and no focus moves', async () => {
    const onPendingChange = vi.fn()
    render(<LineAdder onAdd={vi.fn()} onPendingChange={onPendingChange} initialName="garlic" />)
    expect(name().value).toBe('garlic')
    // Never null first: a host that takes a null for "cleared" would drop the name it just handed in.
    expect(onPendingChange.mock.calls).toEqual([['garlic']])
    expect(submit().style.backgroundColor).toBe(toRgb(P.green))
    expect(document.activeElement).toBe(document.body)
    await settle()
    expect(document.activeElement).toBe(document.body)
  })

  it('it is typed text again: searched as typed, and added as a typed line', async () => {
    const onAdd = vi.fn().mockResolvedValue(true)
    render(<LineAdder onAdd={onAdd} initialName="garlic scapes" />)
    await settle()
    expect(searches()).toEqual(['/api/kitchen-batches/line-search?q=garlic%20scapes'])
    expect(screen.getByTestId('line-add-typed').textContent).toBe('Use “garlic scapes” as it is')
    await act(async () => { fireEvent.click(submit()) })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0]).toMatchObject({ input_kind: 'other', label: 'garlic scapes' })
    expect(name().value).toBe('')
  })

  it('it is read once, at mount: a later value never overwrites what is in the field', () => {
    const { rerender } = render(<LineAdder onAdd={vi.fn()} initialName="garlic" />)
    fireEvent.change(name(), { target: { value: 'garlic and onion' } })
    rerender(<LineAdder onAdd={vi.fn()} initialName="shallot" />)
    expect(name().value).toBe('garlic and onion')
    fireEvent.change(name(), { target: { value: '' } })
    rerender(<LineAdder onAdd={vi.fn()} initialName="shallot" />)
    expect(name().value).toBe('')
  })

  it('clearing it reports null, as clearing a typed name always did', () => {
    const onPendingChange = vi.fn()
    render(<LineAdder onAdd={vi.fn()} onPendingChange={onPendingChange} initialName="garlic" />)
    fireEvent.change(name(), { target: { value: '' } })
    expect(onPendingChange.mock.calls.map(c => c[0])).toEqual(['garlic', null])
  })
})
