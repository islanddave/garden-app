// Put-Up release 1a — ONE WRITER FOR THE COUNT on the legacy full-replace PUT (V4's legacy-PUT
// section, "From 1a"; lead condition 1, fix (ii)).
//
// THE RULE. A package_count that differs from the stored one moves remaining_count by the same delta
// from COALESCE(remaining_count, package_count), and the body's remaining_count is ignored; a result
// below 0 is refused. With the count unchanged a present remaining_count applies as it always did (the
// shipped Mark used / Used up). And the writer never stores remaining_count > package_count: release
// 1b's DDL arms that CHECK while THIS code is the deployed writer. Refused, never clamped.
//
// WHAT THIS FILE CAN PROVE, AND WHAT IT CANNOT. It executes the real handler (lambda/preservation/
// index.js under the vitest stubs), so it proves the statement's SHAPE — the arithmetic and the
// refusal are inside the one UPDATE, reading the row's own columns, with no separate read of the jar
// first — the values bound to it, and how the handler answers each result: 404, the coded 409s, 200.
// The mock driver runs no SQL, so it cannot prove the arithmetic. That proof was run on PG 17 with
// prod's preservation_log schema and the statement extracted verbatim from index.js (numbered and
// sent untyped, as the driver sends it), through every shipped client path, with and without 1b's
// CHECK armed — see this commit's message for the case table.
import { describe, it, expect, beforeEach } from 'vitest'
import { stubState, resetStubs } from '../_test-stubs/state.js'
import { countRefusal } from './jarRules.js'

const { handler } = await import('./index.js')

const USER = 'user_stub_dave'
const JAR = '3a1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

// The payload the SHIPPED client sends: buildFullPayload(rec) (src/pages/PutUp.jsx), which echoes every
// editable column including remaining_count, with RowEditor's or markUsed's overrides spread on top.
const echo = (overrides = {}) => ({
  crop_type_slug: 'pepper', variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-09-28', preserved_at_approx: null, method: 'whole_freeze', method_other_text: null,
  quantity_value: '2.50', quantity_unit: 'quarts', package_count: 3, storage_location_id: null,
  use_by_target: '2027-09-28', remaining_count: 3, consumed_at: null, notes: null, photo_id: null,
  source_kind: null, source_label: null, ...overrides,
})
// RowEditor.save()'s overrides, key for key.
const rowEditorSave = (rec, { package_count, use_by_target }) => ({
  quantity_value: rec.quantity_value, quantity_unit: rec.quantity_unit, package_count,
  method: rec.method, method_other_text: null, use_by_target, notes: null,
})

const put = (body) => ({
  requestContext: { http: { method: 'PUT' } },
  rawPath: `/api/preservation/${JAR}`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
})
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') })

// The value bound to ONE named placeholder (the stub joins the template strings with '?').
const boundAfter = (call, re) => {
  const m = call.text.match(re)
  expect(m, `SQL does not match ${re}`).toBeTruthy()
  const end = m.index + m[0].length
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?')
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length]
}

// What the statement hands back: one row per jar in scope — the updated columns (all NULL when the
// UPDATE refused) beside the statement's own snapshot of the stored counts — or none at all.
const written = (over = {}) => ({
  id: JAR, user_id: USER, package_count: 3, remaining_count: 2, preserved_at: new Date(Date.UTC(2026, 8, 28)),
  stored_package_count: 3, stored_remaining_count: 3, ...over,
})
const refused = (storedCount, storedRemaining) => ({
  id: null, user_id: null, package_count: null, remaining_count: null,
  stored_package_count: storedCount, stored_remaining_count: storedRemaining,
})

let updateCall
beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: USER }
  updateCall = null
})
const answerWith = (rows) => {
  stubState.sqlHandler = (text) => {
    if (/UPDATE preservation_log SET/.test(text)) return rows
    return []
  }
}
const theUpdate = () => {
  const calls = stubState.sqlCalls.filter((c) => /preservation_log/.test(c.text))
  expect(calls, 'the PUT must touch preservation_log in exactly one statement').toHaveLength(1)
  return calls[0]
}

describe('the count rule is decided inside the one UPDATE, not by a read-then-write', () => {
  it('one statement: a snapshot CTE for the answer, the UPDATE, nothing reads the jar first', async () => {
    answerWith([written()])
    const res = parse(await handler(put(echo({ remaining_count: 2 }))))
    expect(res.status).toBe(200)
    updateCall = theUpdate()
    const sql = updateCall.text.replace(/\s+/g, ' ')
    expect(sql.indexOf('WITH stored AS (')).toBeLessThan(sql.indexOf('UPDATE preservation_log SET'))
    expect(sql).toMatch(/SELECT updated\.\*, stored\.stored_package_count, stored\.stored_remaining_count FROM stored LEFT JOIN updated ON TRUE/)
  })

  it('remaining_count: the body value when the count is unchanged, else the stored left moved by the delta', async () => {
    answerWith([written()])
    await handler(put(echo({ remaining_count: 2 })))
    const sql = theUpdate().text.replace(/\s+/g, ' ')
    expect(sql).toMatch(/remaining_count = CASE WHEN package_count = \?::int THEN \?::int ELSE COALESCE\(remaining_count, package_count\) \+ \(\?::int - package_count\) END,/)
  })

  it('the refusal is the same expression, bounded to 0..the new count, in the WHERE', async () => {
    answerWith([written()])
    await handler(put(echo({ remaining_count: 2 })))
    const sql = theUpdate().text.replace(/\s+/g, ' ')
    const where = sql.slice(sql.indexOf('WHERE id = ?', sql.indexOf('UPDATE preservation_log SET')))
    expect(where).toMatch(/AND COALESCE\( CASE WHEN package_count = \?::int THEN \?::int ELSE COALESCE\(remaining_count, package_count\) \+ \(\?::int - package_count\) END BETWEEN 0 AND \?::int, TRUE\)/)
  })

  it('a count change re-derives consumed_at from the count it produced', async () => {
    answerWith([written()])
    await handler(put(echo({ remaining_count: 2 })))
    const sql = theUpdate().text.replace(/\s+/g, ' ')
    expect(sql).toMatch(/consumed_at = CASE WHEN package_count = \?::int THEN \?::timestamptz WHEN COALESCE\(remaining_count, package_count\) \+ \(\?::int - package_count\) = 0 THEN COALESCE\(consumed_at, NOW\(\)\) END,/)
  })
})

describe('what the shipped client sends is what gets bound', () => {
  it('Mark used: the count as echoed, the decremented remaining', async () => {
    answerWith([written()])
    await handler(put(echo({ remaining_count: 2 })))
    const call = theUpdate()
    expect(boundAfter(call, /package_count\s+= /)).toBe(3)
    expect(boundAfter(call, /remaining_count\s+= CASE WHEN package_count = /)).toBe(3)
    expect(boundAfter(call, /remaining_count\s+= CASE WHEN package_count = \?::int THEN /)).toBe(2)
  })

  // V4's named deployed-writer cases. The arithmetic for each is proved on PG 17 (commit message);
  // here, that the edited count and the untouched echo reach the statement as they left the phone.
  it('RowEditor lowering the count below what is left: new count bound, the stale echo bound only to the unchanged-count branch', async () => {
    answerWith([written({ package_count: 1, remaining_count: 1 })])
    const rec = echo()
    await handler(put({ ...rec, ...rowEditorSave(rec, { package_count: 1, use_by_target: rec.use_by_target }) }))
    const call = theUpdate()
    expect(boundAfter(call, /package_count\s+= /)).toBe(1)
    expect(boundAfter(call, /remaining_count\s+= CASE WHEN package_count = \?::int THEN /)).toBe(3)
    expect(boundAfter(call, /\+ \(/)).toBe(1)
  })

  it('RowEditor changing a date, and clearing one: the date as sent, the count untouched', async () => {
    answerWith([written()])
    const rec = echo({ remaining_count: 2 })
    await handler(put({ ...rec, ...rowEditorSave(rec, { package_count: 3, use_by_target: '2027-01-15' }) }))
    expect(boundAfter(theUpdate(), /use_by_target\s+= /)).toBe('2027-01-15')
    stubState.sqlCalls = []
    await handler(put({ ...rec, ...rowEditorSave(rec, { package_count: 3, use_by_target: null }) }))
    const call = theUpdate()
    expect(boundAfter(call, /use_by_target\s+= /)).toBeNull()
    expect(boundAfter(call, /remaining_count\s+= CASE WHEN package_count = \?::int THEN /)).toBe(2)
  })
})

describe('how the handler answers each result', () => {
  it('no row at all: the jar is not in scope → 404, as before', async () => {
    answerWith([])
    expect(parse(await handler(put(echo({ remaining_count: 2 }))))).toEqual({ status: 404, body: { error: 'Not found' } })
  })

  it('written → 200 with the row exactly as RETURNING * gave it, the snapshot columns stripped', async () => {
    answerWith([written({ remaining_count: 2 })])
    const res = parse(await handler(put(echo({ remaining_count: 2 }))))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(JAR)
    expect(res.body.remaining_count).toBe(2)
    expect(res.body).not.toHaveProperty('stored_package_count')
    expect(res.body).not.toHaveProperty('stored_remaining_count')
  })

  it('refused lowering below what is used → 409 count_below_used, in plain words', async () => {
    answerWith([refused(3, 1)])
    const rec = echo({ remaining_count: 1 })
    const res = parse(await handler(put({ ...rec, ...rowEditorSave(rec, { package_count: 1, use_by_target: rec.use_by_target }) })))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      code: 'count_below_used',
      message: "2 of these are already used, so the count can't go below 2.",
      error: "2 of these are already used, so the count can't go below 2.",
    })
  })

  it('refused more left than the count → 409 remaining_above_count', async () => {
    answerWith([refused(2, 2)])
    const res = parse(await handler(put(echo({ package_count: 2, remaining_count: 3 }))))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('remaining_above_count')
    expect(res.body.message).toBe(res.body.error)
  })

  it('refused although the snapshot allowed it (the jar changed mid-statement) → 409 client_stale', async () => {
    answerWith([refused(3, 3)])
    const res = parse(await handler(put(echo({ remaining_count: 2 }))))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('client_stale')
  })
})

describe('countRefusal — the words for each refusal', () => {
  it.each([
    // [what was stored, what was sent, code]
    [{ storedCount: 3, storedRemaining: 1 }, { packageCount: 1, remaining: 3 }, 'count_below_used'],
    [{ storedCount: 3, storedRemaining: 0 }, { packageCount: 2, remaining: 0 }, 'count_below_used'],
    [{ storedCount: 5, storedRemaining: null }, { packageCount: 5, remaining: 6 }, 'remaining_above_count'],
    [{ storedCount: 2, storedRemaining: 2 }, { packageCount: 2, remaining: 3 }, 'remaining_above_count'],
    [{ storedCount: 3, storedRemaining: 3 }, { packageCount: 3, remaining: 2 }, 'client_stale'],
    [{ storedCount: 3, storedRemaining: 2 }, { packageCount: 4, remaining: 2 }, 'client_stale'],
  ])('stored %o, sent %o → %s', (stored, sent, code) => {
    expect(countRefusal({ ...stored, ...sent }).code).toBe(code)
  })

  it('counts what is used from a NULL remaining as none used', () => {
    expect(countRefusal({ storedCount: 3, storedRemaining: null, packageCount: 2, remaining: null }).code).toBe('client_stale')
  })

  it('says one jar in the singular', () => {
    expect(countRefusal({ storedCount: 2, storedRemaining: 1, packageCount: 0, remaining: 1 }).message)
      .toBe("1 of these is already used, so the count can't go below 1.")
  })

  // V4's banned words, swept over every message a refusal can carry.
  it('no refusal message uses a banned word', () => {
    const banned = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
    const messages = [
      countRefusal({ storedCount: 3, storedRemaining: 1, packageCount: 1, remaining: 3 }).message,
      countRefusal({ storedCount: 2, storedRemaining: 2, packageCount: 2, remaining: 3 }).message,
      countRefusal({ storedCount: 3, storedRemaining: 3, packageCount: 3, remaining: 2 }).message,
    ]
    for (const m of messages) expect(m).not.toMatch(banned)
  })
})
