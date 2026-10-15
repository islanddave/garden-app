// V5-TODAYREDESIGN-001 S7 — today_sections through the critter Lambda's prefs route, with the column PRESENT
// and with it ABSENT (migrations/v5-todaysections-001 not yet applied to that environment).
//
// Drives the real handler through the Lambda runtime stubs (lambda/_test-stubs), as prefsNavcustom.test.js
// does. A database without the column is emulated the way Postgres reports it: the statement that names it
// throws SQLSTATE 42703 ("column \"today_sections\" does not exist"); every other statement answers.
//
// The stubs are not a database: nothing here proves Postgres accepts the statement or merges as described.
// The merge is checked here as the statement TEXT (`COALESCE(stored, '{}') || incoming`, per top-level key)
// and against a fake that applies jsonb `||` object semantics; the real round trip is the staging smoke,
// tests/smoke/run-smoke.sh block T.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stubState, resetStubs } from '../_test-stubs/state.js'

const { handler, __resetTodaySectionsAbsence } = await import('./index.js')

const DAVE = 'user_2dave'
const D = '2026-10-14'

const event = (method, body) => ({
  requestContext: { http: { method } },
  rawPath: '/api/notifications/prefs',
  headers: { authorization: 'Bearer stub-token' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const call = async (method, body) => {
  const res = await handler(event(method, body))
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

const ROW = {
  critter_visit: 'in_app_only', quiet_hours_start: '21:00:00', quiet_hours_end: '07:00:00',
  coachmark_seen_at: null, opt_in_prompt_seen_at: null, last_garden_view_at: null,
  garden_group_by: null, garden_sort_order: null, garden_expanded: null, garden_bloom_seen: null,
  garden_helper_rung1_seen: null, today_skipped: null, log_many_all_selected: null, whats_new_last_seen: null,
  more_pins: null, bar_layout: null, created_at: null, updated_at: null,
}

const isBootRead = (t) => /SELECT critter_visit[\s\S]*FROM public\.user_notification_prefs/.test(t)
const isSectionsRead = (t) => /SELECT today_sections\s+FROM public\.user_notification_prefs/.test(t)
const isSectionsWrite = (t) => /INSERT INTO public\.user_notification_prefs \(created_by, today_sections\)/.test(t)
const isMainWrite = (t) => /INSERT INTO public\.user_notification_prefs \(created_by, critter_visit/.test(t)
const calls = (pred) => stubState.sqlCalls.filter((c) => pred(c.text))

const missingColumn = () => Object.assign(new Error('column "today_sections" does not exist'), { code: '42703' })

// A database. `hasColumn` false: any statement naming today_sections throws 42703, as Postgres does at parse.
// The today_sections upsert applies jsonb `||` on objects (a shallow merge, the right side winning per key)
// over COALESCE(stored, '{}') — what the statement text asserts below.
function fakeDb({ hasColumn = true, row = ROW, stored = null } = {}) {
  const db = { hasColumn, row, stored }
  stubState.sqlHandler = (text, values) => {
    if (/today_sections/.test(text) && !db.hasColumn) throw missingColumn()
    if (isSectionsRead(text)) return db.row ? [{ today_sections: db.stored }] : []
    if (isSectionsWrite(text)) {
      const incoming = JSON.parse(values[1])
      db.stored = { ...(db.stored ?? {}), ...incoming }
      db.row = db.row ?? ROW
      return [{ today_sections: db.stored, updated_at: '2026-10-14T12:00:00Z' }]
    }
    if (isBootRead(text)) return db.row ? [db.row] : []
    if (isMainWrite(text)) return [{ ...(db.row ?? ROW) }]
    return []
  }
  return db
}

beforeEach(() => {
  resetStubs()
  __resetTodaySectionsAbsence()
  stubState.verifyTokenResult = { sub: DAVE }
})
afterEach(() => { vi.restoreAllMocks() })

describe('GET /api/notifications/prefs — today_sections, column PRESENT', () => {
  it('reads it by its own statement and passes the stored object through', async () => {
    const stored = { v: 1, harvest: { open: true, at: D } }
    fakeDb({ stored })
    const { status, body } = await call('GET')
    expect(status).toBe(200)
    expect(body.today_sections).toEqual(stored)
    expect(body.critter_visit).toBe('in_app_only')
    expect(calls(isSectionsRead)).toHaveLength(1)
    expect(calls(isSectionsRead)[0].values).toEqual([DAVE])
    // The boot read never names the column — the property that keeps it safe on an unmigrated database.
    expect(calls(isBootRead)).toHaveLength(1)
    expect(calls(isBootRead)[0].text).not.toMatch(/today_sections/)
  })

  it('a row that never set it, and no row at all, both read null — present, never missing', async () => {
    fakeDb({ stored: null })
    expect((await call('GET')).body).toHaveProperty('today_sections', null)
    fakeDb({ row: null })
    const { status, body } = await call('GET')
    expect(status).toBe(200)
    expect(body).toHaveProperty('today_sections', null)
    expect(body.critter_visit).toBe('in_app_only')   // the stateless defaults still apply
  })
})

describe('GET /api/notifications/prefs — today_sections, column ABSENT', () => {
  it('answers 200 with every other pref and NO today_sections key — mutation: name it in readUserPrefs', async () => {
    fakeDb({ hasColumn: false })
    const { status, body } = await call('GET')
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('today_sections')
    expect(body.critter_visit).toBe('in_app_only')
    expect(typeof body.can_edit_bar).toBe('boolean')
  })

  it('remembers the absence for a while instead of re-asking on every boot, and asks again after', async () => {
    fakeDb({ hasColumn: false })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    await call('GET')
    await call('GET')
    expect(calls(isSectionsRead)).toHaveLength(1)
    now.mockReturnValue(1_000_000 + 60 * 1000 + 1)
    await call('GET')
    expect(calls(isSectionsRead)).toHaveLength(2)
  })

  it('the DDL landing is seen once the memo lapses: the same warm module then reads the column', async () => {
    const db = fakeDb({ hasColumn: false })
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
    expect((await call('GET')).body).not.toHaveProperty('today_sections')
    db.hasColumn = true
    db.stored = { v: 1, care: { open: false, at: D, ack: { r: 'small' } } }
    now.mockReturnValue(5_000_000 + 61 * 1000)
    expect((await call('GET')).body.today_sections).toEqual(db.stored)
  })

  it('any other failure of that read is logged and omitted — the boot prefs read never fails for it', async () => {
    fakeDb()
    const inner = stubState.sqlHandler
    stubState.sqlHandler = (text, values) => {
      if (isSectionsRead(text)) throw Object.assign(new Error('connection reset'), { code: '08006' })
      return inner(text, values)
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status, body } = await call('GET')
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('today_sections')
    expect(err).toHaveBeenCalled()
    // Not mistaken for absence: the next boot asks again.
    await call('GET')
    expect(calls(isSectionsRead)).toHaveLength(2)
  })

  it('a 42703 about ANOTHER column is not taken for this one', async () => {
    fakeDb()
    const inner = stubState.sqlHandler
    stubState.sqlHandler = (text, values) => {
      if (isSectionsRead(text)) throw Object.assign(new Error('column "created_by" does not exist'), { code: '42703' })
      return inner(text, values)
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await call('GET')
    await call('GET')
    expect(calls(isSectionsRead)).toHaveLength(2)
  })
})

describe('PATCH /api/notifications/prefs — today_sections, column PRESENT', () => {
  it('writes it ALONE by its own upsert, bound as JSON and cast ::jsonb at both sites, merged per key', async () => {
    fakeDb()
    const ts = { v: 1, harvest: { open: false, at: D } }
    const { status, body } = await call('PATCH', { today_sections: ts })
    expect(status).toBe(200)
    expect(body.today_sections).toEqual(ts)
    expect(calls(isMainWrite)).toHaveLength(0)            // no other column is touched
    const w = calls(isSectionsWrite)
    expect(w).toHaveLength(1)
    expect(w[0].values).toEqual([DAVE, JSON.stringify(ts), JSON.stringify(ts)])
    expect(w[0].text).toMatch(/VALUES \(\?, \?::jsonb\)/)
    // The merge: per top-level key, incoming over stored, NULL stored read as {}. Mutation: plain replace
    // (`today_sections = ?::jsonb`) reds this, and the two-key test below.
    expect(w[0].text).toMatch(/today_sections = COALESCE\(public\.user_notification_prefs\.today_sections, '\{\}'::jsonb\) \|\| \?::jsonb/)
    expect(w[0].text).toMatch(/updated_at\s+= now\(\)/)
  })

  it('a second section written later keeps the first (merge), and the same section is replaced', async () => {
    const db = fakeDb()
    await call('PATCH', { today_sections: { v: 1, harvest: { open: false, at: D } } })
    await call('PATCH', { today_sections: { v: 1, putup: { open: true, at: D } } })
    expect(db.stored).toEqual({ v: 1, harvest: { open: false, at: D }, putup: { open: true, at: D } })
    await call('PATCH', { today_sections: { v: 1, harvest: { open: true, at: '2026-10-15' } } })
    expect(db.stored.harvest).toEqual({ open: true, at: '2026-10-15' })
    expect(db.stored.putup).toEqual({ open: true, at: D })
    const { body } = await call('GET')
    expect(body.today_sections).toEqual(db.stored)
  })

  it('a save of any OTHER field leaves today_sections alone — the main upsert never names it', async () => {
    const db = fakeDb({ stored: { v: 1, care: { open: true, at: D } } })
    const { status } = await call('PATCH', { bar_layout: { order: ['today', 'garden', 'create', 'harvests', 'put-up'], hidden: [] } })
    expect(status).toBe(200)
    expect(calls(isSectionsWrite)).toHaveLength(0)
    expect(calls(isMainWrite)).toHaveLength(1)
    expect(calls(isMainWrite)[0].text).not.toMatch(/today_sections/)
    expect(db.stored).toEqual({ v: 1, care: { open: true, at: D } })
  })

  it('refuses it beside another field, before any SQL — 400, nothing half saved', async () => {
    fakeDb()
    const { status, body } = await call('PATCH', {
      today_sections: { v: 1, harvest: { open: true, at: D } },
      today_skipped: { date: D, keys: ['k1'] },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/today_sections must be sent alone/)
    expect(stubState.sqlCalls).toHaveLength(0)
  })

  it('a body the validator refuses never reaches SQL', async () => {
    fakeDb()
    const { status } = await call('PATCH', { today_sections: { v: 1, sidebar: { open: true, at: D } } })
    expect(status).toBe(400)
    expect(stubState.sqlCalls).toHaveLength(0)
  })

  it('a failure that is not the missing column is a 500, never a 409 the client would keep retrying as "not yet"', async () => {
    fakeDb()
    stubState.sqlHandler = () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }) }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status } = await call('PATCH', { today_sections: { v: 1, harvest: { open: true, at: D } } })
    expect(status).toBe(500)
  })
})

describe('PATCH /api/notifications/prefs — today_sections, column ABSENT', () => {
  it('answers 409 "not stored on this server yet", with nothing written', async () => {
    fakeDb({ hasColumn: false })
    const { status, body } = await call('PATCH', { today_sections: { v: 1, harvest: { open: true, at: D } } })
    expect(status).toBe(409)
    expect(body.error).toBe('today_sections is not stored on this server yet')
    expect(calls(isMainWrite)).toHaveLength(0)
    expect(stubState.sqlCalls.every((c) => isSectionsWrite(c.text))).toBe(true)
  })

  it('every other save still works there — the main upsert does not name the column', async () => {
    fakeDb({ hasColumn: false })
    const { status } = await call('PATCH', { today_skipped: { date: D, keys: ['k1'] } })
    expect(status).toBe(200)
  })

  it('a 409 primes the GET memo, and a later successful write clears it', async () => {
    const db = fakeDb({ hasColumn: false })
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000)
    expect((await call('PATCH', { today_sections: { v: 1, care: { open: true, at: D } } })).status).toBe(409)
    expect((await call('GET')).body).not.toHaveProperty('today_sections')
    expect(calls(isSectionsRead)).toHaveLength(0)        // memo: the GET did not re-ask
    db.hasColumn = true                                   // the DDL lands; a PATCH (always tried) succeeds
    expect((await call('PATCH', { today_sections: { v: 1, care: { open: true, at: D } } })).status).toBe(200)
    expect((await call('GET')).body.today_sections).toEqual({ v: 1, care: { open: true, at: D } })
  })
})
