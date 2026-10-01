// Put-Up B′ release 2 — the Pantry list's pure rules (components/pantry/pantryRows.js, pantryBridge.js,
// putSomethingUp.js): grouping, the page search's match, how a row is said, which ONE inline action it
// offers, the door's method chips and its routing, and the rename bridge's retirement.
import { describe, it, expect, beforeEach } from 'vitest'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { jarRow, itemRow } from './helpers/pantryFake.js'
import {
  groupRows, searchHits, leftWords, inlineAction, discardChip, ageWords, afterUseWords, onlyUseSoon, USED_ONE, USED_UP,
  finishedByUse, severalLeft,
} from '../components/pantry/pantryRows.js'
import { noteBridgeVisit, dismissBridge, readBridge, bridgeKey } from '../components/pantry/pantryBridge.js'
import {
  methodChoices, routeFor, AS_IS, FRESH_LABEL, AS_IS_LABEL, jarBody, itemBody, previewLine, doorError, walkWhen, saveLabel,
  METHOD_REQUIRED_TEXT,
} from '../components/pantry/putSomethingUp.js'

installStoragePolyfill()
const NOW = new Date(2026, 8, 30)   // Sep 30 2026, local

describe('grouping (V4 §2.5: By place default / By what it is — the server sorts, this only groups)', () => {
  it('consecutive rows with one group_key form one group, in the server\'s order', () => {
    const rows = [jarRow({ stock_id: 'a', group_key: 'loc-1', group_label: 'Chest Freezer 1' }),
      itemRow({ stock_id: 'b', group_key: 'loc-1', group_label: 'Chest Freezer 1' }),
      jarRow({ stock_id: 'c', group_key: 'loc-3', group_label: 'Kitchen fridge' })]
    const g = groupRows(rows)
    expect(g.map(x => [x.key, x.label, x.rows.map(r => r.stock_id)])).toEqual([
      ['loc-1', 'Chest Freezer 1', ['a', 'b']], ['loc-3', 'Kitchen fridge', ['c']]])
  })
})

describe('the page search — name/label match only', () => {
  const rows = [jarRow({ stock_id: 'a', name: 'Megatron hot sauce', crop_type_slug: 'pepper' }), itemRow({ stock_id: 'b', name: 'Oat milk' })]
  it('matches the name, case-insensitively, and nothing else (not the crop, not the place)', () => {
    expect(searchHits(rows, [], 'HOT').map(h => h.key)).toEqual(['put_up:a'])
    expect(searchHits(rows, [], 'pepper')).toEqual([])
    expect(searchHits(rows, [], 'freezer')).toEqual([])
    expect(searchHits(rows, [], '   ')).toEqual([])
  })
  it('adds the host\'s extra corpus (loaded recipes) after the rows', () => {
    const extra = [{ key: 'r1', name: 'Hot sauce #4', kindLabel: 'recipe', onOpen: () => {} }]
    expect(searchHits(rows, extra, 'hot').map(h => h.key)).toEqual(['put_up:a', 'extra:r1'])
  })
})

describe('what a row says', () => {
  it('counted: "N left"; weighed: "about N g left" from grams_left; a bought item: nothing', () => {
    expect(leftWords(jarRow({ count_left: 3 }))).toBe('3 left')
    expect(leftWords(jarRow({ stock_mode: 'weighed', count_left: null, count_made: null, grams_left: 412.4 }))).toBe('about 412 g left')
    expect(leftWords(jarRow({ stock_mode: 'weighed', grams_left: null }))).toBeNull()
    expect(leftWords(itemRow())).toBeNull()
  })
  it('the discard chip reuses the basis words, with the server\'s status', () => {
    expect(discardChip(jarRow({ discard: { date: '2027-07-01', basis: 'table', status: 'ok' } }), NOW))
      .toBe('discard by Jul 1, 2027 · general figure: whole freeze, deep freezer')
    expect(discardChip(jarRow({ discard: { date: '2026-10-05', basis: 'typed', status: 'soon' } }), NOW))
      .toBe('discard by Oct 5 · set by hand · soon')
    expect(discardChip(jarRow({ discard: { date: '2026-09-01', basis: 'house', status: 'past' }, method: 'candy' }), NOW))
      .toBe('discard date passed Sep 1 · house estimate')
    expect(discardChip(jarRow({ discard: { date: null, basis: 'none', status: null } }), NOW)).toBe('no date — check it before using')
  })
  it('a recipe date names its recipe when the row carries it, else the generic words', () => {
    expect(discardChip(jarRow({ discard: { date: '2026-12-01', basis: 'recipe', status: 'ok', recipe_name: 'Reaper sauce #4' } }), NOW))
      .toBe('discard by Dec 1 · from the recipe: Reaper sauce #4')
    expect(discardChip(jarRow({ recipe_name: 'Kimchi', discard: { date: '2026-12-01', basis: 'recipe', status: 'ok' } }), NOW))
      .toBe('discard by Dec 1 · from the recipe: Kimchi')
    expect(discardChip(jarRow({ discard: { date: '2026-12-01', basis: 'recipe', status: 'ok' } }), NOW)).toBe('discard by Dec 1 · from the recipe')
  })
  it('a candy jar written before 1b stored a basis still says "house estimate" (FOODSAFETY-RULING-V101 §8.2)', () => {
    expect(discardChip(jarRow({ method: 'candy', discard: { date: '2026-12-01', basis: null, status: 'ok' } }), NOW))
      .toBe('discard by Dec 1 · house estimate')
  })
  it('a bought item shows a discard date ONLY if one was typed', () => {
    expect(discardChip(itemRow({ discard: { date: '2026-10-10', basis: 'typed', status: 'ok' } }), NOW)).toBe('discard by Oct 10 · set by hand')
    expect(discardChip(itemRow({ discard: { date: null, basis: 'none', status: null } }), NOW)).toBeNull()
  })
  it('a bought item\'s age only when the day is known', () => {
    expect(ageWords(itemRow({ acquired_at: '2026-09-18' }), NOW)).toBe('had it 12 days')
    expect(ageWords(itemRow({ acquired_at: '2026-09-29' }), NOW)).toBe('had it 1 day')
    expect(ageWords(itemRow({ acquired_at: '2026-09-30' }), NOW)).toBe('got it today')
    expect(ageWords(itemRow({ acquired_at: null }), NOW)).toBeNull()
    expect(ageWords(itemRow({ acquired_at: '2026-08-01', acquired_precision: 'month' }), NOW)).toBeNull()
    expect(ageWords(jarRow(), NOW)).toBeNull()
  })
})

describe('the ONE inline action', () => {
  it('Used one while a counted row has more than one left; Used it up otherwise', () => {
    expect(inlineAction(jarRow({ count_left: 2 }))).toBe(USED_ONE)
    expect(inlineAction(jarRow({ count_left: 1 }))).toBe(USED_UP)
    expect(inlineAction(jarRow({ stock_mode: 'weighed', count_left: null, count_made: null, grams_left: 300 }))).toBe(USED_UP)
    expect(inlineAction(itemRow())).toBe(USED_UP)
  })
  it('the in-place words take the count from the SERVER\'s answer', () => {
    expect(afterUseWords({ action: USED_ONE, jar: { remaining_count: 3 } })).toBe('3 left · used one')
    expect(afterUseWords({ action: USED_UP, jar: { remaining_count: 0 } })).toBe('used it up')
    expect(afterUseWords({ action: 'went_bad' })).toBe('marked gone bad')
    expect(afterUseWords({ action: 'gave_away', jar: { remaining_count: 2 } })).toBe('2 left · gave some away')
  })
  // Put-Up UX pass R1 — Went bad may be a part. MUTATION: say 'marked gone bad' for every went_bad -> the
  // first literal reds; treat every went_bad as finished -> the finishedByUse rows red.
  it('Went bad that leaves some says both counts, the server\'s; all of it stays "marked gone bad"', () => {
    expect(afterUseWords({ action: 'went_bad', use: { count_used: 2 }, jar: { remaining_count: 4 } })).toBe('4 left · 2 went bad')
    expect(afterUseWords({ action: 'went_bad', use: { count_used: 1 }, jar: { remaining_count: '2' } })).toBe('2 left · 1 went bad')
    expect(afterUseWords({ action: 'went_bad', use: { count_used: 4 }, jar: { remaining_count: 0 } })).toBe('marked gone bad')
    expect(afterUseWords({ action: 'went_bad', use: { count_used: 1 }, jar: null })).toBe('marked gone bad')
    expect(afterUseWords({ action: 'went_bad', use: null, jar: { remaining_count: 3 } })).toBe('3 left · some went bad')
  })
  it('a row is finished by a use only when nothing is left: a part gone bad keeps its action, like some given away', () => {
    expect(finishedByUse(null)).toBe(false)
    expect(finishedByUse({ action: 'went_bad', jar: { remaining_count: 4 } })).toBe(false)
    expect(finishedByUse({ action: 'went_bad', jar: { remaining_count: 0 } })).toBe(true)
    expect(finishedByUse({ action: 'went_bad', jar: null })).toBe(true)          // no count answered: today's rule
    expect(finishedByUse({ action: 'gave_away', jar: { remaining_count: 2 } })).toBe(false)
    expect(finishedByUse({ action: 'gave_away', jar: { remaining_count: 0 } })).toBe(true)
    expect(finishedByUse({ action: USED_ONE, jar: { remaining_count: 3 } })).toBe(false)
    expect(finishedByUse({ action: USED_ONE, jar: null })).toBe(false)
    expect(finishedByUse({ action: USED_UP, jar: { remaining_count: 0 } })).toBe(true)
    expect(finishedByUse({ action: USED_UP, jar: null })).toBe(true)
  })
  it('several left is ONE test: a counted put-up with more than one — never a weighed bag, a single or a bought item', () => {
    expect(severalLeft(jarRow({ count_left: 2 }))).toBe(true)
    expect(severalLeft(jarRow({ count_left: 1 }))).toBe(false)
    expect(severalLeft(jarRow({ stock_mode: 'weighed', count_left: null, count_made: null, grams_left: 300 }))).toBe(false)
    expect(severalLeft(itemRow())).toBe(false)
    expect(severalLeft(null)).toBe(false)
    // The row's Used one and the sheet's "Went bad…" hang on the same test.
    for (const r of [jarRow({ count_left: 5 }), jarRow({ count_left: 1 }), itemRow()]) {
      expect(inlineAction(r) === USED_ONE).toBe(severalLeft(r))
    }
  })
  it('"Use soon" keeps the server\'s soon and past rows only', () => {
    const rows = [jarRow({ stock_id: 'a', discard: { status: 'soon' } }), jarRow({ stock_id: 'b', discard: { status: 'past' } }),
      jarRow({ stock_id: 'c', discard: { status: 'ok' } }), itemRow({ stock_id: 'd' })]
    expect(onlyUseSoon(rows).map(r => r.stock_id)).toEqual(['a', 'b'])
  })
})

describe('the rename bridge — retired on dismiss or after 2 visits, per viewer', () => {
  beforeEach(() => localStorage.clear())
  it('shows on visits 1 and 2, not on 3', () => {
    expect(noteBridgeVisit('user_dave')).toBe(true)
    expect(noteBridgeVisit('user_dave')).toBe(true)
    expect(noteBridgeVisit('user_dave')).toBe(false)
  })
  it('a dismissal retires it for good', () => {
    expect(noteBridgeVisit('user_dave')).toBe(true)
    dismissBridge('user_dave')
    expect(noteBridgeVisit('user_dave')).toBe(false)
    expect(readBridge('user_dave').dismissed).toBe(true)
  })
  it('is per viewer: Jen\'s visits never retire Dave\'s line', () => {
    noteBridgeVisit('user_jen'); noteBridgeVisit('user_jen'); noteBridgeVisit('user_jen')
    expect(noteBridgeVisit('user_dave')).toBe(true)
    expect(bridgeKey('user_dave')).not.toBe(bridgeKey('user_jen'))
  })
  it('a broken record or throwing storage still shows it once and never throws', () => {
    localStorage.setItem(bridgeKey('u'), '{nope')
    expect(noteBridgeVisit('u')).toBe(true)
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied') } })
    try {
      expect(() => noteBridgeVisit('u')).not.toThrow()
      expect(() => dismissBridge('u')).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', orig)
    }
  })
})

describe('Put something up / the Walk — method chips by place, As is, and routing', () => {
  const planting = { source: 'planting', name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper', variety_id: 'v1' }
  const typed = { source: 'typed', name: 'Frozen peas' }
  it('Appendix B chips by the place\'s kind (≤ 4), the rest under More…', () => {
    expect(methodChoices({ placeKind: 'deep_freezer', what: typed }).chips).toEqual(['whole_freeze', 'blanch_freeze', 'roast_freeze', 'pesto'])
    expect(methodChoices({ placeKind: 'fridge', what: typed }).chips).toEqual(['quick_pickle', 'hot_sauce', 'ferment', 'pesto'])
    expect(methodChoices({ placeKind: 'pantry', what: typed }).chips).toEqual(['can_water_bath', 'jam_preserve', 'dehydrate', 'cure_store'])
    expect(methodChoices({ placeKind: 'cold_storage', what: typed }).chips).toEqual(['cold_store', 'cure_store', 'can_water_bath', 'ferment'])
    expect(methodChoices({ placeKind: 'other', what: typed }).chips).toEqual(['cure_store', 'dehydrate', 'candy'])
    const c = methodChoices({ placeKind: 'fridge', what: typed })
    expect(c.more).not.toContain('hot_sauce')
    expect(c.more).toContain('whole_freeze')
  })
  it('As is for a typed name; "Fresh, as picked" for a planting; NONE for a planting at a freezer', () => {
    expect(methodChoices({ placeKind: 'fridge', what: typed }).asIs).toBe(AS_IS_LABEL)
    expect(methodChoices({ placeKind: 'deep_freezer', what: typed }).asIs).toBe(AS_IS_LABEL)
    expect(methodChoices({ placeKind: 'fridge', what: planting }).asIs).toBe(FRESH_LABEL)
    expect(methodChoices({ placeKind: 'deep_freezer', what: planting }).asIs).toBeNull()
  })
  it('a method routes to a put-up, As is to a pantry item', () => {
    expect(routeFor('whole_freeze')).toBe('jar')
    expect(routeFor(AS_IS)).toBe('item')
    expect(routeFor(null)).toBeNull()
  })
  it('the button names the result', () => {
    expect(saveLabel('whole_freeze')).toBe('Save · frozen')
    expect(saveLabel(AS_IS)).toBe('Save · as is')
    expect(saveLabel(AS_IS, planting)).toBe('Save · fresh')
  })
  it('three required answers, method last, with the one line', () => {
    expect(doorError({ what: { name: ' ' }, place: {}, method: 'x' }).field).toBe('what')
    expect(doorError({ what: typed, place: null, method: 'x' }).field).toBe('where')
    expect(doorError({ what: typed, place: { key: 'id:loc-1' }, method: null })).toEqual({ error: METHOD_REQUIRED_TEXT, field: 'method' })
    expect(doorError({ what: typed, place: { key: 'id:loc-1' }, method: AS_IS })).toBeNull()
    expect(doorError({ what: typed, place: { key: 'id:loc-1' }, method: 'pesto', discard: { mode: 'date', date: '' } }).field).toBe('discard')
    expect(doorError({ what: typed, place: { key: 'id:loc-1' }, method: 'pesto', discard: { mode: 'date', date: '2027-01-01' } })).toBeNull()
  })
  it('a put-up body: the name as label, the planting and crop from the hit, key-presence discard', () => {
    const when = { date: '2026-09-30', precision: 'day' }
    const b = jarBody({ key: 'k', what: planting, storageLocationId: 'loc-1', method: 'whole_freeze', when, count: '3', discard: { mode: 'auto' } })
    expect(b).toEqual({ idempotency_key: 'k', label: 'Megatron jalapeño', method: 'whole_freeze', preserved_at: '2026-09-30',
      preserved_at_precision: 'day', preserved_at_approx: false, package_count: 3, storage_location_id: 'loc-1',
      crop_type_slug: 'pepper', variety_id: 'v1', plant_id: 'p1', source_kind: 'own_garden' })
    expect('use_by_target' in b).toBe(false)
    expect(jarBody({ key: 'k', what: typed, storageLocationId: 'l', method: 'pesto', when, discard: { mode: 'none' } }).use_by_target).toBeNull()
    expect(jarBody({ key: 'k', what: typed, storageLocationId: 'l', method: 'pesto', when, discard: { mode: 'date', date: '2027-01-02' } }).use_by_target).toBe('2027-01-02')
  })
  it('a pantry-item body is the contract\'s: a planting hit keeps plant_id and crop; a template place goes as {kind,label}', () => {
    const when = { date: '2026-09-30', precision: 'day' }
    expect(itemBody({ key: 'k', what: planting, place: { key: 'new:fridge:fridge', id: null, label: 'Fridge', kind: 'fridge' }, when, discard: { mode: 'auto' } }))
      .toEqual({ idempotency_key: 'k', name: 'Megatron jalapeño', place: { kind: 'fridge', label: 'Fridge' }, acquired_at: '2026-09-30',
        acquired_precision: 'day', plant_id: 'p1', crop_type_slug: 'pepper' })
    const b = itemBody({ key: 'k', what: typed, place: { key: 'id:loc-3', id: 'loc-3' }, when: { date: '2026-09-30', precision: 'unknown' }, discard: { mode: 'date', date: '2026-10-09' }, notes: ' from Aldi ' })
    expect(b).toEqual({ idempotency_key: 'k', name: 'Frozen peas', storage_location_id: 'loc-3', acquired_precision: 'unknown',
      use_by_target: '2026-10-09', notes: 'from Aldi' })
  })
  it('the preview line: the date it uses and the discard-by with its basis, from the engine', () => {
    const place = { kind: 'deep_freezer', label: 'Chest Freezer 1' }
    expect(previewLine({ method: 'whole_freeze', place, when: { date: '2026-09-30', precision: 'day' }, now: NOW }))
      .toBe('put up Sep 30 · discard by Sep 30, 2027 · general figure: whole freeze, deep freezer')
    expect(previewLine({ method: 'whole_freeze', place, when: { date: '2026-09-30', precision: 'day' }, discard: { mode: 'none' }, now: NOW }))
      .toBe('put up Sep 30 · no date · set by hand')
    expect(previewLine({ method: 'whole_freeze', place, when: { date: '2026-09-30', precision: 'unknown' }, now: NOW }))
      .toBe('put up: not sure · no date — check it before using')
    expect(previewLine({ method: AS_IS, place, when: { date: '2026-09-30', precision: 'day' }, now: NOW })).toBe('got it Sep 30')
    expect(previewLine({ method: null, place, when: { date: '2026-09-30', precision: 'day' }, now: NOW })).toBeNull()
  })
  it('the Walk\'s dates: an estimate chip stores its window start and word; Not sure stores the walk day, unknown', () => {
    expect(walkWhen({ choice: 'last_month', now: NOW }).when).toEqual({ date: '2026-08-01', precision: 'month' })
    expect(walkWhen({ choice: 'unsure', now: NOW }).when).toEqual({ date: '2026-09-30', precision: 'unknown' })
    expect(walkWhen({ choice: 'pickdate', pickedDate: '2026-10-02', now: NOW }).error).toMatch(/hasn't happened/)
    expect(walkWhen({ choice: null, now: NOW }).error).toBeTruthy()
  })
})
