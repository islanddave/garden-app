// BUG-PUTUPREPLAYDROPSEDIT-001 — a keyed create answered `replayed: true` is READ, and what the sheet holds
// is put on the row the first Save made.
// The server keeps a create's key and nothing of its body, and the key does not change with the body (plan
// R2 V2 "Retry key": a second row is worse than a lost change). So a Save whose answer was lost, a change, and
// Save again came back as a success that did not hold the change. The rule lives in
// components/kitchen/idempotencyKey.js (sendPrint, noteSent, afterReplay). This file holds the rule and three
// of the creates that follow it: the recipe sheet, Save as recipe, How it was made. The Put something up
// door and the Walk (the pantry item) are in PutUpReplayEdit.pantry.test.jsx.
//
// FOR EACH CREATE:
//   • a first-time create (not replayed) → no update call;
//   • the same body replayed → no update call, and it is saved;
//   • a changed body replayed, the row THIS SITTING'S (sent from the sheet that is open, made minutes ago,
//     untouched since) → the SAME key, exactly one update call, to the id the replay answered with, carrying
//     the change; what the sheet hands on shows the changed values;
//   • a changed body replayed, the row NOT this sitting's (a restored draft, an older row, one changed since)
//     → NOTHING is written; the sheet says it was saved earlier and this Save changed nothing (review B1),
//     the line is brought into view (QA Q2), and the key is KEPT: Save again is refused again (QA Q3);
//   • a replayed row that already holds exactly what the sheet shows → a save, nothing written (QA Q3);
//   • the update fails → the sheet says the row is there and the change did not save (may not have), the
//     page is told, the change is still in the form, nothing is handed on as saved; Save again works (I3);
//   • NEVER a second create under a new key, whatever the sheet has said.
// MUTATIONS (each run, each red here): see the lane reports putupreplay2-20261007, putupreplay3-20261007 and
// putupreplay4-20261007.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }), apiFetch: (...a) => fetchSpy(...a) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))

import {
  payloadPrint, sendPrint, noteSent, afterReplay, rowIsThisSittings, whenChoice, answerLost, sameFact, REPLAY_FRESH_MS, REPLAY_CLOCK_SLACK_MS,
  updateSent, holdsOwnUpdate, rowHoldsFields, answeredNo,
} from '../components/kitchen/idempotencyKey.js'
import RecipeSheet, { isRecipeDraft, recipeStaleText } from '../components/recipes/RecipeSheet.jsx'
import { recipeHolds, emptyDraft } from '../components/recipes/recipes.js'
import RecipesView from '../components/recipes/RecipesView.jsx'
import BatchRecipeRow from '../components/recipes/BatchRecipeRow.jsx'
import HowItWasMadeSheet, { REPLAY_NOT_ON_IT, REPLAY_CHANGE_UNSAVED, REPLAY_CHANGE_MAYBE } from '../components/putup/HowItWasMadeSheet.jsx'
import { SHEET_DRAFT_PREFIX } from '../components/kitchen/sheetDraft.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const LOST = () => { throw new TypeError('Failed to fetch') }       // the request may have landed; its answer did not come back
const apiError = (status, body) => Object.assign(new Error(body?.error ?? `HTTP ${status}`), { status, body })

// `routes`: 'METHOD /path' → (body, nth call of that route) => answer. A route that throws is a rejected fetch.
function wire(routes = {}) {
  const seen = {}
  fetchSpy.mockImplementation((path, o = {}) => {
    const id = `${(o.method ?? 'GET').toUpperCase()} ${path}`
    const hit = routes[id]
    if (!hit) return Promise.resolve(null)
    seen[id] = (seen[id] ?? 0) + 1
    try { return Promise.resolve(hit(o.body ? JSON.parse(o.body) : null, seen[id])) } catch (e) { return Promise.reject(e) }
  })
}
const sentTo = (method, path) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method).map(([, o]) => JSON.parse(o.body))
const posts = (path) => sentTo('POST', path)
const keys = (path) => posts(path).map(b => b.idempotency_key)
// Every write that is not a POST to `path`: [method, path] pairs.
const otherWrites = (path) => fetchSpy.mock.calls.filter(([p, o]) => o?.method && o.method !== 'GET' && !(p === path && o.method === 'POST')).map(([p, o]) => [o.method, p])
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const type = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })
// A row's two stamps, as the routes answer them. The rule reads them against the real clock, so they are
// made from it: made half a minute ago and untouched (the two are one), unless a test says otherwise.
// The clock is read ONCE, so "untouched" is the same instant twice.
const stamps = (madeAgoMs = 30 * 1000, touchedAgoMs = madeAgoMs) => {
  const now = Date.now()
  return { created_at: new Date(now - madeAgoMs).toISOString(), updated_at: new Date(now - touchedAgoMs).toISOString() }
}
// A minute past the bound (REPLAY_FRESH_MS, pinned at ten minutes below).
const LONG_AGO = 11 * 60 * 1000

beforeEach(() => { fetchSpy.mockReset(); wire(); localStorage.clear(); clearReloadBlocks() })
afterEach(() => { cleanup(); clearReloadBlocks(); delete Element.prototype.scrollIntoView })
// jsdom has no scrollIntoView. A stand-in that records what it was called on, for the tests that ask whether
// a line was brought into view (QA Q2); taken away again after each.
function watchScrolls() {
  const on = []
  Element.prototype.scrollIntoView = function scrollIntoView() { on.push(this) }
  return on
}
const broughtIntoView = (on, id) => on.some(el => el === screen.getByTestId(id) || el.contains(screen.getByTestId(id)))

describe('the rule — idempotencyKey.js', () => {
  const BODY = { idempotency_key: 'k', name: 'Corn', notes: 'two bags', plant_id: null }
  const FIXED = ['plant_id', 'crop_type_slug']

  it('the print: the same content whatever the key order, without the body\'s own key; any change changes it', () => {
    expect(payloadPrint({ notes: 'two bags', name: 'Corn', plant_id: null, idempotency_key: 'other' })).toBe(payloadPrint(BODY))
    expect(payloadPrint({ ...BODY, notes: 'three bags' })).not.toBe(payloadPrint(BODY))
    expect(payloadPrint(null)).toBe(payloadPrint({}))
  })

  it('a send\'s print has two halves: what the update route can carry, and the named keys it cannot', () => {
    const p = sendPrint(BODY, FIXED)
    expect(p).toMatch(/^[0-9a-z.]+\/[0-9a-z.]+$/)
    const half = (s, i) => s.split('/')[i]
    const noted = sendPrint({ ...BODY, notes: 'three bags' }, FIXED)
    expect([half(noted, 0) === half(p, 0), half(noted, 1) === half(p, 1)]).toEqual([false, true])
    const planted = sendPrint({ ...BODY, plant_id: 'p1' }, FIXED)
    expect([half(planted, 0) === half(p, 0), half(planted, 1) === half(p, 1)]).toEqual([true, false])
    // A fixed key the body leaves out prints as null: absent and null are the same thing to the row.
    const { plant_id: _gone, ...without } = BODY
    expect(sendPrint(without, FIXED)).toBe(p)
    expect(sendPrint(BODY)).toBe(`${payloadPrint(BODY)}/${payloadPrint({})}`)
  })

  it('noteSent keeps each different print once, in the order sent; a stored value that is not a list of strings is nothing sent', () => {
    expect(noteSent(undefined, 'a/x')).toEqual(['a/x'])
    expect(noteSent(['a/x'], 'a/x')).toEqual(['a/x'])
    expect(noteSent(['a/x'], 'b/x')).toEqual(['a/x', 'b/x'])
    expect(noteSent('a/x', 'b/x')).toEqual(['b/x'])
    expect(noteSent(['a/x', 7, null], 'b/x')).toEqual(['a/x', 'b/x'])
  })

  it('afterReplay: null unless the answer says replayed; null when no other body ever went out under the key', () => {
    expect(afterReplay({ id: 1 }, ['a/x', 'b/x'], 'b/x')).toBeNull()
    expect(afterReplay({ id: 1, replayed: false }, ['a/x', 'b/x'], 'b/x')).toBeNull()
    expect(afterReplay(null, ['a/x', 'b/x'], 'b/x')).toBeNull()
    expect(afterReplay({ replayed: true }, ['b/x'], 'b/x')).toBeNull()
    expect(afterReplay({ replayed: true }, [], 'b/x')).toBeNull()              // a key this client has no record for
    expect(afterReplay({ replayed: true }, undefined, 'b/x')).toBeNull()
  })

  it('Q3 — afterReplay: a row that already HOLDS the body in hand is saved (null) — this sitting\'s or not, restored or not — unless a fixed part differs; `holds` unsaid is not holding', () => {
    const own = { row: stamps() }
    const old = { row: stamps(LONG_AGO) }
    for (const opts of [own, old, { ...own, mine: false }, { row: null }, { row: stamps(60 * 1000, 20 * 1000) }]) {
      expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x', { ...opts, holds: true })).toBeNull()
    }
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x', { ...old, holds: false })).toBe('stale')
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x', { ...old, holds: 'yes' })).toBe('stale')
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x', old)).toBe('stale')
    // A fixed part that differs is never "held": by the prints, and by the caller's own reading.
    expect(afterReplay({ replayed: true }, ['b/y', 'b/x'], 'b/x', { ...own, holds: true })).toBe('fixed')
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x', { ...own, fixed: true, holds: true })).toBe('fixed')
    expect(afterReplay({ replayed: true }, ['b/y', 'b/x'], 'b/x', { ...old, holds: true })).toBe('stale')
  })

  it('Q3 — sameFact: nothing is nothing (null, undefined, blank), text is compared trimmed; an amount as a number only when asked; case only when asked', () => {
    expect([sameFact(null, undefined), sameFact('', null), sameFact('  ', undefined), sameFact(' a ', 'a'), sameFact(3, '3')]).toEqual([true, true, true, true, true])
    expect([sameFact('a', 'b'), sameFact('a', null), sameFact(0, null), sameFact('A', 'a'), sameFact('2', '2.000')]).toEqual([false, false, false, false, false])
    expect([sameFact('2', '2.000', { numeric: true }), sameFact(2.5, '2.50', { numeric: true }), sameFact('2', 3, { numeric: true }), sameFact('lb', 'lb', { numeric: true })]).toEqual([true, true, false, true])
    expect([sameFact('Garage Fridge', 'garage fridge', { fold: true }), sameFact('Garage', 'Cellar', { fold: true })]).toEqual([true, false])
  })

  it('afterReplay: another body went out and the row is this sitting\'s → update; one that differs in a fixed part → fixed, whatever else differs', () => {
    const own = { row: stamps() }
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x', own)).toBe('update')
    expect(afterReplay({ replayed: true }, ['a/x'], 'b/x', own)).toBe('update')     // the list not yet holding this print
    expect(afterReplay({ replayed: true }, ['b/y', 'b/x'], 'b/x', own)).toBe('fixed')
    expect(afterReplay({ replayed: true }, ['a/x', 'a/y', 'b/x'], 'b/x', own)).toBe('fixed')
    // Sent, changed, sent, put back: the row may hold either, so the body in hand goes onto it.
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'a/x', own)).toBe('update')
    // The caller's own reading of the fixed part (off the row) is taken in place of the prints'.
    expect(afterReplay({ replayed: true }, ['b/y', 'b/x'], 'b/x', { ...own, fixed: false })).toBe('update')
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x', { ...own, fixed: true })).toBe('fixed')
  })

  it('B1 — afterReplay: another body went out and the row is NOT this sitting\'s → stale, whatever else: a key whose `sent` came out of storage, a row made too long ago, a row touched since, a row with no stamps, no row', () => {
    const sent = ['a/x', 'b/x']
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: stamps(), mine: false })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: stamps(LONG_AGO) })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: stamps(60 * 1000, 10 * 1000) })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: { id: 1 } })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: null })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x')).toBe('stale')
    // … a fixed part included: nothing is written either way, and "saved earlier" is the truer sentence.
    expect(afterReplay({ replayed: true }, ['b/y', 'b/x'], 'b/x', { row: stamps(LONG_AGO) })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: stamps(LONG_AGO), fixed: true })).toBe('stale')
    // One body only is still nothing to do, whatever the row: an untouched retry writes nothing.
    expect(afterReplay({ replayed: true }, ['b/x'], 'b/x', { row: stamps(LONG_AGO), mine: false })).toBeNull()
  })

  it('the sheet\'s OWN update is not "changed since": once it has sent one to this row, a moved updated_at is its own (landed, its answer lost) and Save again may finish it — inside the bound, and never for a key out of storage', () => {
    const sent = ['a/x', 'b/x']
    const touched = stamps(60 * 1000, 10 * 1000)
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: touched })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: touched, updatedHere: true })).toBe('update')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: stamps(LONG_AGO, 10 * 1000), updatedHere: true })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: touched, updatedHere: true, mine: false })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: { created_at: touched.created_at }, updatedHere: true })).toBe('stale')
    // No answer at all (no status, or 0) is a write that may have landed; an answered 4xx or 5xx did not.
    expect([answerLost(new TypeError('Failed to fetch')), answerLost({ status: 0 }), answerLost(null)]).toEqual([true, true, true])
    expect([answerLost({ status: 400 }), answerLost({ status: 503 })]).toEqual([false, false])
  })

  it('B1 — the bound: ten minutes, read off created_at; updated_at must be the same instant; a stamp ahead of this clock by more than the slack is not judged', () => {
    expect(REPLAY_FRESH_MS).toBe(10 * 60 * 1000)
    expect(LONG_AGO).toBeGreaterThan(REPLAY_FRESH_MS)
    expect(REPLAY_CLOCK_SLACK_MS).toBe(60 * 1000)
    const now = Date.UTC(2026, 9, 7, 12, 0, 0)
    const at = (ms) => new Date(now - ms).toISOString()
    const row = (madeAgo, touchedAgo = madeAgo) => ({ created_at: at(madeAgo), updated_at: at(touchedAgo) })
    expect(rowIsThisSittings(row(0), now)).toBe(true)
    expect(rowIsThisSittings(row(REPLAY_FRESH_MS), now)).toBe(true)
    expect(rowIsThisSittings(row(REPLAY_FRESH_MS + 1), now)).toBe(false)
    expect(rowIsThisSittings(row(-REPLAY_CLOCK_SLACK_MS), now)).toBe(true)        // this phone's clock a little behind the server's
    expect(rowIsThisSittings(row(-REPLAY_CLOCK_SLACK_MS - 1), now)).toBe(false)
    expect(rowIsThisSittings(row(5000, 4999), now)).toBe(false)                   // touched one millisecond after it was made
    expect(rowIsThisSittings({ created_at: at(5000) }, now)).toBe(false)
    expect(rowIsThisSittings({ updated_at: at(5000) }, now)).toBe(false)
    expect(rowIsThisSittings({ created_at: null, updated_at: null }, now)).toBe(false)
    expect(rowIsThisSittings({ created_at: 'soon', updated_at: 'soon' }, now)).toBe(false)
    expect(rowIsThisSittings(null, now)).toBe(false)
    // The two stamps as Date objects (a Lambda row before it is serialised) read the same as their ISO text.
    expect(rowIsThisSittings({ created_at: new Date(now - 5000), updated_at: new Date(now - 5000) }, now)).toBe(true)
    // The same instant written two ways is the same instant.
    expect(rowIsThisSittings({ created_at: '2026-10-07T11:59:55.000Z', updated_at: '2026-10-07T11:59:55Z' }, now)).toBe(true)
  })

  it('QA B-1 — a NULL updated_at beside a real created_at is "untouched" ONLY for a table that says its create leaves it NULL (the jar\'s); every other table stamps both at insert, and a NULL there stays not this sitting\'s', () => {
    const now = Date.UTC(2026, 9, 7, 12, 0, 0)
    const at = (ms) => new Date(now - ms).toISOString()
    const jar = { nullIsUntouched: true }
    const fresh = { created_at: at(5000), updated_at: null }
    expect(rowIsThisSittings(fresh, now)).toBe(false)                              // an item, a recipe, a batch
    expect(rowIsThisSittings(fresh, now, false, { nullIsUntouched: false })).toBe(false)
    expect(rowIsThisSittings(fresh, now, false, jar)).toBe(true)
    // The bound and the clock slack are read off created_at exactly as before.
    expect(rowIsThisSittings({ created_at: at(REPLAY_FRESH_MS), updated_at: null }, now, false, jar)).toBe(true)
    expect(rowIsThisSittings({ created_at: at(REPLAY_FRESH_MS + 1), updated_at: null }, now, false, jar)).toBe(false)
    expect(rowIsThisSittings({ created_at: at(-REPLAY_CLOCK_SLACK_MS - 1), updated_at: null }, now, false, jar)).toBe(false)
    // The row must SAY null: a row with no updated_at key, a blank one, or no created_at is not one this reads.
    expect(rowIsThisSittings({ created_at: at(5000) }, now, false, jar)).toBe(false)
    expect(rowIsThisSittings({ created_at: at(5000), updated_at: '' }, now, false, jar)).toBe(false)
    expect(rowIsThisSittings({ created_at: null, updated_at: null }, now, false, jar)).toBe(false)
    expect(rowIsThisSittings({ updated_at: null }, now, false, jar)).toBe(false)
    // Once anything has written to the jar its updated_at is a stamp, and the rule is the one every table has:
    // moved is touched, unless it is this sheet's own update (`updatedHere`).
    expect(rowIsThisSittings({ created_at: at(5000), updated_at: at(4000) }, now, false, jar)).toBe(false)
    expect(rowIsThisSittings({ created_at: at(5000), updated_at: at(4000) }, now, true, jar)).toBe(true)
    expect(rowIsThisSittings({ created_at: at(5000), updated_at: at(5000) }, now, false, jar)).toBe(true)
    // afterReplay passes the table's word through, and nothing else about its answer changes.
    const sent = ['a/x', 'b/x']
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: fresh, nowMs: now })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: fresh, nowMs: now, nullIsUntouched: true })).toBe('update')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: fresh, nowMs: now, nullIsUntouched: true, mine: false })).toBe('stale')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: fresh, nowMs: now, nullIsUntouched: true, fixed: true })).toBe('fixed')
  })

  it('QA I-2 — the sheet\'s own update is known by what it SENT: holdsOwnUpdate is true only for the row that update went to, and only while it still holds every field sent', () => {
    const last = updateSent('r1', { name: 'Mojo verde', notes: null })
    expect(last).toEqual({ id: 'r1', body: { name: 'Mojo verde', notes: null } })
    expect(updateSent(null, { name: 'x' })).toBeNull()
    expect(holdsOwnUpdate({ id: 'r1', name: 'Mojo verde', notes: null, kind: 'theirs' }, last)).toBe(true)     // a field it did not send is not its to judge
    expect(holdsOwnUpdate({ id: 'r1', name: ' Mojo verde ', notes: '' }, last)).toBe(true)                     // one fact (sameFact)
    expect(holdsOwnUpdate({ id: 'r1', name: 'Mojo (Jen)', notes: null }, last)).toBe(false)
    expect(holdsOwnUpdate({ id: 'r1', name: 'Mojo verde', notes: 'theirs' }, last)).toBe(false)
    expect(holdsOwnUpdate({ id: 'r1', name: 'Mojo verde' }, last)).toBe(true)                                  // an absent key is nothing, as null is
    expect(holdsOwnUpdate({ id: 'r2', name: 'Mojo verde', notes: null }, last)).toBe(false)                    // another row
    expect(holdsOwnUpdate({ id: 'r1', name: 'Mojo verde', notes: null, deleted_at: '2026-10-08T00:00:00Z' }, last)).toBe(false)
    expect(holdsOwnUpdate({ name: 'Mojo verde', notes: null }, last)).toBe(false)                              // a row with no id
    expect(holdsOwnUpdate({ id: 'r1', name: 'Mojo verde', notes: null }, null)).toBe(false)                    // no update was ever sent
    expect(holdsOwnUpdate(null, last)).toBe(false)
    expect(holdsOwnUpdate({ id: 'r1' }, updateSent('r1', {}))).toBe(false)                                     // an update that sent nothing proves nothing
    // A field that is not one key holding one value is read the sheet's way; the rest stay sameFact.
    const reads = { count: (v, row) => Number(v) === Number(row.package_count) }
    expect(holdsOwnUpdate({ id: 'r1', package_count: '2', name: 'a' }, updateSent('r1', { count: 2, name: 'a' }), reads)).toBe(true)
    expect(holdsOwnUpdate({ id: 'r1', package_count: '3', name: 'a' }, updateSent('r1', { count: 2, name: 'a' }), reads)).toBe(false)
    expect(holdsOwnUpdate({ id: 'r1', package_count: '2', name: 'b' }, updateSent('r1', { count: 2, name: 'a' }), reads)).toBe(false)
    expect(rowHoldsFields({ package_count: '2' }, { count: 2 }, reads)).toBe(true)
    expect([rowHoldsFields(null, { a: 1 }), rowHoldsFields({ a: 1 }, null), rowHoldsFields({ a: 1 }, {})]).toEqual([false, false, false])
    // A sheet whose update is the whole of what it shows passes ONE function — still only for the row it went to.
    const whole = (body, row) => body.n === row.n
    expect(holdsOwnUpdate({ id: 'r1', n: 1 }, updateSent('r1', { n: 1 }), whole)).toBe(true)
    expect(holdsOwnUpdate({ id: 'r1', n: 2 }, updateSent('r1', { n: 1 }), whole)).toBe(false)
    expect(holdsOwnUpdate({ id: 'r2', n: 1 }, updateSent('r1', { n: 1 }), () => true)).toBe(false)
    // And it is what makes a moved stamp this sheet's: afterReplay takes its answer as `updatedHere`.
    const touched = stamps(60 * 1000, 10 * 1000)
    const sent = ['a/x', 'b/x']
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: { ...touched, id: 'r1', name: 'Mojo verde', notes: null }, updatedHere: holdsOwnUpdate({ id: 'r1', name: 'Mojo verde', notes: null }, last) })).toBe('update')
    expect(afterReplay({ replayed: true }, sent, 'b/x', { row: { ...touched, id: 'r1', name: 'Mojo (Jen)', notes: null }, updatedHere: holdsOwnUpdate({ id: 'r1', name: 'Mojo (Jen)', notes: null }, last) })).toBe('stale')
    // An update the server ANSWERED with a 4xx did not land; anything else may have.
    expect([answeredNo({ status: 400 }), answeredNo({ status: 409 }), answeredNo({ status: 499 })]).toEqual([true, true, true])
    expect([answeredNo({ status: 500 }), answeredNo({ status: 0 }), answeredNo(new TypeError('Failed to fetch')), answeredNo(null)]).toEqual([false, false, false, false])
  })

  it('I2 — whenChoice: the chip as chosen, never a date the clock made of it; under Earlier… the window, or the day as picked', () => {
    expect(whenChoice('today', null, '')).toEqual(['today'])
    expect(whenChoice('today', 'last_month', '2026-09-01')).toEqual(['today'])     // what sits under Earlier… is not the answer
    expect(whenChoice('yesterday')).toEqual(['yesterday'])
    expect(whenChoice('unsure')).toEqual(['unsure'])
    expect(whenChoice('earlier', 'last_month', '2026-09-01')).toEqual(['earlier', 'last_month'])
    expect(whenChoice('earlier', 'pickdate', '2026-09-01')).toEqual(['pickdate', '2026-09-01'])
    expect(whenChoice('earlier', null)).toEqual(['earlier', null])
  })
})

describe('the recipe sheet — POST /api/recipes, then PATCH /api/recipes/:id', () => {
  const PATH = '/api/recipes'
  const ROW = '/api/recipes/r-first'
  const draft = () => JSON.parse(localStorage.getItem(`${SHEET_DRAFT_PREFIX}user_dave:recipe:new`))?.data ?? null
  const mount = () => {
    const onSaved = vi.fn()
    const onExists = vi.fn()
    render(<RecipeSheet open types={[]} fetch={fetchSpy} onClose={() => {}} onSaved={onSaved} onExists={onExists} />)
    return { onSaved, onExists }
  }
  const save = () => act(async () => { tap('recipe-save') })
  const errorText = () => screen.queryByTestId('recipe-sheet-error')?.textContent ?? null
  const failed = () => waitFor(() => expect(screen.getByTestId('recipe-sheet-error').textContent).toMatch(/Couldn't save it/))
  // The nth POST has been answered, one way or the other: the sheet says something, or hands the save on.
  const answered = async (h, nth) => {
    await waitFor(() => expect(posts(PATH)).toHaveLength(nth))
    await waitFor(() => expect(errorText() != null || h.onSaved.mock.calls.length > 0).toBe(true))
  }
  // The first POST lands and its answer is lost; every later one is answered with the recipe it made.
  const FIRST = { id: 'r-first', name: 'Mojo', notes: null, lines: [], ...stamps() }
  const lostThenReplayed = (patch = (b) => ({ recipe: { ...FIRST, ...b } }), first = FIRST) => wire({
    [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: first, replayed: true }),
    [`PATCH ${ROW}`]: patch,
  })
  const STALE = '“Mojo” was already saved earlier — it is with your recipes. This Save did not change it. To change it, open the recipe.'

  it('Q3 — the stale sentence promises no second recipe: the key is kept, so Save again is refused again', () => {
    expect(recipeStaleText(FIRST)).toBe(STALE)
    expect(recipeStaleText(null)).toBe('This recipe was already saved earlier — it is with your recipes. This Save did not change it. To change it, open the recipe.')
    for (const text of [STALE, recipeStaleText(null)]) { expect(text).not.toMatch(/Save again|to add|new recipe/i); expect(text).not.toMatch(BANNED) }
  })

  it('Q3 — recipeHolds: the recipe already holds what the sheet shows — every field of an edit\'s body, lines in order, a number as an amount; a fact the sheet does not show is not held', () => {
    const d = { ...emptyDraft(), name: 'Mojo', notes: 'pH 3.4', link: 'https://example.com/mojo', keepsN: '14', keepsUnit: 'day', keepsKind: 'fridge',
      vesselLabel: 'quart jar', vesselSize: '1', vesselUnit: 'qt', vesselCount: '2', bottleLabel: 'woozy', bottleSize: '5', bottleUnit: 'oz', bottleCooked: true, madeText: 'one bottle',
      lines: [{ name: 'garlic', amount: '2 heads', qty: '2', unit: 'head', atTheEnd: false }, { name: 'lime', amount: '', qty: '', unit: '', atTheEnd: true }] }
    const row = { id: 'r1', name: 'Mojo', kind: null, recipe_type_id: null, link_url: 'https://example.com/mojo', notes: 'pH 3.4',
      keeps_n: 14, keeps_unit: 'day', keeps_storage_kind: 'fridge', vessel_label: 'quart jar', vessel_size: '1.000', vessel_unit: 'qt', vessel_count: 2,
      bottle_label: 'woozy', bottle_size: '5.00', bottle_unit: 'oz', bottle_cooked: true, made_text: 'one bottle',
      lines: [{ id: 'l1', ordinal: 1, name: 'garlic', amount_text: '2 heads', qty: '2.000', qty_unit: 'head', at_the_end: false, form: null },
        { id: 'l2', ordinal: 2, name: 'lime', amount_text: null, qty: null, qty_unit: null, at_the_end: true }] }
    expect(recipeHolds(d, row)).toBe(true)
    expect(recipeHolds({ ...emptyDraft(), name: 'Mojo' }, { id: 'r', name: 'Mojo', notes: null, lines: [] })).toBe(true)
    for (const change of [{ name: 'Mojo verde' }, { notes: 'pH 3.5' }, { link: '' }, { keepsN: '15' }, { keepsKind: 'pantry' }, { vesselSize: '2' }, { vesselCount: '3' },
      { bottleCooked: false }, { madeText: '' }, { kind: 'hot_sauce' }, { typeId: 't1' }, { lines: [d.lines[0]] }, { lines: [d.lines[1], d.lines[0]] },
      { lines: [{ ...d.lines[0], qty: '3' }, d.lines[1]] }, { lines: [d.lines[0], { ...d.lines[1], atTheEnd: false }] }]) {
      expect(recipeHolds({ ...d, ...change }, row), JSON.stringify(change)).toBe(false)
    }
    // A line fact the sheet does not show: the recipe holds more than what is on screen.
    expect(recipeHolds(d, { ...row, lines: [{ ...row.lines[0], brand: 'Christopher Ranch' }, row.lines[1]] })).toBe(false)
    expect(recipeHolds(d, null)).toBe(false)
    expect(recipeHolds({ ...d, name: '' }, row)).toBe(false)                   // a draft Save would refuse holds nothing
  })

  it('a first-time create: one POST, no update call', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ recipe: { id: 'r-new', name: b.name, lines: [] } }) })
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'r-new', name: 'Mojo', lines: [] }))
    expect(posts(PATH)).toHaveLength(1)
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no update call, saved', async () => {
    lostThenReplayed()
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(FIRST))
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[0]).toMatch(UUID)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
    expect(draft()).toBeNull()
  })

  it('a lost answer, the name and the notes changed, Save: the same key, ONE PATCH to the replayed recipe with the change, and the changed recipe handed on', async () => {
    lostThenReplayed()
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde'); type('recipe-notes', 'pH 3.4')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])                                  // never a second create under a new key
    expect(posts(PATH).map(b => b.name)).toEqual(['Mojo', 'Mojo verde'])
    expect(otherWrites(PATH)).toEqual([['PATCH', ROW]])
    // The PATCH is the body an edit sends: every field the sheet shows, so a field emptied since is cleared too.
    const [patch] = sentTo('PATCH', ROW)
    expect(patch).toMatchObject({ name: 'Mojo verde', notes: 'pH 3.4', link_url: null, keeps: null, lines: [] })
    expect(patch).not.toHaveProperty('idempotency_key')
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 'r-first', name: 'Mojo verde', notes: 'pH 3.4' })
    expect(draft()).toBeNull()
  })

  it('I3 — the update fails: the sheet says the recipe IS saved and this change did not save (never "Couldn\'t save it"), the page is told, the change is still in the form and the draft, nothing is handed on as saved — and Save again finishes it', async () => {
    let fail = true
    lostThenReplayed((b) => { if (fail) throw apiError(503, { error: 'boom' }); return { recipe: { ...FIRST, ...b } } })
    const { onSaved, onExists } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    expect(onExists).not.toHaveBeenCalled()                                    // a lost answer: nothing is known yet
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(sentTo('PATCH', ROW)).toHaveLength(1))
    await waitFor(() => expect(errorText()).toBe('“Mojo” is already saved — the first Save went through. This change did not save: boom'))
    expect(errorText()).not.toMatch(BANNED)
    expect(onExists).toHaveBeenCalledTimes(1)                                  // the list behind re-reads: the recipe is there
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo verde')
    expect(draft()).toMatchObject({ name: 'Mojo verde', key: keys(PATH)[0] })
    fail = false
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(keys(PATH)).toHaveLength(3)
    expect(sentTo('PATCH', ROW).map(b => b.name)).toEqual(['Mojo verde', 'Mojo verde'])
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 'r-first', name: 'Mojo verde' })
  })

  it('I3 — a PATCH with no answer at all (the connection again): the same already-saved line, what was typed still here', async () => {
    lostThenReplayed(LOST)
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(sentTo('PATCH', ROW)).toHaveLength(1))
    await waitFor(() => expect(errorText()).toBe('“Mojo” is already saved — the first Save went through. This change may not have saved — try again. What you typed is still here.'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo verde')
  })

  // The first POST's answer is lost; the PATCH LANDS (the recipe holds it, its updated_at moves) and its first
  // answer is lost too. `state.row` is what is stored.
  const patchLandsAnswerLost = () => {
    const state = { row: FIRST }
    let patchesSeen = 0
    wire({
      [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: state.row, replayed: true }),
      [`PATCH ${ROW}`]: (b) => {
        state.row = { ...state.row, ...b, updated_at: new Date().toISOString() }   // it lands …
        if (++patchesSeen === 1) LOST()                                            // … and its answer does not come back
        return { recipe: state.row }
      },
    })
    return state
  }

  it('I3 / Q3 — the PATCH LANDED and only its answer was lost: Save again finds the recipe already holding what the sheet shows and is a save — NO second PATCH, the same key', async () => {
    const state = patchLandsAnswerLost()
    const sheet = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(sentTo('PATCH', ROW)).toHaveLength(1))
    await waitFor(() => expect(errorText()).toMatch(/This change may not have saved/))
    expect(state.row.updated_at).not.toBe(state.row.created_at)
    await save()
    await answered(sheet, 3)
    expect(errorText()).toBeNull()
    expect(sheet.onSaved).toHaveBeenCalledTimes(1)
    expect(sheet.onSaved.mock.calls[0][0]).toMatchObject({ id: 'r-first', name: 'Mojo verde' })
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(sentTo('PATCH', ROW).map(b => b.name)).toEqual(['Mojo verde'])
    expect(draft()).toBeNull()
  })

  it('I3 — … and a FURTHER change made before that Save: the recipe\'s updated_at has moved, but by this sheet\'s own PATCH — so the second PATCH still goes onto it', async () => {
    patchLandsAnswerLost()
    const sheet = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(errorText()).toMatch(/This change may not have saved/))
    type('recipe-name', 'Mojo verde, hot')
    await save()
    await answered(sheet, 3)
    expect(errorText()).toBeNull()
    expect(sheet.onSaved).toHaveBeenCalledTimes(1)
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(sentTo('PATCH', ROW).map(b => b.name)).toEqual(['Mojo verde', 'Mojo verde, hot'])
  })

  // QA I-2. A PATCH whose answer was lost may never have reached the server; the stamp that has moved since is
  // then somebody else's, and the recipe does not hold what this sheet sent.
  it('QA I-2 — the PATCH never reached the server and the recipe is renamed by someone else meanwhile: Save again writes NOTHING over their name — the sheet says it was saved earlier', async () => {
    const state = { row: FIRST }
    wire({
      [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: state.row, replayed: true }),
      [`PATCH ${ROW}`]: () => { state.row = { ...state.row, name: 'Mojo (Jen)', updated_at: new Date().toISOString() }; return LOST() },
    })
    const sheet = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(errorText()).toMatch(/This change may not have saved/))
    await save()
    await waitFor(() => expect(errorText()).toBe('“Mojo (Jen)” was already saved earlier — it is with your recipes. This Save did not change it. To change it, open the recipe.'))
    expect(posts(PATH)).toHaveLength(3)
    expect(sentTo('PATCH', ROW)).toHaveLength(1)                               // no second PATCH
    expect(state.row.name).toBe('Mojo (Jen)')
    expect(sheet.onSaved).not.toHaveBeenCalled()
    expect(new Set(keys(PATH)).size).toBe(1)
  })

  // REVIEW B1. The draft is in storage with its key and what went out under it. Opened again — minutes or
  // days later — what is typed over it may be another recipe altogether, and the PATCH replaces every line.
  // QA Q3: the refusal KEEPS the key. Save again is the same refusal, and no create ever goes out under a new key.
  it('B1 / Q3 — dismissed, opened again, a DIFFERENT recipe typed over the restored draft, Save: NOTHING is written onto the recipe the first Save made (however new it is); the sheet says so (in view), tells the page, keeps what was typed AND the key — Save again is refused again: no second recipe, no create under a new key', async () => {
    const on = watchScrolls()
    lostThenReplayed()
    mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    const stored = draft()
    expect(stored.sent).toEqual([sendPrint(posts(PATH)[0])])
    expect(isRecipeDraft(stored)).toBe(true)
    cleanup()
    const second = mount()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo')
    type('recipe-name', 'Chimichurri'); type('recipe-notes', 'parsley, not cilantro')
    await save()
    await answered(second, 2)
    expect(otherWrites(PATH)).toEqual([])                                      // "Mojo" is as the first Save made it
    expect(errorText()).toBe(STALE)
    expect(STALE).not.toMatch(BANNED)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(second.onSaved).not.toHaveBeenCalled()
    expect(second.onExists).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('recipe-name').value).toBe('Chimichurri')
    expect(screen.getByTestId('recipe-save').disabled).toBe(false)
    expect(screen.getByTestId('recipe-sheet-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(broughtIntoView(on, 'recipe-sheet-error')).toBe(true))
    // The key that names "Mojo" is KEPT by the sheet that is open: the Saves below go out under it. The STORED
    // draft ended with the refusal and is not written back (pre-promote I-1; PutUpSpentKey.test.jsx).
    await waitFor(() => expect(draft()).toBeNull())
    for (const nth of [3, 4]) {
      on.length = 0
      await save()
      await waitFor(() => expect(posts(PATH)).toHaveLength(nth))
      await waitFor(() => expect(errorText()).toBe(STALE))                     // refused again
      await waitFor(() => expect(broughtIntoView(on, 'recipe-sheet-error')).toBe(true))
    }
    expect(new Set(keys(PATH)).size).toBe(1)                                   // ZERO creates under a new key
    expect(otherWrites(PATH)).toEqual([])
    expect(second.onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('recipe-name').value).toBe('Chimichurri')
    expect(draft()).toBeNull()
  })

  // QA Q3 (D4). The first body never reached the server; the changed one landed with its answer lost; the sheet
  // was dismissed and opened again. The recipe holds EXACTLY what the sheet shows: there is nothing to refuse.
  it('Q3 — a restored draft whose recipe already holds exactly what the sheet shows: a SAVE, as any other — no PATCH, no refusal, the same key, the draft cleared', async () => {
    let row = null
    wire({
      [`POST ${PATH}`]: (b, n) => {
        if (n === 1) LOST()                                                    // never reached the server
        if (n === 2) { row = { ...FIRST, name: b.name, notes: b.notes }; LOST() }   // landed; its answer did not come back
        return { recipe: row, replayed: true }
      },
      [`PATCH ${ROW}`]: (b) => ({ recipe: { ...FIRST, ...b } }),
    })
    mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde'); type('recipe-notes', 'pH 3.4')
    await save()
    await waitFor(() => expect(posts(PATH)).toHaveLength(2))
    await waitFor(() => expect(draft()?.sent).toHaveLength(2))
    cleanup()
    const second = mount()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo verde')
    await save()
    await answered(second, 3)
    expect(errorText()).toBeNull()
    expect(second.onSaved).toHaveBeenCalledWith(row)
    expect(second.onExists).not.toHaveBeenCalled()
    expect(otherWrites(PATH)).toEqual([])
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(draft()).toBeNull()
  })

  // BUG-PUTUPSAVEFAILHIDDEN-001, measured in Chrome at 426x836: the failure line's last 3 px were under the pinned Save.
  it('a Save that fails the ordinary way is brought into view, and so is the same failure again', async () => {
    const on = watchScrolls()
    wire({ [`POST ${PATH}`]: LOST })
    mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    await waitFor(() => expect(broughtIntoView(on, 'recipe-sheet-error')).toBe(true))
    on.length = 0
    await save()
    await waitFor(() => expect(posts(PATH)).toHaveLength(2))
    await failed()
    await waitFor(() => expect(broughtIntoView(on, 'recipe-sheet-error')).toBe(true))
  })

  it('Q2 — a change that did not save is brought into view too', async () => {
    const on = watchScrolls()
    lostThenReplayed(() => { throw apiError(503, { error: 'boom' }) })
    mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    await waitFor(() => expect(broughtIntoView(on, 'recipe-sheet-error')).toBe(true))   // BUG-PUTUPSAVEFAILHIDDEN-001
    on.length = 0
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(errorText()).toBe('“Mojo” is already saved — the first Save went through. This change did not save: boom'))
    await waitFor(() => expect(broughtIntoView(on, 'recipe-sheet-error')).toBe(true))
  })

  it('B1 — the same sheet, but the recipe was changed since the first Save made it (updated_at has moved): NOTHING is written over that change', async () => {
    lostThenReplayed(undefined, { ...FIRST, ...stamps(60 * 1000, 20 * 1000) })
    const sheet = mount()
    const { onSaved, onExists } = sheet
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await answered(sheet, 2)
    expect(otherWrites(PATH)).toEqual([])
    expect(errorText()).toBe(STALE)
    expect(onSaved).not.toHaveBeenCalled()
    expect(onExists).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo verde')
  })

  it('B1 — the same sheet, but the recipe was made longer ago than the bound (the sheet sat open): NOTHING is written', async () => {
    lostThenReplayed(undefined, { ...FIRST, ...stamps(LONG_AGO) })
    const sheet = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await answered(sheet, 2)
    expect(otherWrites(PATH)).toEqual([])
    expect(errorText()).toBe(STALE)
    expect(sheet.onSaved).not.toHaveBeenCalled()
  })

  it('a restored draft saved UNTOUCHED is still one body: replayed, no update call, saved', async () => {
    lostThenReplayed(undefined, { ...FIRST, ...stamps(3 * 60 * 60 * 1000, 60 * 1000) })
    mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    cleanup()
    const second = mount()
    await save()
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1))
    expect(otherWrites(PATH)).toEqual([])
    expect(draft()).toBeNull()
  })

  it('a draft that has never been sent has no `sent`; a stored `sent` that is not a list is not a draft', async () => {
    mount()
    type('recipe-name', 'Mojo')
    await waitFor(() => expect(draft()?.key).toMatch(UUID))
    expect(draft()).not.toHaveProperty('sent')
    expect(isRecipeDraft({ ...draft(), sent: 'x' })).toBe(false)
    expect(isRecipeDraft({ ...draft(), sent: ['a/b'] })).toBe(true)
  })

  it('replayed on the only body this key ever went out with (a key sent by an older bundle, or by another tab): no update call', async () => {
    wire({ [`POST ${PATH}`]: () => ({ recipe: FIRST, replayed: true }), [`PATCH ${ROW}`]: (b) => ({ recipe: { ...FIRST, ...b } }) })
    const { onSaved } = mount()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(FIRST))
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a changed body that is NOT answered replayed (the first POST never landed): created as sent, no update call', async () => {
    wire({ [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: { id: 'r-new', name: b.name, lines: [] } }) })
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'r-new', name: 'Mojo verde', lines: [] }))
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
  })

  it('an edit of an existing recipe is its PATCH and nothing else, as it was', async () => {
    wire({ 'PATCH /api/recipes/r7': (b) => ({ recipe: { id: 'r7', ...b } }) })
    const onSaved = vi.fn()
    render(<RecipeSheet open recipe={{ id: 'r7', name: 'Mojo', lines: [] }} types={[]} fetch={fetchSpy} onClose={() => {}} onSaved={onSaved} />)
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(fetchSpy.mock.calls.filter(([, o]) => o?.method).map(([p, o]) => [o.method, p])).toEqual([['PATCH', '/api/recipes/r7']])
  })
})

// REVIEW I3 — "the page behind must learn the row exists": the recipes list hands the sheet its own re-read.
describe('the recipes list behind the sheet is told the recipe is there', () => {
  it('a change that did not save: the list is read again with the sheet still open, and shows the recipe the first Save made', async () => {
    const FIRST = { id: 'r-first', name: 'Mojo', notes: null, lines: [], ...stamps() }
    let landed = false
    wire({
      'GET /api/recipes': () => ({ recipes: landed ? [{ id: 'r-first', name: 'Mojo' }] : [] }),
      'GET /api/recipes/types': () => ({ types: [] }),
      'POST /api/recipes': (b, n) => { landed = true; return n === 1 ? LOST() : { recipe: FIRST, replayed: true } },
      'PATCH /api/recipes/r-first': () => { throw apiError(503, { error: 'boom' }) },
    })
    render(<MemoryRouter><RecipesView /></MemoryRouter>)
    await screen.findByTestId('recipes-empty')
    tap('recipes-new')
    type('recipe-name', 'Mojo')
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(screen.getByTestId('recipe-sheet-error').textContent).toMatch(/Couldn't save it/))
    expect(screen.queryAllByTestId('recipes-row')).toHaveLength(0)             // a lost answer: nothing is known yet
    type('recipe-name', 'Mojo verde')
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(screen.getByTestId('recipe-sheet-error').textContent).toBe('“Mojo” is already saved — the first Save went through. This change did not save: boom'))
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(1))
    expect(screen.getByTestId('recipes-row').textContent).toMatch(/^Mojo/)
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo verde')         // the sheet is still open, with what was typed
  })
})

describe('Save as recipe — POST /api/recipes/from-batch/:id, then PATCH /api/recipes/:id', () => {
  const BATCH = { id: 'kb1', label: 'Settlers of Cayenne', recipe_id: null }
  const PATH = '/api/recipes/from-batch/kb1'
  const ROW = '/api/recipes/r9'
  const FIRST = { id: 'r9', name: 'Settlers of Cayenne', ...stamps() }
  const onChanged = vi.fn()
  beforeEach(() => { onChanged.mockReset() })
  const mount = (batch = BATCH) => render(<BatchRecipeRow batch={batch} inputs={[]} onChanged={onChanged} />)
  const save = () => act(async () => { tap('batch-save-as-recipe-save') })
  const errorText = () => screen.queryByTestId('batch-save-as-recipe-error')?.textContent ?? null
  const lostThenReplayed = (patch = (b) => ({ recipe: { ...FIRST, ...b } }), first = FIRST) => wire({
    [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: first, replayed: true }),
    [`PATCH ${ROW}`]: patch,
  })
  const failed = () => waitFor(() => expect(screen.getByTestId('batch-save-as-recipe-error').textContent).toMatch(/Couldn't save it as a recipe/))
  const saved = (name) => waitFor(() => expect(screen.getByTestId('batch-save-as-recipe-saved').textContent).toBe(`Saved as a recipe: ${name}`))

  it('a first-time Save: one POST, no update call', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ recipe: { id: 'r9', name: b.name }, batch_linked: true }) })
    mount()
    tap('batch-save-as-recipe')
    await save(); await saved('Settlers of Cayenne')
    expect(posts(PATH)).toHaveLength(1)
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no update call, saved', async () => {
    lostThenReplayed()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    await save(); await saved('Settlers of Cayenne')
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, the name changed, Save: the same key, ONE PATCH of the name to the replayed recipe, and the new name is the one shown', async () => {
    lostThenReplayed()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save(); await saved('Settlers, the hot one')
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([['PATCH', ROW]])
    expect(sentTo('PATCH', ROW)).toEqual([{ name: 'Settlers, the hot one' }])
  })

  it('I3 — the update fails: the row says the recipe IS saved under its first name and the new name did not save (never "Couldn\'t save it"), the page is told, the field is still open with the new name, nothing reads as saved — and Save again finishes it', async () => {
    let fail = true
    lostThenReplayed((b) => { if (fail) throw apiError(500, { error: 'boom' }); return { recipe: { ...FIRST, ...b } } })
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    expect(onChanged).not.toHaveBeenCalled()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save()
    await waitFor(() => expect(sentTo('PATCH', ROW)).toHaveLength(1))
    await waitFor(() => expect(errorText()).toBe('Already saved as a recipe: “Settlers of Cayenne” — the first Save went through. The new name did not save — try again.'))
    expect(errorText()).not.toMatch(BANNED)
    expect(onChanged).toHaveBeenCalledTimes(1)                                 // batch detail re-reads: it follows the recipe now
    expect(screen.queryByTestId('batch-save-as-recipe-saved')).toBeNull()
    expect(screen.getByTestId('batch-save-as-recipe-name').value).toBe('Settlers, the hot one')
    fail = false
    await save(); await saved('Settlers, the hot one')
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(sentTo('PATCH', ROW)).toHaveLength(2)
  })

  // QA Q1 — the own-rename memory (`held.patched`), and QA Q3 — a recipe that already has the name.
  const renameLandsAnswerLost = () => {
    let row = FIRST
    let seen = 0
    wire({
      [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: row, replayed: true }),
      [`PATCH ${ROW}`]: (b) => { row = { ...row, ...b, updated_at: new Date().toISOString() }; if (++seen === 1) LOST(); return { recipe: row } },
    })
  }
  const MAYBE = 'Already saved as a recipe: “Settlers of Cayenne” — the first Save went through. The new name may not have saved — try again.'

  it('BUG-PUTUPSAVEFAILHIDDEN-001 — a Save that fails the ordinary way is brought into view, and so is the same failure again', async () => {
    const on = watchScrolls()
    wire({ [`POST ${PATH}`]: LOST })
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    await waitFor(() => expect(broughtIntoView(on, 'batch-save-as-recipe-error')).toBe(true))
    on.length = 0
    await save()
    await waitFor(() => expect(posts(PATH)).toHaveLength(2))
    await failed()
    await waitFor(() => expect(broughtIntoView(on, 'batch-save-as-recipe-error')).toBe(true))
  })

  it('Q1 / Q3 — the rename LANDED and only its answer was lost: the row says it MAY not have saved (in view); Save again finds the recipe already under that name and is a save — no second PATCH, the same key', async () => {
    const on = watchScrolls()
    renameLandsAnswerLost()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save()
    await waitFor(() => expect(errorText()).toBe(MAYBE))
    await waitFor(() => expect(broughtIntoView(on, 'batch-save-as-recipe-error')).toBe(true))
    expect(screen.getByTestId('batch-save-as-recipe-error').getAttribute('role')).toBe('alert')
    await save(); await saved('Settlers, the hot one')
    expect(errorText()).toBeNull()
    expect(sentTo('PATCH', ROW)).toEqual([{ name: 'Settlers, the hot one' }])
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(keys(PATH)).toHaveLength(3)
  })

  it('QA I-2 — the rename never reached the server and the recipe is renamed by someone else meanwhile: Save again writes NOTHING over their name', async () => {
    const state = { row: FIRST }
    wire({
      [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: state.row, replayed: true }),
      [`PATCH ${ROW}`]: () => { state.row = { ...state.row, name: 'Jen’s cayenne', updated_at: new Date().toISOString() }; return LOST() },
    })
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save()
    await waitFor(() => expect(errorText()).toBe(MAYBE))
    await save()
    await waitFor(() => expect(errorText()).toBe('Already saved as a recipe: “Jen’s cayenne” — an earlier Save went through. This Save did not rename it: to rename it, open the recipe.'))
    expect(posts(PATH)).toHaveLength(3)
    expect(sentTo('PATCH', ROW)).toHaveLength(1)                               // no second PATCH
    expect(state.row.name).toBe('Jen’s cayenne')
    expect(screen.queryByTestId('batch-save-as-recipe-saved')).toBeNull()
    expect(new Set(keys(PATH)).size).toBe(1)
  })

  it('Q1 — … and renamed AGAIN before that Save: the recipe\'s updated_at has moved, but by this row\'s own PATCH — so the second name still goes onto it', async () => {
    renameLandsAnswerLost()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save()
    await waitFor(() => expect(errorText()).toBe(MAYBE))
    type('batch-save-as-recipe-name', 'Settlers III')
    await save(); await saved('Settlers III')
    expect(sentTo('PATCH', ROW)).toEqual([{ name: 'Settlers, the hot one' }, { name: 'Settlers III' }])
    expect(new Set(keys(PATH)).size).toBe(1)
  })

  it('Q3 — a recipe made a while ago that is ALREADY under the name typed: a save, nothing written, nothing refused', async () => {
    lostThenReplayed(undefined, { ...FIRST, name: 'Settlers, the hot one', ...stamps(LONG_AGO) })
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save(); await saved('Settlers, the hot one')
    expect(errorText()).toBeNull()
    expect(otherWrites(PATH)).toEqual([])
    expect(new Set(keys(PATH)).size).toBe(1)
  })

  it('a lost answer, Cancel, opened again and renamed: still the same key, and the name goes onto the recipe', async () => {
    lostThenReplayed()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    fireEvent.click(screen.getByText('Cancel'))
    tap('batch-save-as-recipe')
    type('batch-save-as-recipe-name', 'Settlers II')
    await save(); await saved('Settlers II')
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(sentTo('PATCH', ROW)).toEqual([{ name: 'Settlers II' }])
  })

  it('B1 — the recipe was made longer ago than the bound, or changed since: the new name is NOT put on it, the row says so and tells the page — and the key is KEPT (a new one would make a second recipe of the same batch)', async () => {
    for (const row of [{ ...FIRST, ...stamps(LONG_AGO) }, { ...FIRST, ...stamps(60 * 1000, 20 * 1000) }]) {
      cleanup(); fetchSpy.mockReset(); onChanged.mockReset()
      const on = watchScrolls()
      lostThenReplayed(undefined, row)
      mount()
      tap('batch-save-as-recipe')
      await save(); await failed()
      type('batch-save-as-recipe-name', 'Settlers, the hot one')
      await save()
      await waitFor(() => expect(posts(PATH)).toHaveLength(2))
      await waitFor(() => expect(errorText() != null || screen.queryByTestId('batch-save-as-recipe-saved') != null).toBe(true))
      expect(otherWrites(PATH)).toEqual([])
      expect(errorText()).toBe('Already saved as a recipe: “Settlers of Cayenne” — an earlier Save went through. This Save did not rename it: to rename it, open the recipe.')
      expect(errorText()).not.toMatch(BANNED)
      expect(onChanged).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('batch-save-as-recipe-saved')).toBeNull()
      expect(screen.getByTestId('batch-save-as-recipe-name').value).toBe('Settlers, the hot one')
      await waitFor(() => expect(broughtIntoView(on, 'batch-save-as-recipe-error')).toBe(true))
      await save()
      await waitFor(() => expect(posts(PATH)).toHaveLength(3))
      await waitFor(() => expect(errorText()).toMatch(/This Save did not rename it/))   // refused again
      expect(new Set(keys(PATH)).size).toBe(1)
      expect(otherWrites(PATH)).toEqual([])
    }
  })

  it('the key belongs to ONE batch: the row handed another batch sends a new key, and never writes to the first batch\'s recipe', async () => {
    wire({
      [`POST ${PATH}`]: LOST,
      'POST /api/recipes/from-batch/kb2': (b) => ({ recipe: { id: 'r10', name: b.name } }),
      [`PATCH ${ROW}`]: (b) => ({ recipe: { ...FIRST, ...b } }),
    })
    const view = mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    view.rerender(<BatchRecipeRow batch={{ ...BATCH, id: 'kb2' }} inputs={[]} onChanged={() => {}} />)
    type('batch-save-as-recipe-name', 'Another one')
    await save(); await saved('Another one')
    expect(keys('/api/recipes/from-batch/kb2')[0]).toMatch(UUID)
    expect(keys('/api/recipes/from-batch/kb2')[0]).not.toBe(keys(PATH)[0])
    expect(sentTo('PATCH', ROW)).toEqual([])
  })

  it('a save that lands drops the key: saving again goes out under a new one', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ recipe: { id: 'r9', name: b.name }, batch_linked: true }) })
    mount()
    tap('batch-save-as-recipe')
    await save(); await saved('Settlers of Cayenne')
    tap('batch-save-as-recipe')
    await save()
    await waitFor(() => expect(posts(PATH)).toHaveLength(2))
    expect(keys(PATH)[1]).not.toBe(keys(PATH)[0])
  })
})

describe('How it was made — POST /api/kitchen-batches/from-jars, then PUT /api/kitchen-batches/:id', () => {
  const PATH = '/api/kitchen-batches/from-jars'
  const ROW = '/api/kitchen-batches/kb-first'
  const JAR = {
    id: 'j-1', label: 'Megatron plain', batch_id: null, harvest_log_id: null, storage_location_id: 'loc-fridge',
    preserved_at: '2026-09-08', preserved_at_precision: 'day', package_count: 2, remaining_count: 2, stock_mode: 'counted', notes: '',
  }
  // What the route answers a replay with: the batch detail (GET /:id's shape) and the flag.
  const FIRST = { id: 'kb-first', label: 'Megatron plain', kind: null, kind_other: null, inputs: [], stages: [{ id: 's1', stage_kind: 'started' }], ...stamps() }
  const mount = (props = {}) => {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), ...props }
    render(<DismissRegistryProvider><HowItWasMadeSheet jar={JAR} open {...handlers} /></DismissRegistryProvider>)
    return handlers
  }
  const lostThenReplayed = (put = (b) => ({ id: 'kb-first', label: b.label, kind: b.kind, kind_other: b.kind_other, updated_at: 'later' }), first = FIRST) => wire({
    'GET /api/preservation/whats-put-up': () => ({ groups: [{ label: 'Fridge', records: [JAR] }] }),
    [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { ...first, replayed: true }),
    [`PUT ${ROW}`]: put,
  })
  const save = () => act(async () => { tap('how-submit') })
  const failed = () => waitFor(() => expect(screen.getByTestId('how-error').textContent.length).toBeGreaterThan(0))
  const loaded = () => waitFor(() => expect(screen.getByTestId('how-made')).toBeTruthy())

  it('a first-time Save: one POST, no update call, the sheet closes', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ id: 'kb-new', label: b.label }) })
    const { onClose, onSaved } = mount()
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'kb-new', label: 'Megatron plain' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no update call, saved and closed', async () => {
    lostThenReplayed()
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...FIRST, replayed: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, the name changed, Save: the same key, ONE PUT of the name and kind to the replayed batch, and the renamed batch handed on', async () => {
    lostThenReplayed()
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([['PUT', ROW]])
    expect(sentTo('PUT', ROW)).toEqual([{ label: 'Megatron plain, 2026', kind: null, kind_other: null }])
    // The detail the replay answered with, the batch's own columns as the PUT answered them.
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 'kb-first', label: 'Megatron plain, 2026', stages: FIRST.stages, updated_at: 'later' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('I3 — the update fails: the sheet says the batch IS saved and the change did not save, the page is told with the sheet still open (the batch is there, under its first name) — and Save again finishes it', async () => {
    let fail = true
    lostThenReplayed((b) => { if (fail) throw apiError(500, { error: 'boom' }); return { id: 'kb-first', label: b.label } })
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    expect(onSaved).not.toHaveBeenCalled()                                     // a lost answer: nothing is known yet
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(sentTo('PUT', ROW)).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe('This batch is already saved — the first Save went through. The change to its name or kind did not save. Try again, or close this and make it on the batch.'))
    expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_CHANGE_UNSAVED)
    expect(REPLAY_CHANGE_UNSAVED).not.toMatch(BANNED)
    expect(REPLAY_CHANGE_MAYBE).toBe('This batch is already saved — the first Save went through. The change to its name or kind may not have saved. Try again, or close this and check it on the batch.')
    expect(REPLAY_CHANGE_MAYBE).not.toMatch(BANNED)
    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved.mock.calls.map(c => c[0])).toEqual([{ ...FIRST, replayed: true }])   // the lists behind re-read
    expect(screen.getByTestId('how-label').value).toBe('Megatron plain, 2026')
    fail = false
    await save()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(onSaved).toHaveBeenCalledTimes(2)
    expect(onSaved.mock.calls[1][0]).toMatchObject({ id: 'kb-first', label: 'Megatron plain, 2026' })
  })

  // QA Q1 — the own-PUT memory (`putRef`), and QA Q3 — a batch that already has the name and kind.
  const putLandsAnswerLost = () => {
    let row = FIRST
    let seen = 0
    wire({
      'GET /api/preservation/whats-put-up': () => ({ groups: [{ label: 'Fridge', records: [JAR] }] }),
      [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { ...row, replayed: true }),
      [`PUT ${ROW}`]: (b) => {
        row = { ...row, label: b.label, kind: b.kind, kind_other: b.kind_other, updated_at: new Date().toISOString() }
        if (++seen === 1) LOST()
        return { id: 'kb-first', label: row.label, kind: row.kind, kind_other: row.kind_other, updated_at: row.updated_at }
      },
    })
  }

  it('BUG-PUTUPSAVEFAILHIDDEN-001 — a Save that fails the ordinary way is brought into view, and so is the same failure again', async () => {
    const on = watchScrolls()
    wire({ 'GET /api/preservation/whats-put-up': () => ({ groups: [{ label: 'Fridge', records: [JAR] }] }), [`POST ${PATH}`]: LOST })
    mount()
    await loaded()
    await save(); await failed()
    await waitFor(() => expect(broughtIntoView(on, 'how-error')).toBe(true))
    on.length = 0
    await save()
    await waitFor(() => expect(posts(PATH)).toHaveLength(2))
    await failed()
    await waitFor(() => expect(broughtIntoView(on, 'how-error')).toBe(true))
  })

  it('Q1 / Q3 — the PUT LANDED and only its answer was lost: the sheet says the change MAY not have saved (in view); Save again finds the batch already under that name and is a save — no second PUT, the same key, closed', async () => {
    const on = watchScrolls()
    putLandsAnswerLost()
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    await waitFor(() => expect(broughtIntoView(on, 'how-error')).toBe(true))   // BUG-PUTUPSAVEFAILHIDDEN-001
    on.length = 0
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_CHANGE_MAYBE))
    await waitFor(() => expect(broughtIntoView(on, 'how-error')).toBe(true))
    expect(screen.getByTestId('how-error').getAttribute('role')).toBe('alert')
    expect(onClose).not.toHaveBeenCalled()
    await save()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(sentTo('PUT', ROW)).toHaveLength(1)
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(keys(PATH)).toHaveLength(3)
    expect(onSaved.mock.calls.at(-1)[0]).toMatchObject({ id: 'kb-first', label: 'Megatron plain, 2026' })
  })

  it('QA I-2 — the PUT never reached the server and the batch is renamed by someone else meanwhile: Save again writes NOTHING over their name — refused', async () => {
    const state = { row: FIRST }
    wire({
      'GET /api/preservation/whats-put-up': () => ({ groups: [{ label: 'Fridge', records: [JAR] }] }),
      [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { ...state.row, replayed: true }),
      [`PUT ${ROW}`]: () => { state.row = { ...state.row, label: 'Megatron (Jen)', updated_at: new Date().toISOString() }; return LOST() },
    })
    const { onClose } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_CHANGE_MAYBE))
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_NOT_ON_IT))
    expect(posts(PATH)).toHaveLength(3)
    expect(sentTo('PUT', ROW)).toHaveLength(1)                                 // no second PUT
    expect(state.row.label).toBe('Megatron (Jen)')
    expect(onClose).not.toHaveBeenCalled()
    expect(new Set(keys(PATH)).size).toBe(1)
  })

  it('Q1 — … and renamed AGAIN before that Save: the batch\'s updated_at has moved, but by this sheet\'s own PUT — so the second name still goes onto it', async () => {
    putLandsAnswerLost()
    const { onClose } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_CHANGE_MAYBE))
    type('how-label', 'Megatron plain, the 2026 jars')
    await save()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(sentTo('PUT', ROW).map(b => b.label)).toEqual(['Megatron plain, 2026', 'Megatron plain, the 2026 jars'])
    expect(new Set(keys(PATH)).size).toBe(1)
  })

  it('Q3 — a batch made a while ago that ALREADY has the name on screen: a save, nothing written, closed', async () => {
    lostThenReplayed(undefined, { ...FIRST, label: 'Megatron plain, 2026', ...stamps(LONG_AGO) })
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('how-error')).toBeNull()
    expect(otherWrites(PATH)).toEqual([])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('B1 / Q3 — the batch was made longer ago than the bound, or changed since: the new name is NOT put on it — the sheet stays open, says (in view) the batch is already saved and this Save changed nothing, and the page is told; Save again is refused again under the same key', async () => {
    for (const row of [{ ...FIRST, ...stamps(LONG_AGO) }, { ...FIRST, ...stamps(60 * 1000, 20 * 1000) }]) {
      cleanup(); fetchSpy.mockReset()
      const on = watchScrolls()
      lostThenReplayed(undefined, row)
      const { onClose, onSaved } = mount()
      await loaded()
      await save(); await failed()
      type('how-label', 'Megatron plain, 2026')
      await save()
      await waitFor(() => expect(posts(PATH)).toHaveLength(2))
      await waitFor(() => expect(onSaved).toHaveBeenCalled())                  // told either way: saved, or already there
      expect(otherWrites(PATH)).toEqual([])
      expect(screen.queryByTestId('how-error')?.textContent ?? null).toBe(REPLAY_NOT_ON_IT)
      expect(onClose).not.toHaveBeenCalled()
      expect(onSaved).toHaveBeenCalledWith({ ...row, replayed: true })
      expect(screen.getByTestId('how-label').value).toBe('Megatron plain, 2026')
      await waitFor(() => expect(broughtIntoView(on, 'how-error')).toBe(true))
      on.length = 0
      await save()
      await waitFor(() => expect(posts(PATH)).toHaveLength(3))
      await waitFor(() => expect(broughtIntoView(on, 'how-error')).toBe(true))
      expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_NOT_ON_IT)
      expect(new Set(keys(PATH)).size).toBe(1)
      expect(otherWrites(PATH)).toEqual([])
      expect(onClose).not.toHaveBeenCalled()
    }
  })

  // REVIEW I2. The start is the earliest of the jars chosen, read off the jar list — which may not have
  // loaded when Save is first tapped. The date moving under an untouched sheet is not a change.
  it('I2 — Save tapped before the jar list has loaded (answer lost), the list then moves the start, Save untouched: the body\'s start has changed, and it is still saved and closed — no "before your last change", no update call', async () => {
    let listed
    const list = new Promise((resolve) => { listed = resolve })
    wire({
      'GET /api/preservation/whats-put-up': () => list,
      [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { ...FIRST, replayed: true }),
      [`PUT ${ROW}`]: (b) => ({ id: 'kb-first', label: b.label }),
    })
    const { onClose, onSaved } = mount()
    await save(); await failed()
    // The list answers: the jar's own record says it was put up a week before what the door handed in.
    await act(async () => { listed({ groups: [{ label: 'Fridge', records: [{ ...JAR, preserved_at: '2026-09-01' }] }] }); await list })
    await loaded()
    await save()
    await waitFor(() => expect(posts(PATH)).toHaveLength(2))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posts(PATH).map(b => b.started.date)).toEqual(['2026-09-08', '2026-09-01'])   // the read moved the start
    expect(screen.queryByTestId('how-error')?.textContent ?? null).toBeNull()            // nothing was changed, and nothing says it was
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
    expect(onSaved).toHaveBeenCalledWith({ ...FIRST, replayed: true })
  })

  it('a start he CHANGED is a change no route carries: nothing is written, and the sheet says so', async () => {
    lostThenReplayed()
    const { onClose } = mount()
    await loaded()
    await save(); await failed()
    tap('how-start-change'); tap('how-when-yesterday')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_NOT_ON_IT))
    expect(otherWrites(PATH)).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a lost answer, How many typed, Save: no route carries that, so NOTHING is written — the sheet stays open and says the batch is already saved and this Save changed nothing, and the page is told', async () => {
    lostThenReplayed()
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    type('how-made', '6')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_NOT_ON_IT))
    expect(posts(PATH).map(b => b.made_count ?? null)).toEqual([null, 6])
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith({ ...FIRST, replayed: true })            // the lists behind re-read: the batch is there
    expect(screen.getByTestId('how-made').value).toBe('6')
    expect(screen.getByTestId('how-submit').disabled).toBe(false)
    expect(REPLAY_NOT_ON_IT).not.toMatch(BANNED)
    // Which Save made the batch is not known to the sheet, so the sentence does not say the change is missing.
    expect(REPLAY_NOT_ON_IT).toBe('This batch is already saved — an earlier Save went through. This Save changed nothing on it. If your last change is not there, close this and open the batch to make it there.')
  })

  it('a name AND How many changed: still nothing written (a part that cannot be carried is not half-applied)', async () => {
    lostThenReplayed()
    const { onClose } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026'); type('how-made', '6')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_NOT_ON_IT))
    expect(otherWrites(PATH)).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })
})
