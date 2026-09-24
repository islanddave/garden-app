// V5-NAVCUSTOM-001 — more_pins, bar_layout and can_edit_bar through the critter Lambda's prefs route.
//
// Two halves. validators.test.js tests the validator as behaviour. This file IMPORTS the handler and
// drives GET and PATCH /api/notifications/prefs through the Lambda runtime stubs (lambda/_test-stubs,
// aliased in vitest.config.ts), so it proves the new fields are wired in where CONTRACT §2-§3 put them:
// the boot read's SELECT and its no-row defaults; can_edit_bar on the GET, from isAdmin; and on the
// PATCH the INSERT column list, the VALUES tuple, both COALESCE arms and RETURNING, with every jsonb
// binding cast ::jsonb and bound as a JSON string. (appConfig.test.js and retired-post-route.test.js
// say index.js cannot be imported in this suite; the stubs have made that possible since they landed.)
//
// The stubs are not a database: nothing here proves Postgres accepts the statement or that the columns
// exist. That is migrations/v5-navcustom-001 (applied first) and the staging write-then-read-back smoke,
// tests/smoke/run-smoke.sh block L.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { stubState, resetStubs } from '../_test-stubs/state.js'

const { handler } = await import('./index.js')

const DAVE = 'user_2dave'
const JEN = 'user_2jen'
const DEFAULT_ORDER = ['today', 'garden', 'create', 'harvests', 'put-up']
const TABLE = 'public.user_notification_prefs'

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

const bootRead = () => stubState.sqlCalls.filter((c) => /SELECT critter_visit[\s\S]*FROM public\.user_notification_prefs/.test(c.text))
const prefsWrite = () => stubState.sqlCalls.filter((c) => /INSERT INTO public\.user_notification_prefs \(created_by, critter_visit/.test(c.text))

// The stub records a statement as strings.join('?'), so the k-th '?' is values[k] — true only while the
// SQL text itself carries no literal '?'. Asserted here rather than assumed.
function placeholderOffsets(c) {
  const offs = []
  for (let i = c.text.indexOf('?'); i !== -1; i = c.text.indexOf('?', i + 1)) offs.push(i)
  expect(offs).toHaveLength(c.values.length)
  return offs
}
// The value bound at the placeholder found at text offset `at`.
const valueAt = (c, at) => c.values[placeholderOffsets(c).indexOf(at)]

// Split on commas at paren depth 0 — the VALUES tuple holds COALESCE(…, …) calls.
function topLevelSplit(s) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) { out.push([start, i]); start = i + 1 }
  }
  out.push([start, s.length])
  return out
}

// The INSERT's column list and its VALUES tuple, each VALUES entry with its absolute text offset.
function insertShape(c) {
  const m = c.text.match(/INSERT INTO public\.user_notification_prefs \(([^)]*)\)\s*VALUES\s*\(/)
  expect(m).not.toBeNull()
  const cols = m[1].split(',').map((s) => s.trim())
  const tupleStart = m.index + m[0].length
  let depth = 1
  let end = tupleStart
  while (depth > 0) {
    if (c.text[end] === '(') depth++
    else if (c.text[end] === ')') depth--
    end++
  }
  const tuple = c.text.slice(tupleStart, end - 1)
  const entries = topLevelSplit(tuple).map(([a, b]) => {
    const raw = tuple.slice(a, b)
    const lead = raw.length - raw.trimStart().length
    return { expr: raw.trim(), at: tupleStart + a + lead }
  })
  return { cols, entries }
}

// The ON CONFLICT arm `<col> = COALESCE(?::jsonb, public.user_notification_prefs.<col>)`, and its value.
function coalesceArm(c, col) {
  const re = new RegExp(`\\b${col}\\s*=\\s*COALESCE\\(\\?::jsonb, public\\.user_notification_prefs\\.${col}\\)`)
  const m = c.text.match(re)
  return m ? { text: m[0], value: valueAt(c, m.index + m[0].indexOf('?')) } : null
}

const ROW = {
  critter_visit: 'in_app_only', quiet_hours_start: '21:00:00', quiet_hours_end: '07:00:00',
  coachmark_seen_at: null, opt_in_prompt_seen_at: null, last_garden_view_at: null,
  garden_group_by: null, garden_sort_order: null, garden_expanded: null, garden_bloom_seen: null,
  garden_helper_rung1_seen: null, today_skipped: null, log_many_all_selected: null,
  whats_new_last_seen: null, created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z',
}

let savedAdmins
beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: DAVE }
  savedAdmins = process.env.ADMIN_CLERK_SUBS
  delete process.env.ADMIN_CLERK_SUBS
})
afterEach(() => {
  if (savedAdmins === undefined) delete process.env.ADMIN_CLERK_SUBS
  else process.env.ADMIN_CLERK_SUBS = savedAdmins
})

describe('GET /api/notifications/prefs — V5-NAVCUSTOM-001', () => {
  it('the boot read selects more_pins and bar_layout — mutation: drop either from readUserPrefs\' SELECT', async () => {
    await call('GET')
    expect(bootRead()).toHaveLength(1)
    const selectList = bootRead()[0].text.match(/SELECT([\s\S]*?)FROM public\.user_notification_prefs/)[1]
    const cols = selectList.split(',').map((s) => s.trim())
    expect(cols).toContain('more_pins')
    expect(cols).toContain('bar_layout')
  })

  it('no prefs row: more_pins and bar_layout are null, not missing — mutation: drop either no-row default', async () => {
    stubState.sqlHandler = () => []
    const { status, body } = await call('GET')
    expect(status).toBe(200)
    expect(body).toHaveProperty('more_pins', null)
    expect(body).toHaveProperty('bar_layout', null)
    expect(typeof body.can_edit_bar).toBe('boolean')
  })

  it('a stored row passes both values through unchanged', async () => {
    const pins = ['seeds', 'photos']
    const layout = { order: ['today', 'harvests', 'create', 'garden', 'put-up'], hidden: ['put-up'] }
    stubState.sqlHandler = (text) => (/FROM public\.user_notification_prefs/.test(text)
      ? [{ ...ROW, more_pins: pins, bar_layout: layout }] : [])
    const { status, body } = await call('GET')
    expect(status).toBe(200)
    expect(body.more_pins).toEqual(pins)
    expect(body.bar_layout).toEqual(layout)
  })

  it('can_edit_bar is isAdmin: true only for a whole sub on ADMIN_CLERK_SUBS, false when unset', async () => {
    // Mutations: `can_edit_bar: true` reds the Jen and unset cases; `false` reds the Dave cases; a
    // prefix/substring match reds the `_extra` case; any fail-open on an empty list reds the unset case.
    const cases = [
      { admins: DAVE, sub: DAVE, want: true },
      { admins: ` ${JEN} , ${DAVE} `, sub: DAVE, want: true },
      { admins: DAVE, sub: JEN, want: false },
      { admins: undefined, sub: DAVE, want: false },
      { admins: '', sub: DAVE, want: false },
      { admins: `${DAVE}_extra`, sub: DAVE, want: false },
    ]
    for (const { admins, sub, want } of cases) {
      if (admins === undefined) delete process.env.ADMIN_CLERK_SUBS
      else process.env.ADMIN_CLERK_SUBS = admins
      stubState.verifyTokenResult = { sub }
      for (const rows of [[], [ROW]]) {
        stubState.sqlHandler = () => rows
        const { status, body } = await call('GET')
        expect({ admins, sub, rows: rows.length, status, can_edit_bar: body.can_edit_bar })
          .toEqual({ admins, sub, rows: rows.length, status: 200, can_edit_bar: want })
      }
    }
  })

  it('can_edit_bar is computed per request and never stored or selected', async () => {
    process.env.ADMIN_CLERK_SUBS = JEN
    expect((await call('GET')).body.can_edit_bar).toBe(false)
    // Read at call time, not cached at module init: the same warm module now answers true.
    process.env.ADMIN_CLERK_SUBS = DAVE
    expect((await call('GET')).body.can_edit_bar).toBe(true)
    for (const c of stubState.sqlCalls) expect(c.text).not.toMatch(/can_edit_bar/)
  })
})

describe('PATCH /api/notifications/prefs — V5-NAVCUSTOM-001', () => {
  const PINS = ['seeds', 'photos']
  const LAYOUT = { order: ['today', 'garden', 'create', 'put-up', 'harvests'], hidden: ['harvests'] }

  beforeEach(() => {
    // Echo the upsert's RETURNING as a stored row carrying what was written.
    stubState.sqlHandler = (text) => (/INSERT INTO public\.user_notification_prefs \(created_by, critter_visit/.test(text)
      ? [{ ...ROW, more_pins: PINS, bar_layout: LAYOUT }] : [])
  })

  it('INSERT names both columns and binds each, at its own position, as a ::jsonb JSON string', async () => {
    // Mutations: drop a column from the list (not found); swap the two VALUES entries (wrong value at
    // the column's position); drop a `::jsonb` (expr is a bare `?`); bind the raw array or object
    // without JSON.stringify (the neon driver would send a JS array as a Postgres array literal).
    const { status } = await call('PATCH', { more_pins: PINS, bar_layout: LAYOUT })
    expect(status).toBe(200)
    expect(prefsWrite()).toHaveLength(1)
    const c = prefsWrite()[0]
    const { cols, entries } = insertShape(c)
    expect(entries).toHaveLength(cols.length)
    for (const [col, want] of [['more_pins', JSON.stringify(PINS)], ['bar_layout', JSON.stringify(LAYOUT)]]) {
      const i = cols.indexOf(col)
      expect(i, `${col} in the INSERT column list`).toBeGreaterThan(-1)
      expect(entries[i].expr, `${col} VALUES entry`).toBe('?::jsonb')
      expect(valueAt(c, entries[i].at), `${col} bound value`).toBe(want)
    }
  })

  it('both COALESCE arms cast ::jsonb and fall back to their own stored column', async () => {
    // Mutations: drop the cast from either arm; fall back to the wrong column; bind the other key's value.
    await call('PATCH', { more_pins: PINS, bar_layout: LAYOUT })
    const c = prefsWrite()[0]
    expect(coalesceArm(c, 'more_pins')?.value).toBe(JSON.stringify(PINS))
    expect(coalesceArm(c, 'bar_layout')?.value).toBe(JSON.stringify(LAYOUT))
  })

  it('RETURNING carries both columns and the response is that row — never can_edit_bar', async () => {
    // Mutations: drop either column from RETURNING; add the flag to the PATCH response (CONTRACT §3 keeps
    // it GET-only, computed, never stored).
    const { status, body } = await call('PATCH', { more_pins: PINS })
    expect(status).toBe(200)
    const ret = prefsWrite()[0].text.match(/RETURNING([\s\S]*)$/)[1].split(',').map((s) => s.trim())
    expect(ret).toContain('more_pins')
    expect(ret).toContain('bar_layout')
    expect(ret).not.toContain('can_edit_bar')
    expect(body.more_pins).toEqual(PINS)
    expect(body.bar_layout).toEqual(LAYOUT)
    expect(body).not.toHaveProperty('can_edit_bar')
  })

  it('an absent or null key binds SQL NULL, so COALESCE keeps the stored value', async () => {
    // Mutation: stringify without the null guard. JSON.stringify(null) is the STRING 'null', which
    // ::jsonb turns into a JSON null that COALESCE would write over the stored pins (and the shape CHECK
    // refuses), so every unrelated save would wipe or break them.
    for (const body of [{ critter_visit: 'off' }, { critter_visit: 'off', more_pins: null, bar_layout: null }]) {
      resetStubs()
      stubState.verifyTokenResult = { sub: DAVE }
      expect((await call('PATCH', body)).status).toBe(200)
      const c = prefsWrite()[0]
      const { cols, entries } = insertShape(c)
      for (const col of ['more_pins', 'bar_layout']) {
        expect(valueAt(c, entries[cols.indexOf(col)].at), `${col} VALUES`).toBeNull()
        expect(coalesceArm(c, col)?.value, `${col} COALESCE`).toBeNull()
      }
    }
  })

  it('[] is bound as "[]" — the only way to clear pins through a COALESCE merge', async () => {
    // Mutation: treat an empty list as absent (e.g. `mpArr?.length ? … : null`): the last unpin would
    // then silently keep the pin (seat-regression U4).
    expect((await call('PATCH', { more_pins: [] })).status).toBe(200)
    const c = prefsWrite()[0]
    const { cols, entries } = insertShape(c)
    expect(valueAt(c, entries[cols.indexOf('more_pins')].at)).toBe('[]')
    expect(coalesceArm(c, 'more_pins')?.value).toBe('[]')
  })

  it('each key alone reaches the write — mutation: leave either out of HAS_UPDATABLE', async () => {
    for (const body of [{ more_pins: ['seeds'] }, { bar_layout: { order: DEFAULT_ORDER, hidden: [] } }]) {
      resetStubs()
      stubState.verifyTokenResult = { sub: DAVE }
      const { status } = await call('PATCH', body)
      expect({ body, status }).toEqual({ body, status: 200 })
      expect(prefsWrite()).toHaveLength(1)
    }
  })

  it('a valid order with a bad hidden is refused WHOLE: 400 naming the field, and no statement is sent', async () => {
    // Mutation: validate after (or apart from) building the write, or apply the valid parts.
    const { status, body } = await call('PATCH', {
      critter_visit: 'off',
      more_pins: ['seeds'],
      bar_layout: { order: DEFAULT_ORDER, hidden: ['create'] },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/^bar_layout\.hidden /)
    expect(stubState.sqlCalls).toEqual([])
  })

  it('the write is to the caller\'s own row and needs no admin — Jen, not on the allowlist, saves her bar', async () => {
    // CONTRACT §3: self-scoped, NOT admin-gated; can_edit_bar only decides who SEES the editor (D3).
    // Mutation: gate bar_layout writes on isAdmin/adminRefusal.
    process.env.ADMIN_CLERK_SUBS = DAVE
    stubState.verifyTokenResult = { sub: JEN }
    const { status } = await call('PATCH', { bar_layout: LAYOUT })
    expect(status).toBe(200)
    const c = prefsWrite()[0]
    const { cols, entries } = insertShape(c)
    expect(valueAt(c, entries[cols.indexOf('created_by')].at)).toBe(JEN)
  })
})
