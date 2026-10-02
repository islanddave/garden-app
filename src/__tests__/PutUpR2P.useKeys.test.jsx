// Put-Up R2a, lane P — the idempotency key of a use is the INTENT's (BUG-PANTRYUSERETRYDOUBLE-001, both halves).
//
// A use is POST /api/pantry/uses, and the server answers a key it has seen with the use it already wrote. So
// a retry after a lost answer must carry the key the first try carried, or the jar is used twice; and the
// next use must carry a new one, or it is answered with the last.
//   (a) Gave it away: the count panel holds the key of its count and hands it to its host. The host dropped
//       it, so pantryApi minted one per call.
//   (b) The row's Used one / Used it up: no key at all, so again one per call. Now one per intent: kept
//       until that use lands, replaced for the next use, and replaced when the row's action changes (the
//       server would answer "Used it up" under a Used one's key with the Used one).
// THE KEYS ARE COMPARED AS SENT. PantryRowSheet.test.jsx overwrites every key with 'K' before it compares a
// body, so it cannot see either half.
// MUTATIONS (run, see the lane report): drop the panel's key -> "a lost answer, Confirm again" reds; mint a
// key per call on the row -> "Used one fails, tap again" reds; keep the key after a use lands -> "two Used
// ones in a row" reds; keep the key when the action changes -> "Used it up after a failed Used one" reds.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PantryView from '../components/pantry/PantryView.jsx'
import PantryRowSheet from '../components/pantry/PantryRowSheet.jsx'

const FRIDGE = PLACES[2]
const JAR = jarRow({ stock_id: 'jar-1', name: 'Megatron reaper', place: FRIDGE, group_key: FRIDGE.id, group_label: FRIDGE.label,
  method: 'hot_sauce', count_left: 4, count_made: 6 })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USES = '/api/pantry/uses'

// The answer is LOST `failures` times (no status: the request may have landed), then the fake answers.
function wire({ rows = [JAR], failures = 0 } = {}) {
  let left = failures
  fake = pantryFetch({ rows })
  const answer = fake
  const lossy = async (path, options = {}) => {
    if ((options.method || 'GET') === 'POST' && path === USES && left > 0) {
      left -= 1
      fake.state.calls.push({ path, method: 'POST', body: JSON.parse(options.body) })
      throw new Error('Failed to fetch')
    }
    return answer(path, options)
  }
  stableFetch.fn = lossy
}
const uses = () => fake.calls('POST').filter(c => c.path === USES).map(c => c.body)
const keys = () => uses().map(b => b.idempotency_key)

const host = { setRows: null }
function PantryHost({ rows }) {
  const [list, setList] = useState(rows)
  const [recent, setRecent] = useState({})
  host.setRows = setList
  return (
    <PantryView fetch={stableFetch.fn} group="place" onGroupChange={() => {}} rows={list} loading={false} error={false}
      onReload={() => {}} recent={recent} onRecent={setRecent} now={new Date(2026, 9, 1).getTime()} />
  )
}
const action = () => screen.getByTestId('pantry-row-action-put_up:jar-1')

beforeEach(() => { localStorage.clear() })

describe('Gave it away — the count panel\'s key reaches the request', () => {
  function openGive() {
    const handlers = { onClose: vi.fn(), onUsed: vi.fn(), onChanged: vi.fn() }
    render(<PantryRowSheet row={JAR} fetch={stableFetch.fn} {...handlers} />)
    fireEvent.click(screen.getByTestId('row-give'))
    return handlers
  }

  it('a lost answer, Confirm again: the same key twice', async () => {
    wire({ failures: 1 })
    const { onUsed } = openGive()
    fireEvent.click(screen.getByTestId('give-save'))
    await screen.findByTestId('row-sheet-error')
    expect(onUsed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('give-save'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    expect(uses()).toHaveLength(2)
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toBe(keys()[0])
    expect(uses()[1]).toEqual({ preservation_log_id: 'jar-1', count_used: 1, fate: 'given_away', idempotency_key: keys()[0] })
  })

  it('a lost answer, the count changed, Confirm: a new key (the old one would answer the first count)', async () => {
    wire({ failures: 1 })
    const { onUsed } = openGive()
    fireEvent.click(screen.getByTestId('give-save'))
    await screen.findByTestId('row-sheet-error')
    fireEvent.click(screen.getByTestId('give-plus'))
    fireEvent.click(screen.getByTestId('give-save'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    expect(uses().map(b => b.count_used)).toEqual([1, 2])
    expect(keys()[1]).toMatch(UUID)
    expect(keys()[1]).not.toBe(keys()[0])
  })
})

describe('the row\'s Used one / Used it up — one key per intent', () => {
  it('Used one fails, tap again: the same key', async () => {
    wire({ failures: 1 })
    render(<PantryHost rows={[JAR]} />)
    fireEvent.click(action())
    await screen.findByTestId('pantry-row-error-put_up:jar-1')
    fireEvent.click(action())
    await screen.findByTestId('pantry-row-done-put_up:jar-1')
    expect(uses()).toHaveLength(2)
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toBe(keys()[0])
    expect(uses()[1]).toEqual({ preservation_log_id: 'jar-1', count_used: 1, idempotency_key: keys()[0] })
  })

  it('two Used ones in a row carry different keys', async () => {
    wire()
    render(<PantryHost rows={[JAR]} />)
    fireEvent.click(action())
    await screen.findByTestId('pantry-row-done-put_up:jar-1')
    await waitFor(() => expect(action().disabled).toBe(false))
    fireEvent.click(action())
    await waitFor(() => expect(uses()).toHaveLength(2))
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toMatch(UUID)
    expect(keys()[1]).not.toBe(keys()[0])
  })

  it('Used it up after a failed Used one carries its own key: a different use is never answered with the first', async () => {
    wire({ failures: 1 })
    render(<PantryHost rows={[JAR]} />)
    expect(action().textContent).toBe('Used one')
    fireEvent.click(action())
    await screen.findByTestId('pantry-row-error-put_up:jar-1')
    // The list is re-read and one is left: the row's action is now Used it up.
    await act(async () => { host.setRows([{ ...JAR, count_left: 1 }]) })
    expect(action().textContent).toBe('Used it up')
    fireEvent.click(action())
    await screen.findByTestId('pantry-row-done-put_up:jar-1')
    expect(uses()[1]).toMatchObject({ preservation_log_id: 'jar-1', all_remaining: true })
    expect(keys()[1]).toMatch(UUID)
    expect(keys()[1]).not.toBe(keys()[0])
  })

  it('Used it up fails, tap again: the same key', async () => {
    wire({ rows: [{ ...JAR, count_left: 1 }], failures: 1 })
    render(<PantryHost rows={[{ ...JAR, count_left: 1 }]} />)
    fireEvent.click(action())
    await screen.findByTestId('pantry-row-error-put_up:jar-1')
    fireEvent.click(action())
    await screen.findByTestId('pantry-row-done-put_up:jar-1')
    expect(keys()[1]).toBe(keys()[0])
    expect(uses()[1]).toEqual({ preservation_log_id: 'jar-1', all_remaining: true, idempotency_key: keys()[0] })
  })
})
