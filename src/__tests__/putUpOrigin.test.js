// Put-Up UX pass R1 (prep) — src/components/putup/origin.js, the pure half of "where this mode was opened
// from": the From a router state carries, the state a push into a mode rides on, the words after the Back
// arrow, and the one-mode-key URL. One test per sentence of the contract; each title says what it holds.
// MUTATION (run for this file): make withFrom return `{ from }` only -> "keeps every other key" reds.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFrom, withFrom, backLabel, modeSearch } from '../components/putup/origin.js'
import { CONTINUES_ENTRY_KEY } from '../lib/pageEntry.js'
import { PUT_UP_URL_PARAMS, FIND_PARAM } from '../lib/putUpClientState.js'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(resolve(here, '../components/putup/origin.js'), 'utf8')

const freezeDeep = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freezeDeep(v)
  return Object.freeze(o)
}
class Stamped { constructor() { this.label = 'Pantry' } }

describe('origin.js is pure', () => {
  it('imports no React and no router, and names no window', () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Green controls: the comment strip left the code standing, and the import scan found the imports.
    expect(code).toContain('export function withFrom')
    const imports = [...code.matchAll(/\bfrom\s+'([^']+)'/g)].map(m => m[1])
    expect(imports).toContain('../../lib/pageEntry.js')
    // No package at all, only this repo's own modules — and none of them React or the router.
    for (const path of imports) {
      expect(path.startsWith('.'), `a package import: ${path}`).toBe(true)
      expect(path).not.toMatch(/react|router/i)
    }
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\b(window|document|globalThis)\b/)
  })
})

describe('readFrom — the origin on a router state, validated on read', () => {
  it('never throws, whatever it is handed', () => {
    const hostile = [
      undefined, null, 0, 1, '', 'from', true, Symbol('s'), () => {}, [], new Date(0), new Map(),
      { get from() { throw new Error('boom') } },
      { from: { get label() { throw new Error('boom') } } },
      new Proxy({}, { get() { throw new Error('boom') } }),
    ]
    for (const state of hostile) {
      expect(() => readFrom(state)).not.toThrow()
      expect(readFrom(state)).toBeNull()
    }
  })

  it('is null unless state.from is a plain object', () => {
    expect(readFrom({})).toBeNull()
    expect(readFrom({ from: null })).toBeNull()
    expect(readFrom({ from: 'Pantry' })).toBeNull()
    expect(readFrom({ from: 7 })).toBeNull()
    expect(readFrom({ from: ['Pantry'] })).toBeNull()
    expect(readFrom({ from: Object.assign([], { label: 'Pantry' }) })).toBeNull()
    expect(readFrom({ from: Object.assign(new Date(0), { label: 'Pantry' }) })).toBeNull()
    expect(readFrom({ from: new Stamped() })).toBeNull()
    // …and a plain one reads, with or without a prototype.
    expect(readFrom({ from: { label: 'Pantry' } })).toEqual({ label: 'Pantry' })
    expect(readFrom({ from: Object.assign(Object.create(null), { label: 'Pantry' }) })).toEqual({ label: 'Pantry' })
  })

  it('is null unless its label is a non-blank string', () => {
    expect(readFrom({ from: {} })).toBeNull()
    expect(readFrom({ from: { kind: 'batch', id: 'kb-1' } })).toBeNull()
    expect(readFrom({ from: { label: '' } })).toBeNull()
    expect(readFrom({ from: { label: '   \n\t' } })).toBeNull()
    expect(readFrom({ from: { label: 7 } })).toBeNull()
    expect(readFrom({ from: { label: null } })).toBeNull()
    expect(readFrom({ from: { label: ['Pantry'] } })).toBeNull()
  })

  it('returns the label trimmed', () => {
    expect(readFrom({ from: { label: '  Closed batches \n' } })).toStrictEqual({ label: 'Closed batches' })
  })

  it("keeps kind only if it is 'recipe' or 'batch'", () => {
    expect(readFrom({ from: { label: 'Roll for Initiative', kind: 'recipe' } })).toStrictEqual({ label: 'Roll for Initiative', kind: 'recipe' })
    expect(readFrom({ from: { label: 'Pepper mash', kind: 'batch' } })).toStrictEqual({ label: 'Pepper mash', kind: 'batch' })
    for (const kind of ['planting', 'Recipe', 'BATCH', '', 0, true, null, undefined, {}, ['batch']]) {
      const got = readFrom({ from: { label: 'Pantry', kind } })
      expect(got).toStrictEqual({ label: 'Pantry' })
      expect('kind' in got).toBe(false)
    }
  })

  it('keeps id only if it is a string or a number, and returns it as a string', () => {
    expect(readFrom({ from: { label: 'Pepper mash', id: 'kb-1' } })).toStrictEqual({ label: 'Pepper mash', id: 'kb-1' })
    expect(readFrom({ from: { label: 'Pepper mash', id: 42 } })).toStrictEqual({ label: 'Pepper mash', id: '42' })
    expect(readFrom({ from: { label: 'Pepper mash', id: 0 } })).toStrictEqual({ label: 'Pepper mash', id: '0' })
    for (const id of [true, null, undefined, {}, ['kb-1'], () => 'kb-1']) {
      const got = readFrom({ from: { label: 'Pantry', id } })
      expect(got).toStrictEqual({ label: 'Pantry' })
      expect('id' in got).toBe(false)
    }
  })

  it('drops every other key on it, and hands back a new object', () => {
    const stored = { label: 'Pantry', kind: 'batch', id: 'kb-1', path: '/put-up?view=pantry', onBack: 'x', nested: { a: 1 } }
    const got = readFrom({ from: stored, background: { pathname: '/' } })
    expect(got).toStrictEqual({ label: 'Pantry', kind: 'batch', id: 'kb-1' })
    expect(got).not.toBe(stored)
    expect(Object.keys(got)).toEqual(['label', 'kind', 'id'])
  })
})

describe('withFrom — the state a PUSH into a Put-Up mode rides on', () => {
  const background = { pathname: '/', search: '', hash: '', state: null, key: 'home1', historyEntry: 'home1' }
  const prefill = { crop_type_slug: 'pepper', harvest_log_id: 'hl-1' }

  it('the input object is not mutated', () => {
    const state = { from: { label: 'Pantry' }, [CONTINUES_ENTRY_KEY]: 'list1', background, prefill, extra: [1, 2] }
    const before = JSON.stringify(state)
    withFrom(state, { label: 'Closed batches' })
    withFrom(state, null)
    expect(JSON.stringify(state)).toBe(before)
    expect(Object.keys(state)).toEqual(['from', CONTINUES_ENTRY_KEY, 'background', 'prefill', 'extra'])
    // A frozen state (and a frozen From) is taken without a throw: nothing is written back to either.
    const frozen = freezeDeep({ from: { label: 'Pantry' }, [CONTINUES_ENTRY_KEY]: 'list1', background: { ...background } })
    expect(() => withFrom(frozen, freezeDeep({ label: 'Recipes' }))).not.toThrow()
    expect(withFrom(frozen, null)).not.toBe(frozen)
  })

  it('copies its own keys when the state is a plain object, else starts empty', () => {
    expect(withFrom({ a: 1, b: 'two' }, { label: 'Pantry' })).toStrictEqual({ a: 1, b: 'two', from: { label: 'Pantry' } })
    const inherited = Object.create({ leaked: true })
    for (const state of [undefined, null, 'state', 7, true, ['a'], Object.assign([], { a: 1 }), new Stamped(), new Map([['a', 1]]), inherited]) {
      expect(withFrom(state, { label: 'Pantry' })).toStrictEqual({ from: { label: 'Pantry' } })
    }
  })

  it('an inherited `from` does not leak into a push that names none', () => {
    const state = { from: { label: 'Pantry' }, background }
    expect(withFrom(state, null)).toStrictEqual({ background })
    expect(withFrom(state, undefined)).toStrictEqual({ background })
    expect(withFrom(state)).toStrictEqual({ background })
    // A From that does not read is the same as none: the stale one still goes.
    expect(withFrom(state, { label: '   ' })).toStrictEqual({ background })
    expect(withFrom(state, 'Closed batches')).toStrictEqual({ background })
    expect(withFrom({ from: { label: 'Pantry' } }, null)).toBeNull()
  })

  it('sets `from` only when it reads as a From, and sets the validated copy', () => {
    const handed = { label: '  Roll for Initiative ', kind: 'recipe', id: 9, href: '/put-up?recipe=9' }
    const got = withFrom({ from: { label: 'Pantry' } }, handed)
    expect(got).toStrictEqual({ from: { label: 'Roll for Initiative', kind: 'recipe', id: '9' } })
    expect(got.from).not.toBe(handed)
    expect(handed).toStrictEqual({ label: '  Roll for Initiative ', kind: 'recipe', id: 9, href: '/put-up?recipe=9' })
    expect(readFrom(got)).toStrictEqual(got.from)
  })

  it('`continuesEntry` never rides a push', () => {
    expect(CONTINUES_ENTRY_KEY).toBe('continuesEntry')
    expect(withFrom({ [CONTINUES_ENTRY_KEY]: 'list1', background }, { label: 'Pantry' }))
      .toStrictEqual({ background, from: { label: 'Pantry' } })
    expect(withFrom({ [CONTINUES_ENTRY_KEY]: 'list1', background }, null)).toStrictEqual({ background })
    expect(withFrom({ [CONTINUES_ENTRY_KEY]: 'list1' }, null)).toBeNull()
  })

  it('keeps every other key as it is: background with its historyEntry, prefill, and keys it has never heard of', () => {
    const unknown = { deep: { er: true } }
    const got = withFrom({ background, prefill, unknown, flag: false, n: 0, nothing: null }, { label: 'Pantry' })
    expect(got).toStrictEqual({ background, prefill, unknown, flag: false, n: 0, nothing: null, from: { label: 'Pantry' } })
    expect(got.background.historyEntry).toBe('home1')
    expect(got.prefill).toBe(prefill)
    expect(got.unknown).toBe(unknown)
    // …and the same holds for a push that names no origin.
    expect(withFrom({ background, prefill, unknown }, null)).toStrictEqual({ background, prefill, unknown })
  })

  it('`background` survives by reference', () => {
    expect(withFrom({ background }, { label: 'Pantry' }).background).toBe(background)
    expect(withFrom({ background, from: { label: 'Recipes' } }, null).background).toBe(background)
  })

  it('returns null, not {}, when nothing is left', () => {
    expect(withFrom(null, null)).toBeNull()
    expect(withFrom(undefined, undefined)).toBeNull()
    expect(withFrom({}, null)).toBeNull()
    expect(withFrom({ from: { label: 'Pantry' }, [CONTINUES_ENTRY_KEY]: 'list1' }, { label: '' })).toBeNull()
    // A key holding undefined is still a key: only an EMPTY object collapses to null.
    expect(withFrom({ a: undefined }, null)).toStrictEqual({ a: undefined })
  })

  it('a sender on another route calls withFrom(null, from) and sends the origin alone', () => {
    expect(withFrom(null, { label: 'Megatron jalapeño', id: 'plant-7' }))
      .toStrictEqual({ from: { label: 'Megatron jalapeño', id: 'plant-7' } })
  })
})

describe('backLabel — the words after the arrow', () => {
  it('is the label, with the kind in brackets when the origin is a recipe or a batch', () => {
    expect(backLabel({ from: { label: 'Pantry' } }, 'Going now')).toBe('Pantry')
    expect(backLabel({ from: { label: 'Roll for Initiative', kind: 'recipe', id: 'r1' } }, 'Going now')).toBe('Roll for Initiative (recipe)')
    expect(backLabel({ from: { label: 'Pepper mash', kind: 'batch', id: 'kb-1' } }, 'Recipes')).toBe('Pepper mash (batch)')
    expect(backLabel({ from: { label: ' Closed batches ', kind: 'list' } }, 'Going now')).toBe('Closed batches')
  })

  it('is the fallback when the state carries no origin that reads', () => {
    expect(backLabel(null, 'Going now')).toBe('Going now')
    expect(backLabel(undefined, 'Pantry')).toBe('Pantry')
    expect(backLabel({}, 'Recipes')).toBe('Recipes')
    expect(backLabel({ from: { label: '  ' } }, 'Going now')).toBe('Going now')
    expect(backLabel({ from: 'Pantry', background: {} }, 'Going now')).toBe('Going now')
  })

  it('carries no arrow of its own: the page prints it once', () => {
    expect(backLabel({ from: { label: 'Pantry' } }, 'Going now')).not.toMatch(/[←<]/)
    expect(backLabel(null, 'Going now')).not.toMatch(/[←<]/)
  })
})

describe('modeSearch — one mode key per URL', () => {
  const start = () => new URLSearchParams('view=pantry&filter=use-soon&batch=kb-old&recipe=r-old&state=closed&find=mash&session=putup&place=loc-1&x=1')

  it('does not mutate the params it is handed, and returns a copy', () => {
    const params = start()
    const before = params.toString()
    const next = modeSearch(params, { batch: 'kb-new' })
    expect(params.toString()).toBe(before)
    expect(next).toBeInstanceOf(URLSearchParams)
    expect(next).not.toBe(params)
    next.set('later', '1')
    expect(params.has('later')).toBe(false)
  })

  it('deletes batch, recipe, state and find, and with a null mode sets none', () => {
    for (const mode of [null, undefined]) {
      const next = modeSearch(start(), mode)
      for (const k of ['batch', 'recipe', 'state', 'find']) expect(next.has(k)).toBe(false)
      expect(next.toString()).toBe('view=pantry&filter=use-soon&session=putup&place=loc-1&x=1')
    }
    expect(FIND_PARAM).toBe('find')
  })

  it('sets exactly one mode key: batch=<id>, recipe=<id> or state=closed', () => {
    expect(modeSearch(start(), { batch: 'kb-new' }).toString()).toBe('view=pantry&filter=use-soon&session=putup&place=loc-1&x=1&batch=kb-new')
    expect(modeSearch(start(), { recipe: 'r-new' }).toString()).toBe('view=pantry&filter=use-soon&session=putup&place=loc-1&x=1&recipe=r-new')
    expect(modeSearch(start(), { state: 'closed' }).toString()).toBe('view=pantry&filter=use-soon&session=putup&place=loc-1&x=1&state=closed')
    expect(modeSearch(new URLSearchParams(), { batch: 7 }).toString()).toBe('batch=7')
    for (const mode of [{ batch: 'b' }, { recipe: 'r' }, { state: 'closed' }]) {
      const next = modeSearch(start(), mode)
      expect(['batch', 'recipe', 'state'].filter(k => next.has(k))).toHaveLength(1)
      expect(next.has('find')).toBe(false)
    }
  })

  it('every other param stays, and the four it owns are registered Put-Up params', () => {
    const all = new URLSearchParams(Object.keys(PUT_UP_URL_PARAMS).map(k => [k, `v-${k}`]))
    all.append('unregistered', 'stays-too')
    const kept = [...modeSearch(all, null).keys()]
    const owned = Object.keys(PUT_UP_URL_PARAMS).filter(k => !kept.includes(k))
    expect(owned.sort()).toEqual(['batch', 'find', 'recipe', 'state'])
    expect(kept).toEqual([...Object.keys(PUT_UP_URL_PARAMS).filter(k => !owned.includes(k)), 'unregistered'])
    expect(modeSearch(all, { recipe: 'r1' }).get('session')).toBe('v-session')
  })

  it('a mode naming more than one is read batch, then recipe, then state; an id that is not usable names nothing', () => {
    expect(modeSearch(start(), { batch: 'b', recipe: 'r', state: 'closed' }).toString()).toMatch(/&batch=b$/)
    expect(modeSearch(start(), { recipe: 'r', state: 'closed' }).toString()).toMatch(/&recipe=r$/)
    expect(modeSearch(start(), { batch: '', recipe: 'r' }).toString()).toMatch(/&recipe=r$/)
    expect(modeSearch(start(), { batch: null, state: 'closed' }).toString()).toMatch(/&state=closed$/)
    for (const mode of [{}, { batch: '' }, { batch: null }, { recipe: undefined }, { batch: {} }, { state: 'going' }, { state: true }, 'batch']) {
      expect(modeSearch(start(), mode).toString()).toBe('view=pantry&filter=use-soon&session=putup&place=loc-1&x=1')
    }
  })
})
