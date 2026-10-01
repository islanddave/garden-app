// Put-Up UX pass R1, lane B — the line adder (LineAdder.jsx), on its own:
//   · `onPendingChange(text | null)`, the signal a sheet with its own Save reads so a typed line is never
//     dropped without a word (D2);
//   · Add is FILLED while the adder holds a name or a picked match, and the secondary button when empty;
//   · the unit chips sit 8px apart and keep their own size (F16);
//   · its quiet link is 48px tall.
// Each assertion names the mutation that reds it. CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import { P } from '../lib/constants.js'
import LineAdder, { addFirstWords } from '../components/putup/LineAdder.jsx'

// jsdom hands an inline colour back as rgb(): compare converted values, never raw hex.
const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const FILLED = toRgb(P.green)
const HITS = {
  plantings: [{ plant_id: 'p-mega', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v-mega', recent_picks: [] }],
  put_ups: [],
}
const name = () => screen.getByTestId('line-add-name')
const submit = () => screen.getByTestId('line-add-submit')
const add = () => act(async () => { fireEvent.click(submit()) })

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => Promise.resolve(String(path).includes('line-search') ? HITS : null))
})

describe('onPendingChange — the name the adder holds and has not added', () => {
  // MUTATION: report the raw text (no trim) -> the '  garlic ' arm reds; never report null on clear -> the
  // third call reds, and a host would stay stopped on a name that is no longer there.
  it('reports the typed name, trimmed; null again once the field is cleared', () => {
    const onPendingChange = vi.fn()
    render(<LineAdder onAdd={vi.fn()} onPendingChange={onPendingChange} />)
    expect(onPendingChange.mock.calls).toEqual([[null]])                 // at open: nothing pending
    fireEvent.change(name(), { target: { value: '  garlic ' } })
    expect(onPendingChange).toHaveBeenLastCalledWith('garlic')
    fireEvent.change(name(), { target: { value: '   ' } })
    expect(onPendingChange).toHaveBeenLastCalledWith(null)
    expect(onPendingChange.mock.calls.map(c => c[0])).toEqual([null, 'garlic', null])
  })

  it('reports a picked match by its name', async () => {
    const onPendingChange = vi.fn()
    render(<LineAdder onAdd={vi.fn()} onPendingChange={onPendingChange} />)
    fireEvent.change(name(), { target: { value: 'meg' } })
    await waitFor(() => expect(screen.getByTestId('line-add-hits')).toBeTruthy())
    fireEvent.click(screen.getByTestId('line-add-hit-planting:p-mega'))
    expect(onPendingChange).toHaveBeenLastCalledWith('Megatron jalapeño')
  })

  // MUTATION: leave the pending name set after a landed Add -> the last call is still 'onion'.
  it('is null again once the line is added — and stays what it was when the Add is refused', async () => {
    const onPendingChange = vi.fn()
    const onAdd = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<LineAdder onAdd={onAdd} onPendingChange={onPendingChange} />)
    fireEvent.change(name(), { target: { value: 'onion' } })
    await add()
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onPendingChange).toHaveBeenLastCalledWith('onion')          // refused: what was typed is still here
    await add()
    expect(onAdd).toHaveBeenCalledTimes(2)
    expect(onPendingChange).toHaveBeenLastCalledWith(null)
    expect(name().value).toBe('')
  })

  // Put it up mounts an adder on demand and unmounts it after each Add; a host left holding the last name
  // would refuse its own Save over an adder that is no longer on screen.
  // MUTATION: drop the unmount report -> the last call is 'garlic'.
  it('reports null when the adder goes away with a name still in it', () => {
    const onPendingChange = vi.fn()
    const { unmount } = render(<LineAdder onAdd={vi.fn()} onPendingChange={onPendingChange} />)
    fireEvent.change(name(), { target: { value: 'garlic' } })
    expect(onPendingChange).toHaveBeenLastCalledWith('garlic')
    unmount()
    expect(onPendingChange).toHaveBeenLastCalledWith(null)
  })

  it('is optional: an adder with no listener types and adds as it always did', async () => {
    const onAdd = vi.fn().mockResolvedValue(true)
    render(<LineAdder onAdd={onAdd} />)
    fireEvent.change(name(), { target: { value: 'onion' } })
    await add()
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0]).toMatchObject({ input_kind: 'other', label: 'onion' })
  })

  it('the line a stopped Save says is one sentence, with the name in it', () => {
    expect(addFirstWords('garlic')).toBe('Add “garlic” first — or clear it.')
  })
})

describe('Add — filled once there is something to add, the secondary button while the adder is empty', () => {
  // MUTATION: keep Add filled always (the shipped hand-styled button) -> the two empty arms red;
  // make it secondary always -> the two holding arms red.
  it('is secondary at open, filled with a typed name, secondary again when the name is cleared', () => {
    render(<LineAdder onAdd={vi.fn()} />)
    expect(submit().style.backgroundColor).toBe('transparent')
    expect(submit().textContent).toBe('Add')
    fireEvent.change(name(), { target: { value: 'g' } })
    expect(submit().style.backgroundColor).toBe(FILLED)
    fireEvent.change(name(), { target: { value: '' } })
    expect(submit().style.backgroundColor).toBe('transparent')
  })

  it('is filled with a picked match, and with the Water preset', async () => {
    const { rerender } = render(<LineAdder onAdd={vi.fn()} />)
    fireEvent.change(name(), { target: { value: 'meg' } })
    await waitFor(() => expect(screen.getByTestId('line-add-hits')).toBeTruthy())
    fireEvent.click(screen.getByTestId('line-add-hit-planting:p-mega'))
    expect(submit().style.backgroundColor).toBe(FILLED)
    rerender(<LineAdder onAdd={vi.fn()} preset={{ role: 'water', label: 'Water' }} presetSeq={1} />)
    expect(name().value).toBe('Water')
    expect(submit().style.backgroundColor).toBe(FILLED)
  })

  // It is the SAME button in both weights: 48px tall, full width, its testid and its label, and it still
  // refuses to take focus on mousedown (that blur would un-pin it mid-tap).
  it('keeps its size, its label and its mousedown guard in both weights', () => {
    render(<LineAdder onAdd={vi.fn()} addLabel="Add it" />)
    for (const text of ['', 'garlic']) {
      fireEvent.change(name(), { target: { value: text } })
      expect(submit().style.minHeight).toBe('48px')
      expect(submit().style.width).toBe('100%')
      expect(submit().textContent).toBe('Add it')
      expect(fireEvent.mouseDown(submit())).toBe(false)               // false = preventDefault was called
    }
    expect(screen.getAllByTestId('line-add-submit')).toHaveLength(1)
  })

  it('says "Adding…" and cannot be tapped twice while the write is out', async () => {
    let land
    const onAdd = vi.fn(() => new Promise(r => { land = r }))
    render(<LineAdder onAdd={onAdd} />)
    fireEvent.change(name(), { target: { value: 'onion' } })
    fireEvent.click(submit())
    await waitFor(() => expect(submit().textContent).toBe('Adding…'))
    expect(submit().disabled).toBe(true)
    fireEvent.click(submit())
    expect(onAdd).toHaveBeenCalledTimes(1)
    await act(async () => { land(true) })
    expect(submit().textContent).toBe('Add')
  })
})

describe('tap targets (F16)', () => {
  // The chip is the frozen primitive's (44 wide, 48 tall); the 8px is this row's own.
  // MUTATION: put the row's gap back to 6 -> red.
  it('the unit chips are 8px apart and keep their own size', () => {
    render(<LineAdder onAdd={vi.fn()} />)
    const row = screen.getByRole('radiogroup', { name: 'Unit' })
    expect(row.style.gap).toBe('8px')
    const chips = [...row.querySelectorAll('[role="radio"]')]
    expect(chips.map(c => c.textContent)).toEqual(['g', 'oz', 'lb', 'ml', 'count'])
    expect(chips.every(c => c.style.minHeight === '48px' && c.style.minWidth === '44px')).toBe(true)
  })

  it('its quiet link is 48px tall', () => {
    render(<LineAdder onAdd={vi.fn()} />)
    expect(screen.getByTestId('line-add-more').style.minHeight).toBe('48px')
  })
})
