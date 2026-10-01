// Put-Up (V4 §5.6 / §6.5; review-2 B70) — the persisted-client-state registry is the code's, not a
// wish list: every URL param the Put-Up page reads and every storage key it writes is listed in
// src/lib/putUpClientState.js, and the constants the code uses ARE the registered names.
// MUTATION: rename WALK_PARAM, a sheet name, the bridge prefix or FIND_PARAM, or read a new
// searchParams key on the page without registering it -> red.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PUT_UP_URL_PARAMS, PUT_UP_STORAGE_KEYS, PUT_UP_DRAFT_SHEETS, FIND_PARAM } from '../lib/putUpClientState.js'
import { WALK_PARAM } from '../lib/putUpSession.js'
import { SHEET_DRAFT_PREFIX } from '../components/kitchen/sheetDraft.js'
import { BRIDGE_PREFIX } from '../components/pantry/pantryBridge.js'
import { DOOR_SHEET } from '../components/pantry/putSomethingUp.js'
import { PLACE_PARAM } from '../components/pantry/WalkPlace.jsx'
import { USE_SOON_FILTER } from '../components/pantry/pantryRows.js'
import { PUT_IT_UP_SHEET } from '../components/putup/putItUp.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p) => readFileSync(resolve(here, '..', p), 'utf8')

describe('the Put-Up persisted-client-state registry', () => {
  it('names the walk\'s shipped key, the use-soon filter, the walk place and the page search', () => {
    expect(WALK_PARAM).toBe('putup')
    expect(PUT_UP_URL_PARAMS.session).toMatch(`'${WALK_PARAM}'`)
    expect(PUT_UP_URL_PARAMS.filter).toMatch(`'${USE_SOON_FILTER}'`)
    expect(Object.keys(PUT_UP_URL_PARAMS)).toContain(PLACE_PARAM)
    expect(Object.keys(PUT_UP_URL_PARAMS)).toContain(FIND_PARAM)
  })

  it('every searchParams key the page and the walk read is registered', () => {
    const read = new Set()
    const consts = { WALK_PARAM: 'session', PLACE_PARAM, FIND_PARAM, USE_SOON_FILTER: 'filter' }
    for (const file of ['pages/PutUp.jsx', 'components/pantry/WalkPlace.jsx']) {
      const text = src(file)
      for (const m of text.matchAll(/searchParams\.(?:get|has)\(\s*'([a-z_]+)'\s*\)/g)) read.add(m[1])
      for (const m of text.matchAll(/searchParams\.(?:get|has)\(\s*([A-Z_]+)\s*\)/g)) read.add(consts[m[1]] ?? m[1])
    }
    expect(read.size).toBeGreaterThan(3)     // non-vacuous: the scan found the page's reads
    for (const k of read) expect(Object.keys(PUT_UP_URL_PARAMS), `unregistered URL param: ${k}`).toContain(k)
  })

  it('the storage keys are the code\'s own constants', () => {
    expect(Object.keys(PUT_UP_STORAGE_KEYS)).toContain(SHEET_DRAFT_PREFIX)
    expect(Object.keys(PUT_UP_STORAGE_KEYS)).toContain(BRIDGE_PREFIX)
    expect(Object.keys(PUT_UP_STORAGE_KEYS)).toContain('garden:putup-walk:v1')
    expect(src('lib/putUpSession.js')).toContain("const WALK_KEY = 'garden:putup-walk:v1'")
    expect(src('pages/PutUp.jsx')).toContain("const DRAFT_KEY = 'put-up'")
    expect(Object.keys(PUT_UP_STORAGE_KEYS)).toContain('put-up')
  })

  it('every draft sheet name is registered', () => {
    for (const sheet of [DOOR_SHEET, PUT_IT_UP_SHEET, 'start', 'checkin', 'line']) {
      expect(Object.keys(PUT_UP_DRAFT_SHEETS), `unregistered draft sheet: ${sheet}`).toContain(sheet)
    }
  })
})
