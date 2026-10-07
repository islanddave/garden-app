// BUG-WHATSNEWSTALELOCALPUSH-001 — whats_new_last_seen only moves forward through the prefs PATCH.
//
// The ON CONFLICT arm used to be COALESCE(new, old): whatever a device sent replaced what was stored,
// so a device with a stale local value lowered it and a release already read dotted again everywhere.
// The arm now keeps the larger of the two, compared as dot-separated integers, inside the statement.
//
// Like prefsNavcustom.test.js this drives PATCH /api/notifications/prefs through the Lambda runtime
// stubs and reads the statement the handler built. The stubs are not a database: these tests pin the
// arm's shape, its bindings and the digit pattern as Postgres will receive it. That Postgres orders
// 4.10.0 above 4.9.0 with this expression was run once against a real server when it was written
// (lane report whatsnewpush-20261007); the staging smoke is the standing proof.
import { describe, it, expect, beforeEach } from 'vitest'
import { stubState, resetStubs } from '../_test-stubs/state.js'

const { handler } = await import('./index.js')

const STORED = 'public.user_notification_prefs.whats_new_last_seen'

const patch = async (body) => {
  const res = await handler({
    requestContext: { http: { method: 'PATCH' } },
    rawPath: '/api/notifications/prefs',
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  })
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

const prefsWrite = () => stubState.sqlCalls.filter((c) => /INSERT INTO public\.user_notification_prefs \(created_by, critter_visit/.test(c.text))

// The ON CONFLICT arm for the column, from `whats_new_last_seen =` to the next column's assignment,
// with the values bound inside it. The stub records a statement as strings.join('?'), so the k-th '?'
// is values[k] — true only while the SQL text carries no literal '?', asserted here.
function arm(c) {
  const start = c.text.search(/\bwhats_new_last_seen\s*=/)
  const end = c.text.search(/\bmore_pins\s*=/)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const offs = []
  for (let i = c.text.indexOf('?'); i !== -1; i = c.text.indexOf('?', i + 1)) offs.push(i)
  expect(offs).toHaveLength(c.values.length)
  const values = offs.map((o, k) => [o, c.values[k]]).filter(([o]) => o >= start && o < end).map(([, v]) => v)
  return { text: c.text.slice(start, end).replace(/\s+/g, ' ').trim(), values }
}

beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: 'user_2dave' }
  stubState.sqlHandler = () => [{ whats_new_last_seen: '4.10.0' }]
})

describe('PATCH /api/notifications/prefs — whats_new_last_seen keeps the larger version', () => {
  // KILLING MUTATION: restore `COALESCE(${wnls}::text, <stored>)` (the code before this fix).
  // RESULT: RED — an older incoming version replaces the stored one.
  it('an older incoming version cannot lower the stored one: the stored value is the ELSE of the comparison', async () => {
    expect((await patch({ whats_new_last_seen: '4.9.0' })).status).toBe(200)
    expect(prefsWrite()).toHaveLength(1)
    const { text } = arm(prefsWrite()[0])
    expect(text).not.toMatch(/COALESCE/)
    expect(text).toContain(
      `WHEN string_to_array(?::text, '.')::bigint[] >= string_to_array(${STORED}, '.')::bigint[] THEN ?::text ELSE ${STORED} END`)
  })

  // KILLING MUTATION: flip `>=` to `<=`, or swap the THEN and ELSE. RESULT: RED (same assertion as
  // above) — a newer incoming version would be dropped. Equal versions take the incoming one.
  it('a newer incoming version raises it: the incoming value is the THEN of the comparison, and is what is bound', async () => {
    await patch({ whats_new_last_seen: '4.11.0' })
    const { text, values } = arm(prefsWrite()[0])
    expect(text).toMatch(/>= string_to_array\([^)]*\)::bigint\[\] THEN \?::text ELSE public/)
    expect(values.length).toBeGreaterThan(0)
    expect(values.every((v) => v === '4.11.0')).toBe(true)
  })

  // KILLING MUTATION: compare the text (`?::text >= <stored>`) or cast to text[]. RESULT: RED —
  // '4.10.0' sorts below '4.9.0' as a string.
  it('4.10.0 is above 4.9.0: both sides are compared as bigint[] and never as text', async () => {
    await patch({ whats_new_last_seen: '4.10.0' })
    const { text } = arm(prefsWrite()[0])
    expect(text.match(/string_to_array\([^)]*, '\.'\)::bigint\[\]/g)).toHaveLength(2)
    expect(text).not.toMatch(/\?::text\s*(>=|>|<=|<)/)
    expect(text).not.toMatch(/GREATEST/i)
  })

  // The casts are guarded: the comparison is reached only when both sides are plain dotted digits.
  // KILLING MUTATION: write the dot as `\.` in the template literal (it reaches Postgres as a bare `.`).
  // RESULT: RED — '4x9' passes the guard.
  it('the digit pattern reaches Postgres intact and guards both sides before any cast', async () => {
    await patch({ whats_new_last_seen: '4.9.0' })
    const { text } = arm(prefsWrite()[0])
    const guards = [...text.matchAll(/~ '([^']*)'/g)].map((m) => m[1])
    expect(guards).toHaveLength(2)
    expect(guards[0]).toBe(guards[1])
    const re = new RegExp(guards[0])
    for (const v of ['4.9.0', '4.10.0', '5', '4.128.0']) expect(re.test(v)).toBe(true)
    for (const v of ['', '4x9', '4.9.', '.4', '2026.08-rc1', '4.9.0 ', '1234567890.0']) expect(re.test(v)).toBe(false)
    expect(text.indexOf(`AND ${STORED} ~`)).toBeLessThan(text.indexOf('string_to_array'))
  })

  it('no incoming value, or an empty one, keeps the stored value; no stored value takes the incoming one', async () => {
    await patch({ log_many_all_selected: true })
    const { text, values } = arm(prefsWrite()[0])
    expect(values.every((v) => v === null)).toBe(true)
    expect(text).toMatch(new RegExp(`^whats_new_last_seen = CASE WHEN NULLIF\\(\\?::text, ''\\) IS NULL THEN ${STORED.replace(/\./g, '\\.')} WHEN NULLIF\\(${STORED.replace(/\./g, '\\.')}, ''\\) IS NULL THEN \\?::text WHEN `))
  })

  // A version scheme that is not dotted digits is still storable (validators.js, on purpose).
  it('a value that is not dotted digits falls through to last-write, without a cast', async () => {
    await patch({ whats_new_last_seen: '2026.08-rc1' })
    const { text } = arm(prefsWrite()[0])
    expect(text).toMatch(/END ELSE \?::text END,$/)
  })
})
