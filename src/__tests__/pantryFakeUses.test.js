// Put-Up UX pass R1 (prep) — src/__tests__/helpers/pantryFake.js: its POST /api/pantry/uses stand-in judges
// the body with the Lambda's OWN validateUse, so a client test cannot be green on a body the server answers
// 400 to. The fake's stock ids are short words, not uuids; that one field is stood in for, and every other
// rule of the validator is applied to the body exactly as it was sent.
// MUTATION: drop the validateUse call from the fake -> every "refuses" row reds.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import { pantryFetch, jarRow } from './helpers/pantryFake.js'
import { validateUse } from '../../lambda/preservation/pantryUses.js'

const K = '11111111-1111-4222-8333-444444444444'
const REAL_ID = '99999999-aaaa-4bbb-8ccc-000000000004'
const fake = () => pantryFetch({ rows: [jarRow({ stock_id: 'jar-1', count_left: 4 })] })
const post = (f, body) => f('/api/pantry/uses', { method: 'POST', body: JSON.stringify(body) })

describe('pantryFake — POST /api/pantry/uses is judged by the Lambda\'s own validateUse', () => {
  it('answers a body the server accepts exactly as it did before', async () => {
    const f = fake()
    expect(await post(f, { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 1 }))
      .toEqual({ use: { id: 'use-1', preservation_log_id: 'jar-1', count_used: 1, fate: null }, jar: { id: 'jar-1', remaining_count: 3 } })
    expect(await post(f, { idempotency_key: K, preservation_log_id: 'jar-1', all_remaining: true }))
      .toEqual({ use: { id: 'use-2', preservation_log_id: 'jar-1', count_used: 4, fate: null }, jar: { id: 'jar-1', remaining_count: 0 } })
    expect(await post(f, { idempotency_key: K, preservation_log_id: 'jar-1', all_remaining: true, fate: 'discarded' }))
      .toMatchObject({ use: { count_used: 4, fate: 'discarded' } })
    expect(await post(f, { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 2, fate: 'given_away' }))
      .toMatchObject({ use: { count_used: 2, fate: 'given_away' }, jar: { remaining_count: 2 } })
    // Went bad of a count: accepted from this pass on (the validator's refusal came out in the same train).
    expect(await post(f, { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 1, fate: 'discarded' }))
      .toMatchObject({ use: { count_used: 1, fate: 'discarded' }, jar: { remaining_count: 3 } })
  })

  it.each([
    ['both count_used and all_remaining', { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 1, all_remaining: true }],
    ['neither count_used nor all_remaining', { idempotency_key: K, preservation_log_id: 'jar-1' }],
    ['a count of 0', { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 0 }],
    ['a count that is not whole', { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 1.5 }],
    ['all_remaining: false with no count', { idempotency_key: K, preservation_log_id: 'jar-1', all_remaining: false }],
    ['a fate the route does not write', { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 1, fate: 'batch' }],
    ['a field the route does not know', { idempotency_key: K, preservation_log_id: 'jar-1', count_used: 1, note: 'x' }],
    ['no idempotency key', { preservation_log_id: 'jar-1', count_used: 1 }],
    ['a key that is not a uuid', { idempotency_key: 'K', preservation_log_id: 'jar-1', count_used: 1 }],
    ['no jar named', { idempotency_key: K, count_used: 1 }],
  ])('refuses %s with a 400 and the validator\'s own sentence', async (_name, body) => {
    // What the SERVER says to this body once its jar id is a real one: the sentence the fake must answer with.
    const sentence = validateUse('preservation_log_id' in body ? { ...body, preservation_log_id: REAL_ID } : body)
    expect(typeof sentence).toBe('string')
    const f = fake()
    await expect(post(f, body)).rejects.toMatchObject({ status: 400, message: sentence, body: { error: sentence } })
    // …and it was recorded as a call, like any other.
    expect(f.calls('POST', '/api/pantry/uses')).toHaveLength(1)
  })

  it('a test that scripts the route itself is not judged: an override still answers first', async () => {
    const f = pantryFetch({ overrides: { 'POST /api/pantry/uses': () => ({ use: { id: 'scripted' }, jar: null }) } })
    expect(await post(f, { anything: true })).toEqual({ use: { id: 'scripted' }, jar: null })
  })
})
