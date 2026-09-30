// Put-Up B′ release 2 — the Pantry row sheet (V4 §2.5 "Row sheet", §6.3), every action on the wire:
// Went bad · Gave it away · Move it (jar route / item PATCH) · Edit (Remove inside, two-step, the
// server's refusal shown) · Next time… (batch noted row / batchless notes_append) · How it was made →
// (only when handed in). Rendered directly against the contract-shaped fake.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null }) }))

import PantryRowSheet, { HOUSE_DETAIL_TEXT } from '../components/pantry/PantryRowSheet.jsx'

const JAR = jarRow({ stock_id: 'jar-1', name: 'Megatron reaper', place: PLACES[2], method: 'hot_sauce', count_left: 3, batch_id: null })
const BATCH_JAR = jarRow({ stock_id: 'jar-2', name: 'Petri Dish sauce', place: PLACES[2], method: 'hot_sauce', count_left: 2, batch_id: 'kb-7' })
const ITEM = itemRow({ stock_id: 'item-1', name: 'Oat milk', place: PLACES[2] })

function wire(opts = {}) {
  fake = pantryFetch({ rows: [JAR, BATCH_JAR, ITEM], ...opts })
  stableFetch.fn = fake
}
const JarEditor = ({ rec, onSave, onCancel, err }) => (
  <div data-testid="jar-editor">
    <span>{rec.label}</span>
    {err && <span role="alert">{typeof err === 'string' ? err : err.text}</span>}
    <button type="button" onClick={() => onSave({ notes: 'the good one' })}>Save</button>
    <button type="button" onClick={onCancel}>Cancel</button>
  </div>
)
function renderSheet(row, props = {}) {
  const handlers = { onClose: vi.fn(), onUsed: vi.fn(), onChanged: vi.fn(), ...props }
  const view = render(<PantryRowSheet row={row} fetch={stableFetch.fn} JarEditor={JarEditor} {...handlers} />)
  return { ...view, ...handlers }
}
const posts = (path) => fake.calls('POST').filter(c => c.path === path)

beforeEach(() => { wire(); localStorage.clear() })

describe('a put-up\'s sheet', () => {
  it('offers Went bad · Gave it away · Move it · Edit · Next time…, and no How it was made → unless handed in', async () => {
    renderSheet(JAR)
    expect(screen.getByRole('dialog', { name: 'Megatron reaper' })).toBeTruthy()
    const actions = ['row-went-bad', 'row-give', 'row-move', 'row-edit', 'row-next']
    for (const a of actions) expect(screen.getByTestId(a)).toBeTruthy()
    expect(screen.queryByTestId('row-how')).toBeNull()
  })

  it('Went bad is ONE use of what is left, fate discarded, and reports back for the in-place Undo', async () => {
    const { onUsed, onClose } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    expect(posts('/api/pantry/uses').map(c => ({ ...c.body, idempotency_key: 'K' }))).toEqual([
      { idempotency_key: 'K', preservation_log_id: 'jar-1', all_remaining: true, fate: 'discarded' }])
    expect(onUsed.mock.calls[0][0]).toMatchObject({ action: 'went_bad', use: { id: expect.any(String) } })
    expect(onClose).toHaveBeenCalled()
  })

  it('Gave it away: a count starting at 1, capped at what is left, fate given_away', async () => {
    const { onUsed } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-give'))
    expect(screen.getByTestId('give-count').value).toBe('1')
    expect(screen.getByTestId('give-minus').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('give-plus'))
    fireEvent.click(screen.getByTestId('give-plus'))
    fireEvent.click(screen.getByTestId('give-plus'))       // past 3 left: capped
    expect(screen.getByTestId('give-count').value).toBe('3')
    expect(screen.getByTestId('give-plus').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('give-minus'))
    fireEvent.click(screen.getByTestId('give-save'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    expect({ ...posts('/api/pantry/uses')[0].body, idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', preservation_log_id: 'jar-1', count_used: 2, fate: 'given_away' })
  })

  it('a refused use says why in the server\'s words and keeps the sheet open', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': () => { throw apiError(409, { error: 'None are left in that one.', code: 'only_n_left', n: 0 }) } } })
    const { onUsed, onClose } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    expect((await screen.findByTestId('row-sheet-error')).textContent).toBe('None are left — nothing was changed.')
    expect(onUsed).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Move it posts the shipped move route (place + When, default Today)', async () => {
    const { onChanged } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-1'))
    expect(screen.getByTestId('move-when-today').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('move-save'))
    await waitFor(() => expect(posts('/api/preservation/jar-1/move')).toHaveLength(1))
    expect(posts('/api/preservation/jar-1/move')[0].body.place).toEqual({ id: 'loc-1' })
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('moved'))
  })

  it('Edit opens the shipped jar editor on the full jar and writes ONE PATCH', async () => {
    const { onChanged } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-edit'))
    await screen.findByTestId('jar-editor')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('edited'))
    expect(fake.calls('PATCH').map(c => [c.path, c.body])).toEqual([['/api/preservation/jar-1', { notes: 'the good one' }]])
  })

  it('Remove is inside Edit, two-step, and a refusal shows the server\'s reason with nothing removed', async () => {
    wire({ overrides: { 'DELETE /api/preservation/*': () => { throw apiError(409, { error: '1 was used — mark the rest Went bad, or undo that use →', code: 'jar_has_uses' }) } } })
    const { onChanged } = renderSheet(JAR)
    expect(screen.queryByTestId('jar-edit-remove')).toBeNull()
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.click(await screen.findByTestId('jar-edit-remove'))
    expect(fake.calls('DELETE')).toHaveLength(0)                     // step one writes nothing
    fireEvent.click(screen.getByTestId('jar-edit-remove-confirm'))
    expect((await screen.findByTestId('jar-edit-error')).textContent).toBe('1 was used — mark the rest Went bad, or undo that use →')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('Remove confirmed on a jar with no uses is a DELETE and closes', async () => {
    const { onChanged } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.click(await screen.findByTestId('jar-edit-remove'))
    fireEvent.click(screen.getByTestId('jar-edit-remove-confirm'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('removed'))
    expect(fake.calls('DELETE').map(c => c.path)).toEqual(['/api/preservation/jar-1'])
  })

  it('Next time… on a batchless jar appends a dated line to its notes', async () => {
    renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-next'))
    fireEvent.change(screen.getByTestId('next-text'), { target: { value: 'less vinegar' } })
    fireEvent.click(screen.getByTestId('next-save'))
    await waitFor(() => expect(fake.calls('PATCH')).toHaveLength(1))
    const [call] = fake.calls('PATCH')
    expect(call.path).toBe('/api/preservation/jar-1')
    expect(Object.keys(call.body)).toEqual(['notes_append'])
    expect(call.body.notes_append).toMatch(/^Next time \(\d{4}-\d{2}-\d{2}\): less vinegar$/)
  })

  it('Next time… on a batch jar writes the batch\'s noted stage row', async () => {
    renderSheet(BATCH_JAR)
    fireEvent.click(screen.getByTestId('row-next'))
    fireEvent.change(screen.getByTestId('next-text'), { target: { value: 'more garlic' } })
    fireEvent.click(screen.getByTestId('next-save'))
    await waitFor(() => expect(posts('/api/kitchen-batches/kb-7/stages')).toHaveLength(1))
    expect(posts('/api/kitchen-batches/kb-7/stages')[0].body).toEqual({ stage_kind: 'noted', note: 'more garlic' })
    expect(fake.calls('PATCH')).toHaveLength(0)
  })

  it('How it was made → renders only when a callback is handed in, and hands it the row', async () => {
    const onHowItWasMade = vi.fn()
    renderSheet(JAR, { onHowItWasMade })
    fireEvent.click(screen.getByTestId('row-how'))
    expect(onHowItWasMade).toHaveBeenCalledWith(JAR)
  })

  it('a house-estimate date carries the V4 §3.2 detail line in the sheet', async () => {
    renderSheet(jarRow({ stock_id: 'jar-c', name: 'Candied ginger', method: 'candy', discard: { date: '2026-12-01', basis: 'house', status: 'ok' } }))
    expect(screen.getByTestId('row-sheet-house').textContent).toBe(HOUSE_DETAIL_TEXT)
  })
})

describe('a bought item\'s sheet', () => {
  it('offers Move it and Edit — no uses, no Next time…', () => {
    renderSheet(ITEM)
    expect(screen.getByTestId('row-move')).toBeTruthy()
    expect(screen.getByTestId('row-edit')).toBeTruthy()
    for (const a of ['row-went-bad', 'row-give', 'row-next', 'row-how']) expect(screen.queryByTestId(a)).toBeNull()
  })

  it('Move it is a PATCH of storage_location_id with no When; a template place is made first', async () => {
    const { onChanged } = renderSheet(ITEM)
    fireEvent.click(screen.getByTestId('row-move'))
    await screen.findByTestId('move-place-id:loc-1')
    expect(screen.queryByTestId('move-when-today')).toBeNull()
    fireEvent.click(screen.getByTestId('move-place-new:pantry:pantry shelf'))
    fireEvent.click(screen.getByTestId('move-save'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('moved'))
    expect(posts('/api/storage-locations').map(c => c.body)).toEqual([{ label: 'Pantry shelf', kind: 'pantry' }])
    expect(fake.calls('PATCH').map(c => [c.path, c.body])).toEqual([['/api/pantry/items/item-1', { storage_location_id: 'loc-new-1' }]])
  })

  it('Edit sends ONE PATCH of only what changed (a date from the label, when you got it)', async () => {
    const { onChanged } = renderSheet(ITEM)
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.change(screen.getByTestId('item-edit-useby'), { target: { value: '2026-10-09' } })
    fireEvent.change(screen.getByTestId('item-edit-acquired'), { target: { value: '2026-09-20' } })
    fireEvent.click(screen.getByTestId('item-edit-save'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('edited'))
    expect(fake.calls('PATCH').map(c => [c.path, c.body])).toEqual([['/api/pantry/items/item-1',
      { acquired_at: '2026-09-20', acquired_precision: 'day', use_by_target: '2026-10-09' }]])
  })

  it('an untouched Edit writes nothing', async () => {
    renderSheet(ITEM)
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.click(screen.getByTestId('item-edit-save'))
    expect(fake.calls('PATCH')).toHaveLength(0)
    expect(screen.queryByTestId('item-edit-panel')).toBeNull()
  })

  it('Remove is two-step inside Edit, a soft DELETE; a refusal shows the server\'s reason', async () => {
    wire({ overrides: { 'DELETE /api/pantry/items/*': () => { throw apiError(409, { error: 'That one is in a batch — take the line out first.', code: 'item_in_batch' }) } } })
    renderSheet(ITEM)
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.click(screen.getByTestId('item-edit-remove'))
    fireEvent.click(screen.getByTestId('item-edit-remove-confirm'))
    expect((await screen.findByTestId('item-edit-error')).textContent).toBe('That one is in a batch — take the line out first.')
    expect(fake.calls('DELETE').map(c => c.path)).toEqual(['/api/pantry/items/item-1'])
  })
})
