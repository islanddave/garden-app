// Put-Up release 1a — the DATE ECHO exit proof (V4's legacy-PUT section, "From 1a"; lead condition 6).
//
// THE QUESTION. The shipped RecordRow's Edit and its one-tap Mark used both send buildFullPayload(rec):
// a full replace that echoes the row's own preserved_at and use_by_target back to the PUT, which writes
// them verbatim. If the echo is not byte-for-byte the stored calendar day, every tap moves the jar's
// dates. (Release F's bundle sends no echo at all — see shippedEcho below for why this still runs.)
//
// THE WIRE, established rather than assumed. The Lambda's driver (@neondatabase/serverless 0.10.4, the
// version lambda/preservation/package-lock.json ships) registers a parser for DATE (oid 1082) that
// builds `new Date(year, month - 1, day)` — local midnight of the stored day in the LAMBDA's zone, and
// the Lambda runs in UTC. resp() then JSON.stringifies the row, so a DATE reaches the phone as
// "2026-09-28T00:00:00.000Z". Confirmed on 2026-09-29 with that driver version, TZ=UTC, one read-only
// literal SELECT against staging (staging's preservation_log was empty): {"preserved_at":
// "2026-09-28T00:00:00.000Z","use_by_target":"2027-09-28T00:00:00.000Z"}. driverDate() below
// reproduces the parser and runs it in UTC, and the REAL handler (lambda/preservation/index.js, under
// the vitest stubs) projects and serialises it, so what reaches buildFullPayload is the real body.
//
// THE PHONE is in America/New_York. This file switches the process zone itself rather than trusting
// the runner's: CI runs the whole suite once in UTC (where the defect cannot show) and once in ET,
// and a proof that only bites in one of the two would read green in the other.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { stubState, resetStubs } from '../../lambda/_test-stubs/state.js'
import { ymd, prettyDate } from '../pages/PutUp.jsx'
import { preservedOn } from '../components/putup/JarPicker.jsx'
import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'

const { handler } = await import('../../lambda/preservation/index.js')

// THE SHIPPED ECHO, FROZEN. Release F retired buildFullPayload from PutUp.jsx — no write from the F
// bundle echoes a row back (Mark used is POST /api/pantry/uses, an Edit is one PATCH of what changed) —
// but the bundles already on phones send exactly this full-replace body, built with the page's own
// ymd(), and the Lambda's PUT keeps answering it. Copied verbatim from the shipped PutUp.jsx
// (origin/main 22e7db7cbc787129706126dbe5bfdb93ab8d63e7), so this proof still covers the phones that
// send it. Retire it with the legacy PUT.
const shippedEcho = (rec, overrides = {}) => ({
  crop_type_slug: rec.crop_type_slug ?? null,
  variety_id: rec.variety_id ?? null,
  plant_id: rec.plant_id ?? null,
  harvest_log_id: rec.harvest_log_id ?? null,
  preserved_at: ymd(rec.preserved_at),
  preserved_at_approx: rec.preserved_at_approx ?? null,
  method: rec.method,
  method_other_text: rec.method_other_text ?? null,
  quantity_value: rec.quantity_value,
  quantity_unit: rec.quantity_unit,
  package_count: rec.package_count ?? 1,
  storage_location_id: rec.storage_location_id ?? null,
  use_by_target: rec.use_by_target ? ymd(rec.use_by_target) : null,
  remaining_count: rec.remaining_count ?? null,
  consumed_at: rec.consumed_at ?? null,
  notes: rec.notes ?? null,
  photo_id: rec.photo_id ?? null,
  source_kind: rec.source_kind ?? null,
  source_label: rec.source_label ?? null,
  ...overrides,
})

const LAMBDA_TZ = 'UTC'
const PHONE_TZ = 'America/New_York'
const ORIGINAL_TZ = process.env.TZ
const setZone = (tz) => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz }
const inZone = async (tz, fn) => { setZone(tz); try { return await fn() } finally { setZone(PHONE_TZ) } }

// The driver's DATE parser (postgres-date's getDate, bundled in the driver): a DATE string becomes
// local midnight of that day in whatever zone the process is in. Called only inside inZone(LAMBDA_TZ).
const driverDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }

const USER = 'user_stub_dave'
const JAR = '3a1c2b4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const PLACE = '7b2e9f10-1c3d-4e5f-8a9b-0c1d2e3f4a5b'
const PLANTING = '9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f'
const STORED = { preserved_at: '2026-09-28', use_by_target: '2027-09-28', planting_sown_at: '2026-05-12' }

// One preservation_log row as the driver hands it to the handler (a whole_freeze in a deep freezer,
// the shape of the live rows): DATE → Date, numeric → string, integer → number, timestamptz → Date.
const driverRow = () => ({
  id: JAR, user_id: USER, crop_type_slug: 'pepper', variety_id: null, plant_id: PLANTING,
  harvest_log_id: null, batch_id: null,
  preserved_at: driverDate(STORED.preserved_at), preserved_at_approx: null,
  method: 'whole_freeze', method_other_text: null, quantity_value: '2.50', quantity_unit: 'quarts',
  package_count: 3, storage_location_id: PLACE, use_by_target: driverDate(STORED.use_by_target),
  remaining_count: 3, consumed_at: null, notes: null, photo_id: null,
  source_kind: null, source_label: null,
  created_at: new Date('2026-09-28T21:14:05.123Z'), updated_at: null, deleted_at: null,
  storage_label: 'Chest Freezer 1', storage_kind: 'deep_freezer', crop_display_name: 'Pepper',
  planting_name: 'Serranos', planting_sown_at: driverDate(STORED.planting_sown_at),
  planting_succession_order: null, planting_variety_name: null,
})

const event = (method, rawPath, body, query) => ({
  requestContext: { http: { method } },
  rawPath,
  headers: { authorization: 'Bearer stub-token' },
  queryStringParameters: query ?? null,
  body: body === undefined ? undefined : JSON.stringify(body),
})

// The value bound to ONE named placeholder (the stub joins the template strings with '?').
const boundAfter = (call, re) => {
  const m = call.text.match(re)
  expect(m, `SQL does not match ${re}`).toBeTruthy()
  const end = m.index + m[0].length
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?')
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length]
}

// GET /api/preservation/:id through the real handler, in the Lambda's zone; the parsed JSON body is
// exactly what apiFetch hands RecordRow.
async function getAsThePhoneSeesIt() {
  return inZone(LAMBDA_TZ, async () => {
    stubState.sqlHandler = () => [driverRow()]
    const res = await handler(event('GET', `/api/preservation/${JAR}`))
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.body)
  })
}

beforeEach(() => {
  resetStubs()
  stubState.verifyTokenResult = { sub: USER }
  setZone(PHONE_TZ)
})
afterEach(() => setZone(ORIGINAL_TZ))

describe('the zones this proof depends on are really in force', () => {
  // INSTRUMENT CHECK. If the runtime ignored a TZ change, every assertion below would pass in UTC for
  // the wrong reason — the exact vacuity this file exists to remove.
  it('the phone zone reads UTC midnight as the evening before; the Lambda zone does not', async () => {
    const utcMidnight = new Date('2026-09-28T00:00:00.000Z')
    expect(utcMidnight.getDate()).toBe(27)
    await inZone(LAMBDA_TZ, () => expect(utcMidnight.getDate()).toBe(28))
    expect(driverDate('2026-09-28').getDate()).toBe(28)
  })
})

describe('an untouched echo leaves the stored dates unchanged (the 1a exit proof)', () => {
  it('GET → the shipped echo sends back the calendar days that are stored', async () => {
    const rec = await getAsThePhoneSeesIt()
    const payload = shippedEcho(rec)
    expect(payload.preserved_at).toBe(STORED.preserved_at)
    expect(payload.use_by_target).toBe(STORED.use_by_target)
  })

  // The projection reads the driver's Date with LOCAL getters. In the Lambda's UTC that equals
  // toISOString, so this case runs the handler in a zone EAST of UTC, where local midnight is the
  // previous day's evening in UTC and only the local reading still yields the stored day.
  it('the day survives a Lambda whose zone is not UTC', async () => {
    const body = await inZone('Asia/Tokyo', async () => {
      stubState.sqlHandler = () => [driverRow()]
      const res = await handler(event('GET', `/api/preservation/${JAR}`))
      return JSON.parse(res.body)
    })
    expect(body.preserved_at).toBe(STORED.preserved_at)
    expect(body.use_by_target).toBe(STORED.use_by_target)
  })

  it('…and the PUT that echo drives binds those same days, so Mark used moves no date', async () => {
    const rec = await getAsThePhoneSeesIt()
    const payload = shippedEcho(rec, { remaining_count: 2 })   // exactly what the shipped markUsed sends
    await inZone(LAMBDA_TZ, async () => {
      stubState.sqlCalls = []
      stubState.sqlHandler = (text) => {
        if (/FROM storage_location/.test(text)) return [{ id: PLACE, kind: 'deep_freezer' }]
        if (/FROM garden_node/.test(text)) return [{ id: PLANTING, variety_id: null, crop_type_slug: 'pepper' }]
        // The PUT statement's shape since 1a's count rule: the written row beside the snapshot counts.
        // Release 1b adds stored_stale (the echo rule's explanation) to the snapshot.
        return [{ ...driverRow(), remaining_count: 2, stored_package_count: 3, stored_remaining_count: 3, stored_stale: false }]
      }
      const res = await handler(event('PUT', `/api/preservation/${JAR}`, payload))
      expect(res.statusCode).toBe(200)
    })
    const update = stubState.sqlCalls.find((c) => /UPDATE preservation_log SET/.test(c.text))
    expect(update, 'the PUT never reached its UPDATE').toBeTruthy()
    // Release 1b: preserved_at is COALESCE(sent, stored) and use_by_target is no longer written by
    // this PUT at all — the echoed day is bound only to the equality test that refuses a differing
    // one (V4 "From 1b"). Either way the day that reaches Postgres must be the stored calendar day.
    expect(boundAfter(update, /preserved_at\s+= COALESCE\(/)).toBe(STORED.preserved_at)
    expect(update.text).toMatch(/use_by_target\s+= use_by_target,/)
    expect(boundAfter(update, /\(NOT \?::boolean OR (?=\?::date)/)).toBe(STORED.use_by_target)
  })
})

describe('every reader of these fields shows the stored calendar day (the census, run in ET)', () => {
  // PutUp.jsx RecordRow prints prettyDate(preserved_at / use_by_target / planting_sown_at) and its
  // editor seeds the date input with ymd(use_by_target): the shape the GET now returns, read the way
  // those two helpers read it.
  it('PutUp.jsx ymd / prettyDate render the GET body as the stored day', async () => {
    const rec = await getAsThePhoneSeesIt()
    expect(rec.preserved_at).toBe(STORED.preserved_at)
    expect(rec.use_by_target).toBe(STORED.use_by_target)
    expect(rec.planting_sown_at).toBe(STORED.planting_sown_at)
    expect(ymd(rec.use_by_target)).toBe(STORED.use_by_target)
    expect(prettyDate(rec.preserved_at)).toBe('Sep 28, 2026')
    expect(prettyDate(rec.use_by_target)).toBe('Sep 28, 2027')
    expect(prettyDate(rec.planting_sown_at)).toBe('May 12, 2026')
  })

  // The defect, kept visible: the same helpers fed the shape the GET used to send show the day before.
  it('the old serialisation (a UTC-midnight instant) reads a day early through the same helpers', () => {
    expect(ymd('2026-09-28T00:00:00.000Z')).toBe('2026-09-27')
    expect(prettyDate('2026-09-28T00:00:00.000Z')).toBe('Sep 27, 2026')
  })

  // JarPicker and BatchDetailView print preservedOn(preserved_at), which reads the text and never a
  // Date: correct for the old shape and the new one alike.
  it('JarPicker / BatchDetailView preservedOn reads either shape as the stored day', async () => {
    const rec = await getAsThePhoneSeesIt()
    expect(preservedOn(rec.preserved_at)).toBe('Sep 28')
    expect(preservedOn('2026-09-28T00:00:00.000Z')).toBe('Sep 28')
  })

  // PutUpFromPlanting renders what the planting page shows, off whats-put-up — rendered here from the
  // real handler's body for that route, in the phone's zone.
  it('the planting page (PutUpFromPlanting) renders the stored days', async () => {
    const body = await inZone(LAMBDA_TZ, async () => {
      stubState.sqlHandler = () => [driverRow()]
      const res = await handler(event('GET', '/api/preservation/whats-put-up', undefined,
        { plant_id: PLANTING, include_consumed: '1' }))
      expect(res.statusCode).toBe(200)
      return JSON.parse(res.body)
    })
    const fetch = () => Promise.resolve(body)
    // createElement, not JSX: this file is .js, which the transform does not treat as JSX.
    // `now` is pinned: the date sentence says a year only when it is not this one.
    render(React.createElement(MemoryRouter, null,
      React.createElement(PutUpFromPlanting, { planting: { id: PLANTING }, fetch, now: new Date(2026, 9, 1, 12, 0, 0) })))
    await waitFor(() => expect(screen.getByText(/Chest Freezer 1/)).toBeTruthy())
    const text = document.body.textContent
    expect(text).toContain('put up Sep 28, 2026')
    // Put-Up UX pass R1: the row's date sentence is the Pantry's (jarWords.discardWords) — "discard by", read
    // from the day's own three parts. A frozen jar is not cured or cellared produce, so it never says "use by".
    expect(text).toContain('discard by Sep 28, 2027')
    expect(text).not.toContain('use by')
    // THE OFF-BY-ONE, for both days this row prints: neither is read a day early west of Greenwich.
    expect(text).not.toContain('Sep 27, 2026')
    expect(text).not.toContain('Sep 27')
  })
})
