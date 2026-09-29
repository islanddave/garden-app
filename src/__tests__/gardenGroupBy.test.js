// src/lib/gardenGroupBy.js — Garden's group-by options and how a choice is kept (BUG-GARDENGROUPBYRESET-001).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildGardenFacetOptions, GARDEN_TAG_FACETS, decideGroupByHydrate, sendGroupByChoice, servedFromCache, predatesGroupBySave,
  __resetGroupBySends, GROUPBY_PENDING_MAX_AGE_MS,
} from '../lib/gardenGroupBy.js'
import { FROM_CACHE } from '../lib/api.js'
import { PREDATES_GROUP_BY_SAVE } from '../lib/notificationPrefsClient.js'
import { loadGroupByPending, saveGroupByPending } from '../lib/projectTree.js'

const tagged = (...facets) => ({ p1: { direct: facets.slice(0, 1).map(facet => ({ facet })), projected: facets.slice(1).map(facet => ({ facet })) } })
const values = (opts) => opts.map(o => o.value)

describe('buildGardenFacetOptions — the options Garden\'s group-by control offers', () => {
  it('projects hidden, no tags: Type, Location, Lifecycle — the structural head only', () => {
    expect(buildGardenFacetOptions({}, true)).toEqual([
      { value: 'crop_type', label: 'Type' },
      { value: 'location', label: 'Location' },
      { value: 'status', label: 'Lifecycle' },
    ])
  })
  it('projects shown, no tags: Projects, Location, Lifecycle', () => {
    expect(values(buildGardenFacetOptions(null, false))).toEqual(['none', 'location', 'status'])
  })
  it('tag facets follow the head, in GARDEN_TAG_FACETS order, from direct AND projected tags', () => {
    const opts = buildGardenFacetOptions(tagged('bean_use', 'heat', 'lifecycle', 'freeform'), true)
    expect(values(opts)).toEqual(['crop_type', 'location', 'status', 'lifecycle', 'heat', 'bean_use', 'freeform'])
    expect(opts.find(o => o.value === 'lifecycle').label).toBe('Lifespan')   // the TAG facet; 'status' is "Lifecycle"
  })
  it('the tag "type" facet is replaced by crop_type when projects are hidden, and leads after Projects when shown', () => {
    expect(values(buildGardenFacetOptions(tagged('type'), true))).toEqual(['crop_type', 'location', 'status'])
    expect(values(buildGardenFacetOptions(tagged('type'), false))).toEqual(['none', 'type', 'location', 'status'])
  })
  it('a location-facet tag never duplicates the structural Location option', () => {
    expect(values(buildGardenFacetOptions(tagged('location'), true))).toEqual(['crop_type', 'location', 'status'])
  })
  it('every tag facet present: each listed once, labelled', () => {
    const everyFacet = { p1: { direct: GARDEN_TAG_FACETS.map(facet => ({ facet })) } }
    for (const hidden of [true, false]) {
      const opts = buildGardenFacetOptions(everyFacet, hidden)
      expect(new Set(values(opts)).size).toBe(opts.length)
      expect(opts.every(o => typeof o.label === 'string' && o.label.length > 0)).toBe(true)
      // 11 tag facets (13 less 'type' and 'location', which sit in the head) + the head.
      expect(opts.length).toBe(hidden ? 3 + 11 : 4 + 11)
    }
  })
})

// The hydrate decision, as a table. Columns: what this device holds, what is waiting, what the server says, what
// the body is — 'fresh', 'cached' (the service worker's copy) or 'predates' (a read that was on the wire when a
// grouping save was confirmed, marked by the prefs client) — and what the control can show right now.
const OFFER = ['crop_type', 'location', 'status', 'heat']
const HYDRATE = [
  // name                                                        local        pending      server       body        offerable → expected
  ['the bug: a waiting Type choice vs the server\'s Lifecycle',  'crop_type', 'crop_type', 'status',    'fresh',    OFFER,  { action: 'resend', value: 'crop_type' }],
  ['waiting beats an SW-cached body too',                        'crop_type', 'crop_type', 'status',    'cached',   OFFER,  { action: 'resend', value: 'crop_type' }],
  ['waiting beats a read that predates a save too',              'crop_type', 'crop_type', 'status',    'predates', OFFER,  { action: 'resend', value: 'crop_type' }],
  ['waiting is re-sent even when the server already agrees',     'crop_type', 'crop_type', 'crop_type', 'fresh',    OFFER,  { action: 'resend', value: 'crop_type' }],
  ['waiting is re-sent even with no prefs row at all',           'location',  'location',  null,        'fresh',    OFFER,  { action: 'resend', value: 'location' }],
  ['the pending value is what goes out, not the local copy',     'status',    'crop_type', 'status',    'fresh',    OFFER,  { action: 'resend', value: 'crop_type' }],
  // DECISION (QA MINOR 9): across devices the LAST CONFIRMED save wins, not the last pick. A choice still waiting
  // here goes out over another device's confirmed one, and that device takes it at its next visit.
  ['DECISION: last CONFIRMED save wins across devices',          'crop_type', 'crop_type', 'location',  'fresh',    OFFER,  { action: 'resend', value: 'crop_type' }],
  ['another device\'s choice, nothing waiting: adopt',           'crop_type', null,        'status',    'fresh',    OFFER,  { action: 'adopt', value: 'status' }],
  ['a stale local value adopts the server\'s',                   'none',      null,        'crop_type', 'fresh',    OFFER,  { action: 'adopt', value: 'crop_type' }],
  ['equal: no state write, no regroup',                          'crop_type', null,        'crop_type', 'fresh',    OFFER,  { action: 'keep' }],
  ['SW-cached body never adopts',                                'crop_type', null,        'status',    'cached',   OFFER,  { action: 'keep' }],
  // QA MINOR 4: the read left before a save this device has since confirmed; its row can be the one from before.
  ['a read that left before a confirmed save never adopts',      'crop_type', null,        'status',    'predates', OFFER,  { action: 'keep' }],
  ['unset server value (null)',                                  'crop_type', null,        null,        'fresh',    OFFER,  { action: 'keep' }],
  ['unset server value (empty string)',                          'crop_type', null,        '',          'fresh',    OFFER,  { action: 'keep' }],
  ['a non-string server value',                                  'crop_type', null,        7,           'fresh',    OFFER,  { action: 'keep' }],
  ['not offerable: Projects under PROJECTS_HIDDEN',              'location',  null,        'none',      'fresh',    OFFER,  { action: 'keep' }],
  // DECISION (QA MINOR 7): a server TAG grouping whose tag map has not landed is DROPPED for the visit, not deferred
  // (the fresh read has already ended the visit's hydrate). Tag groupings: BUG-GARDENTAGGROUPREPAINT-001.
  ['DECISION: a tag grouping read before the tag map is dropped', 'crop_type', null,        'bean_use',  'fresh',    OFFER,  { action: 'keep' }],
  ['offerable tag facet: adopt',                                 'crop_type', null,        'heat',      'fresh',    OFFER,  { action: 'adopt', value: 'heat' }],
  ['an empty pending string is nothing waiting',                 'crop_type', '',          'status',    'fresh',    OFFER,  { action: 'adopt', value: 'status' }],
]

describe('decideGroupByHydrate — the choice wins until its save is confirmed', () => {
  for (const [name, local, pending, server, body, offerable, expected] of HYDRATE) {
    it(name, () => {
      const fromCache = body === 'cached'
      const predatesSave = body === 'predates'
      expect(decideGroupByHydrate({ local, pending, server, fromCache, predatesSave, offerable })).toEqual(expected)
    })
  }
  it('defaults: no fromCache flag and no offerable list mean nothing is adopted', () => {
    expect(decideGroupByHydrate({ local: 'crop_type', pending: null, server: 'status' })).toEqual({ action: 'keep' })
  })
})

// The mark's age (rimpact #8: past GROUPBY_PENDING_MAX_AGE_MS a waiting choice yields to a differing FRESH value,
// is never re-sent over it, and is dropped) and the read's place in the visit (rimpact #4: only the mount-time
// read may adopt). Local is 'crop_type' throughout; ages in days before NOW.
const NOW = Date.UTC(2026, 8, 29, 12)
const DAY = 24 * 60 * 60 * 1000
const AGED = [
  // name                                                                pending      age   server      body        mayAdopt → expected
  ['an expired mark yields to a differing fresh value: dropped, value adopted', 'crop_type', 8,  'status',   'fresh',    true,  { action: 'adopt', value: 'status', dropPending: true }],
  ['…on a later read it is dropped too, the value left for the next mount',   'crop_type', 8,  'status',   'fresh',    false, { action: 'keep', dropPending: true }],
  ['…and dropped when Garden cannot show the value yet',                       'crop_type', 8,  'bean_use', 'fresh',    true,  { action: 'keep', dropPending: true }],
  ['an expired mark is never re-sent on a cached body (it cannot show the row)', 'crop_type', 8, 'status',   'cached',   true,  { action: 'keep' }],
  ['…nor on one that predates a save',                                         'crop_type', 8,  'status',   'predates', true,  { action: 'keep' }],
  ['an expired mark still goes out when the row holds nothing to yield to',   'crop_type', 8,  null,       'fresh',    true,  { action: 'resend', value: 'crop_type' }],
  ['…or already holds the same value (its ok confirms and clears it)',        'crop_type', 8,  'crop_type', 'fresh',   true,  { action: 'resend', value: 'crop_type' }],
  ['exactly 7 days has not expired yet',                                       'crop_type', 7,  'status',   'fresh',    true,  { action: 'resend', value: 'crop_type' }],
  ['a mark with no recorded age never expires',                                'crop_type', null, 'status', 'fresh',    true,  { action: 'resend', value: 'crop_type' }],
  ['rimpact #4: a later read in the visit never adopts',                        null,       null, 'status',   'fresh',    false, { action: 'keep' }],
  ['…but still re-sends a choice that is waiting',                             'crop_type', 1,  'status',   'fresh',    false, { action: 'resend', value: 'crop_type' }],
]

describe('decideGroupByHydrate — how long a mark waits, and which read may adopt', () => {
  for (const [name, pending, age, server, body, mayAdopt, expected] of AGED) {
    it(name, () => {
      const pendingAt = age == null ? null : NOW - age * DAY
      const d = decideGroupByHydrate({
        local: 'crop_type', pending, pendingAt, now: NOW, server,
        fromCache: body === 'cached', predatesSave: body === 'predates', offerable: OFFER, mayAdopt,
      })
      expect(d).toEqual(expected)
    })
  }
  it('the limit is seven days', () => {
    expect(GROUPBY_PENDING_MAX_AGE_MS).toBe(7 * DAY)
  })
})

// rimpact #3, simulation S5 — with the REAL prefs client and this lib, wired the way Garden wires them. Garden: Type
// picked, its save on the wire. Today: its prefs read goes out and the server answers it with the row from BEFORE
// the save. The save's ok arrives first and clears the mark. Garden again, joining Today's read. That body must
// be kept, never adopted: before the mark, it regrouped the list back to Lifecycle (S5's double flip).
describe('rimpact S5 — Garden → Type → Today → Garden on a slow radio', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('the read Today sent before the save was confirmed is kept, not adopted, when Garden joins it', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test')
    const prefs = await import('../lib/notificationPrefsClient.js')
    const lib = await import('../lib/gardenGroupBy.js')
    const tree = await import('../lib/projectTree.js')
    localStorage.clear()
    const wire = []
    vi.stubGlobal('fetch', vi.fn((_url, init = {}) => new Promise((resolve) => wire.push({ method: init.method || 'GET', resolve }))))
    const getToken = async () => 'tk'
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
    const user = 'user_dave'

    tree.saveGroupBy('crop_type')                                   // Garden: the pick, stored and marked…
    tree.saveGroupByPending(user, 'crop_type')
    const saving = lib.sendGroupByChoice({ save: (v) => prefs.saveGardenGroupBy({ getToken, value: v }), user, value: 'crop_type' })
    const todayRead = prefs.fetchNotificationPrefs({ getToken })     // …then Today, its read going out
    await settle()
    expect(wire.map(r => r.method)).toEqual(['PATCH', 'GET'])

    wire[0].resolve({ ok: true, status: 200, json: async () => ({}) })   // the save's ok lands first
    await saving
    expect(tree.loadGroupByPending(user)).toBeNull()

    const gardenRead = prefs.fetchNotificationPrefs({ getToken })    // Garden again: it JOINS Today's read
    expect(wire).toHaveLength(2)
    wire[1].resolve({ ok: true, json: async () => ({ garden_group_by: 'status' }) })   // the row from before the save
    const body = await gardenRead
    expect(body).toBe(await todayRead)

    const d = lib.decideGroupByHydrate({
      local: tree.loadGroupBy(), pending: tree.loadGroupByPending(user), server: body.garden_group_by,
      fromCache: lib.servedFromCache(body), predatesSave: lib.predatesGroupBySave(body),
      offerable: ['crop_type', 'location', 'status'], mayAdopt: true,
    })
    expect(lib.predatesGroupBySave(body)).toBe(true)
    expect(d).toEqual({ action: 'keep' })                            // unmarked, this was { adopt: 'status' }
  })
})

describe('servedFromCache — api.js\'s marker, read through the Symbol registry', () => {
  it('is the same symbol api.js stamps, not a lookalike', () => {
    const body = {}
    Object.defineProperty(body, FROM_CACHE, { value: true, enumerable: false })
    expect(servedFromCache(body)).toBe(true)
  })
  it('an unmarked body, null, and a non-object are fresh', () => {
    expect(servedFromCache({ garden_group_by: 'status' })).toBe(false)
    expect(servedFromCache(null)).toBe(false)
    expect(servedFromCache('x')).toBe(false)
  })
})

describe('predatesGroupBySave — the prefs client\'s mark, read through the Symbol registry', () => {
  it('is the same symbol the prefs client stamps, not a lookalike', () => {
    const body = {}
    Object.defineProperty(body, PREDATES_GROUP_BY_SAVE, { value: true, enumerable: false })
    expect(predatesGroupBySave(body)).toBe(true)
  })
  it('an unmarked body, an SW-cached one, null, and a non-object do not predate a save', () => {
    const cached = {}
    Object.defineProperty(cached, FROM_CACHE, { value: true, enumerable: false })
    expect(predatesGroupBySave({ garden_group_by: 'status' })).toBe(false)
    expect(predatesGroupBySave(cached)).toBe(false)
    expect(predatesGroupBySave(null)).toBe(false)
    expect(predatesGroupBySave('x')).toBe(false)
  })
})

// A save the test settles by hand, so two can be on the wire at once in either order.
function deferredSave() {
  const calls = []
  const save = (value) => new Promise((resolve, reject) => { calls.push({ value, resolve, reject }) })
  return { save, calls }
}
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

describe('sendGroupByChoice — only a confirmed save of THIS value clears the mark', () => {
  beforeEach(() => { localStorage.clear(); __resetGroupBySends() })

  it('ok clears it', async () => {
    saveGroupByPending('user_dave', 'crop_type')
    const res = await sendGroupByChoice({ save: async () => ({ ok: true }), user: 'user_dave', value: 'crop_type' })
    expect(res).toEqual({ ok: true })
    expect(loadGroupByPending('user_dave')).toBeNull()
  })
  it('a dead zone (status 0), a server error and a refusal all keep it', async () => {
    for (const res of [{ ok: false, status: 0 }, { ok: false, status: 503 }, { ok: false, status: 400 }, null, undefined, { ok: 'yes' }]) {
      saveGroupByPending('user_dave', 'crop_type')
      await sendGroupByChoice({ save: async () => res, user: 'user_dave', value: 'crop_type' })
      expect(loadGroupByPending('user_dave'), JSON.stringify(res)).toBe('crop_type')
    }
  })
  it('a save that throws keeps it and reports null', async () => {
    saveGroupByPending('user_dave', 'crop_type')
    const res = await sendGroupByChoice({ save: async () => { throw new Error('boom') }, user: 'user_dave', value: 'crop_type' })
    expect(res).toBeNull()
    expect(loadGroupByPending('user_dave')).toBe('crop_type')
  })
  it('an older value\'s confirmation leaves the newer choice waiting', async () => {
    saveGroupByPending('user_dave', 'location')
    await sendGroupByChoice({ save: async () => ({ ok: true }), user: 'user_dave', value: 'crop_type' })
    expect(loadGroupByPending('user_dave')).toBe('location')
  })
  for (const order of [[0, 1], [1, 0]]) {
    it(`two saves on the wire at once never confirm, answered ${order[0] === 0 ? 'in' : 'out of'} order`, async () => {
      const { save, calls } = deferredSave()
      saveGroupByPending('user_dave', 'location')
      const a = sendGroupByChoice({ save, user: 'user_dave', value: 'location' })
      saveGroupByPending('user_dave', 'crop_type')
      const b = sendGroupByChoice({ save, user: 'user_dave', value: 'crop_type' })
      await tick()
      expect(calls.map(c => c.value)).toEqual(['location', 'crop_type'])
      for (const i of order) { calls[i].resolve({ ok: true }); await tick() }
      await Promise.all([a, b])
      // Either PATCH may have been applied last, so neither ok proves the server ended on crop_type.
      expect(loadGroupByPending('user_dave')).toBe('crop_type')
      // The next save, alone on the wire, is the one that confirms.
      await sendGroupByChoice({ save: async () => ({ ok: true }), user: 'user_dave', value: 'crop_type' })
      expect(loadGroupByPending('user_dave')).toBeNull()
    })
  }
  // QA IMPORTANT 2 (probe 3): A → B → A inside one round trip — Type, Lifecycle, Type again on a weak radio, or a
  // mount's re-send followed by two picks. Compare-and-clear cannot protect this one: the first A's ok matches the
  // waiting A. Only marking the saves ALREADY on the wire as overlapped keeps it from clearing, while B — which may
  // still be applied after both A's on another Lambda instance — would leave the server on Lifecycle with nothing
  // waiting, for the next mount to adopt. KILLING MUTATION MQ1: drop the line that marks them.
  it('A → B → A in one round trip: the first A\'s ok does not clear the second A (QA probe 3)', async () => {
    const { save, calls } = deferredSave()
    saveGroupByPending('user_dave', 'crop_type')
    const a1 = sendGroupByChoice({ save, user: 'user_dave', value: 'crop_type' })
    saveGroupByPending('user_dave', 'status')
    const b = sendGroupByChoice({ save, user: 'user_dave', value: 'status' })
    saveGroupByPending('user_dave', 'crop_type')
    const a2 = sendGroupByChoice({ save, user: 'user_dave', value: 'crop_type' })
    await tick()
    expect(calls.map(c => c.value)).toEqual(['crop_type', 'status', 'crop_type'])
    calls[0].resolve({ ok: true }); await tick()
    expect(loadGroupByPending('user_dave')).toBe('crop_type')   // B may still be applied after A1 and A2
    calls[1].resolve({ ok: true }); calls[2].resolve({ ok: true })
    await Promise.all([a1, b, a2])
    expect(loadGroupByPending('user_dave')).toBe('crop_type')   // all three overlapped: the next lone send confirms
    await sendGroupByChoice({ save: async () => ({ ok: true }), user: 'user_dave', value: 'crop_type' })
    expect(loadGroupByPending('user_dave')).toBeNull()
  })
  it('a save that started while another was in flight is overlapped even if the first has settled by its answer', async () => {
    const { save, calls } = deferredSave()
    saveGroupByPending('user_dave', 'crop_type')
    const a = sendGroupByChoice({ save, user: 'user_dave', value: 'crop_type' })
    const b = sendGroupByChoice({ save, user: 'user_dave', value: 'crop_type' })
    await tick()
    calls[0].reject(new TypeError('Failed to fetch')); await tick()
    calls[1].resolve({ ok: true }); await Promise.all([a, b])
    expect(loadGroupByPending('user_dave')).toBe('crop_type')
  })
  it('sequential saves each stand alone', async () => {
    saveGroupByPending('user_dave', 'location')
    await sendGroupByChoice({ save: async () => ({ ok: false, status: 0 }), user: 'user_dave', value: 'location' })
    saveGroupByPending('user_dave', 'crop_type')
    await sendGroupByChoice({ save: async () => ({ ok: true }), user: 'user_dave', value: 'crop_type' })
    expect(loadGroupByPending('user_dave')).toBeNull()
  })
  it('never clears another person\'s waiting choice', async () => {
    saveGroupByPending('user_jen', 'status')
    await sendGroupByChoice({ save: async () => ({ ok: true }), user: 'user_dave', value: 'status' })
    expect(loadGroupByPending('user_jen')).toBe('status')
  })
})
