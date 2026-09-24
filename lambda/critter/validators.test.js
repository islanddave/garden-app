import { describe, it, expect } from 'vitest'
import {
  validatePrefsPatchBody, validateSpeciesPrefsPatchBody,
  validateMarkViewedPatchBody, MAX_MARK_VIEWED_BATCH, UUID_RE,
  GARDEN_EXPANDED_MAX, NAV_TAB_KEYS, MOVABLE_TAB_KEYS, MORE_PIN_ID_RE, MORE_PINS_MAX,
} from './validators.js'

const VALID_UUID = '11111111-2222-3333-4444-555555555555'
const OTHER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('UUID_RE', () => {
  it('matches valid UUIDs', () => {
    expect(UUID_RE.test(VALID_UUID)).toBe(true)
    expect(UUID_RE.test(OTHER_UUID)).toBe(true)
  })
  it('rejects invalid UUIDs', () => {
    expect(UUID_RE.test('not-a-uuid')).toBe(false)
    expect(UUID_RE.test('')).toBe(false)
    expect(UUID_RE.test('11111111-2222-3333-4444-5555555555')).toBe(false)
  })
})

describe('validatePrefsPatchBody', () => {
  it('accepts each updatable field individually', () => {
    expect(validatePrefsPatchBody({ critter_visit: 'off' })).toBeNull()
    expect(validatePrefsPatchBody({ critter_visit: 'in_app_only' })).toBeNull()
    expect(validatePrefsPatchBody({ critter_visit: 'system' })).toBeNull()
    expect(validatePrefsPatchBody({ quiet_hours_start: '22:30' })).toBeNull()
    expect(validatePrefsPatchBody({ quiet_hours_end: '06:00' })).toBeNull()
  })
  it('rejects invalid critter_visit value', () => {
    expect(validatePrefsPatchBody({ critter_visit: 'maybe' })?.status).toBe(400)
  })
  it('rejects bad time format', () => {
    expect(validatePrefsPatchBody({ quiet_hours_start: '25:00' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ quiet_hours_start: '9pm' })?.status).toBe(400)
  })
  it('rejects empty body', () => {
    expect(validatePrefsPatchBody({})?.status).toBe(400)
  })
  it('accepts each valid garden_group_by value', () => {
    for (const v of ['none', 'type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'location', 'group', 'freeform', 'status']) {
      expect(validatePrefsPatchBody({ garden_group_by: v })).toBeNull()
    }
  })
  it('rejects an invalid garden_group_by value', () => {
    expect(validatePrefsPatchBody({ garden_group_by: 'bogus' })?.status).toBe(400)
  })
  it('accepts each valid garden_sort_order value', () => {
    expect(validatePrefsPatchBody({ garden_sort_order: 'alpha' })).toBeNull()
    expect(validatePrefsPatchBody({ garden_sort_order: 'recency' })).toBeNull()
  })
  it('rejects an invalid garden_sort_order value', () => {
    expect(validatePrefsPatchBody({ garden_sort_order: 'sideways' })?.status).toBe(400)
  })
  it('accepts a garden_expanded array of id strings (incl. empty)', () => {
    expect(validatePrefsPatchBody({ garden_expanded: [] })).toBeNull()
    expect(validatePrefsPatchBody({ garden_expanded: ['a', 'b', 'c'] })).toBeNull()
  })
  it('rejects garden_expanded that is not an array of strings', () => {
    expect(validatePrefsPatchBody({ garden_expanded: 'nope' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ garden_expanded: [1, 2] })?.status).toBe(400)
  })
  it('rejects an oversized garden_expanded', () => {
    expect(validatePrefsPatchBody({ garden_expanded: Array(2001).fill('x') })?.status).toBe(400)
  })
  it('accepts a garden_bloom_seen array of id strings', () => {
    expect(validatePrefsPatchBody({ garden_bloom_seen: [] })).toBeNull()
    expect(validatePrefsPatchBody({ garden_bloom_seen: ['robin', 'honeybee'] })).toBeNull()
  })
  it('rejects garden_bloom_seen that is not an array of strings', () => {
    expect(validatePrefsPatchBody({ garden_bloom_seen: 'nope' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ garden_bloom_seen: [1] })?.status).toBe(400)
  })
  it('accepts a boolean garden_helper_rung1_seen', () => {
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: true })).toBeNull()
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: false })).toBeNull()
  })
  it('rejects a non-boolean garden_helper_rung1_seen', () => {
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: 'yes' })?.status).toBe(400)
    expect(validatePrefsPatchBody({ garden_helper_rung1_seen: 1 })?.status).toBe(400)
  })
})

describe('validateSpeciesPrefsPatchBody (D-INV-1 Option A)', () => {
  it('accepts love (2.0) and meh (0.5)', () => {
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 2.0 })).toBeNull()
    expect(validateSpeciesPrefsPatchBody({ species_id: 5, weight: 0.5 })).toBeNull()
    expect(validateSpeciesPrefsPatchBody({ species_id: 8, weight: 1.0 })).toBeNull()
  })
  it('rejects species_id outside pool range', () => {
    expect(validateSpeciesPrefsPatchBody({ species_id: 0, weight: 1 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 300, weight: 1 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 255, weight: 1 })?.status).toBe(400)
  })
  it('rejects bad weights', () => {
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 0 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: -1 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 100 })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: NaN })?.status).toBe(400)
    expect(validateSpeciesPrefsPatchBody({ species_id: 3, weight: 'two' })?.status).toBe(400)
  })
})

describe('validateMarkViewedPatchBody (Session 3.5 §3.26)', () => {
  it('accepts null/undefined body (bulk-fallback path)', () => {
    expect(validateMarkViewedPatchBody(null)).toBeNull()
    expect(validateMarkViewedPatchBody(undefined)).toBeNull()
  })
  it('accepts empty object (no actually_seen_critter_ids key → bulk fallback)', () => {
    expect(validateMarkViewedPatchBody({})).toBeNull()
  })
  it('accepts empty array (still bulk fallback at handler — validator allows)', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [] })).toBeNull()
  })
  it('accepts single valid UUID', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [VALID_UUID] })).toBeNull()
  })
  it('accepts multiple valid UUIDs', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [VALID_UUID, OTHER_UUID] })).toBeNull()
  })
  it('rejects non-object body', () => {
    expect(validateMarkViewedPatchBody('string')?.status).toBe(400)
    expect(validateMarkViewedPatchBody(42)?.status).toBe(400)
  })
  it('rejects top-level array (not a plain object)', () => {
    expect(validateMarkViewedPatchBody([])?.status).toBe(400)
    expect(validateMarkViewedPatchBody([VALID_UUID])?.status).toBe(400)
  })
  it('rejects non-array actually_seen_critter_ids', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: VALID_UUID })?.status).toBe(400)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: { 0: VALID_UUID } })?.status).toBe(400)
  })
  it('rejects non-UUID items', () => {
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: ['not-a-uuid'] })?.status).toBe(400)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [VALID_UUID, 'bad'] })?.status).toBe(400)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: [123] })?.status).toBe(400)
  })
  it('rejects oversize batch (> MAX_MARK_VIEWED_BATCH)', () => {
    const big = new Array(MAX_MARK_VIEWED_BATCH + 1).fill(VALID_UUID)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: big })?.status).toBe(400)
  })
  it('accepts batch at MAX_MARK_VIEWED_BATCH', () => {
    const right_at_max = new Array(MAX_MARK_VIEWED_BATCH).fill(VALID_UUID)
    expect(validateMarkViewedPatchBody({ actually_seen_critter_ids: right_at_max })).toBeNull()
  })
  it('MAX_MARK_VIEWED_BATCH constant is exported and reasonable (≥50, ≤1000)', () => {
    expect(Number.isInteger(MAX_MARK_VIEWED_BATCH)).toBe(true)
    expect(MAX_MARK_VIEWED_BATCH).toBeGreaterThanOrEqual(50)
    expect(MAX_MARK_VIEWED_BATCH).toBeLessThanOrEqual(1000)
  })
})

// V4-USERPREFS-001 — the three per-device UI states that became per-user server state
// (V4-TODAYLOC-002, V4-LOGMANY-001, V4-WHATSNEW-002). today_skipped gets the most attention
// because it is the only non-scalar and the only one with a matching DB CHECK: this validator is
// what turns a malformed write into an actionable 400 instead of a constraint-violation 500.
describe('validatePrefsPatchBody — V4-USERPREFS-001 fields', () => {
  const ok = (body) => expect(validatePrefsPatchBody(body)).toBeNull()
  const bad = (body) => expect(validatePrefsPatchBody(body)?.status).toBe(400)

  it('accepts a well-formed today_skipped', () => {
    ok({ today_skipped: { date: '2026-08-17', keys: ['plant:abc', 'plant:def'] } })
    ok({ today_skipped: { date: '2026-08-17', keys: [] } })
  })

  it('rejects today_skipped that is not an object — an array satisfies typeof but not the contract', () => {
    bad({ today_skipped: ['plant:abc'] })
    bad({ today_skipped: 'plant:abc' })
    bad({ today_skipped: 42 })
  })

  it('rejects a missing or malformed date', () => {
    bad({ today_skipped: { keys: [] } })
    bad({ today_skipped: { date: '17-08-2026', keys: [] } })
    bad({ today_skipped: { date: '2026-8-7', keys: [] } })
    bad({ today_skipped: { date: 20260817, keys: [] } })
  })

  it('rejects a missing or non-string keys array', () => {
    bad({ today_skipped: { date: '2026-08-17' } })
    bad({ today_skipped: { date: '2026-08-17', keys: 'plant:abc' } })
    bad({ today_skipped: { date: '2026-08-17', keys: [1, 2] } })
  })

  it('rejects an oversize keys array', () => {
    bad({ today_skipped: { date: '2026-08-17', keys: new Array(GARDEN_EXPANDED_MAX + 1).fill('k') } })
    ok({ today_skipped: { date: '2026-08-17', keys: new Array(GARDEN_EXPANDED_MAX).fill('k') } })
  })

  it('log_many_all_selected must be boolean — and false is a REAL value, not an absence', () => {
    ok({ log_many_all_selected: true })
    // The whole point of nullable-no-default: `false` is a choice and must survive validation.
    ok({ log_many_all_selected: false })
    bad({ log_many_all_selected: 'true' })
    bad({ log_many_all_selected: 1 })
  })

  it('whats_new_last_seen accepts any short string — NOT semver-validated on purpose', () => {
    ok({ whats_new_last_seen: '4.31.0' })
    // A future scheme must not be rejected here; the client treats unparseable as "show the dot".
    ok({ whats_new_last_seen: '2026.08-rc1' })
    bad({ whats_new_last_seen: 'x'.repeat(33) })
    bad({ whats_new_last_seen: 4.31 })
  })

  it('each new field ALONE satisfies the has-updatable check', () => {
    // Regression guard: the field must be added to HAS_UPDATABLE, not just validated. Omitting it
    // there yields "no updatable fields present" on a body that is otherwise perfectly valid —
    // a 400 that names the wrong problem and is very hard to read from the client side.
    ok({ today_skipped: { date: '2026-08-17', keys: [] } })
    ok({ log_many_all_selected: true })
    ok({ whats_new_last_seen: '4.31.0' })
  })

  it('still rejects an empty body', () => {
    bad({})
  })
})

// V5-NAVCUSTOM-001 — more_pins and bar_layout, the two per-person nav settings (CONTRACT §3, §4).
// House rule: every guard has an input that only it catches. Each case below names the mutation of
// validatePrefsPatchBody that turns it red; "delete X" means removing that one `if`/predicate. The
// expected verdicts in the exhaustive cases are computed independently of the validator (a separate
// permutation generator), so they cannot agree with it by sharing its logic.
describe('validatePrefsPatchBody — V5-NAVCUSTOM-001 more_pins + bar_layout', () => {
  const ok = (body) => expect(validatePrefsPatchBody(body)).toBeNull()
  const refuses = (body, error) => expect(validatePrefsPatchBody(body)).toEqual({ status: 400, error })
  const DEFAULT_ORDER = ['today', 'garden', 'create', 'harvests', 'put-up']
  const layout = (order, hidden) => ({ bar_layout: { order, hidden } })

  // Every ordering of `items` taking `k` of them, no repeats. Independent of the validator.
  const arrangements = (items, k) => (k === 0 ? [[]] : items.flatMap((x, i) =>
    arrangements([...items.slice(0, i), ...items.slice(i + 1)], k - 1).map((rest) => [x, ...rest])))
  // Every sequence of length 0..maxLen over `symbols`, repeats allowed.
  const sequences = (symbols, maxLen) => {
    const out = [[]]
    let frontier = [[]]
    for (let n = 1; n <= maxLen; n++) {
      frontier = frontier.flatMap((s) => symbols.map((x) => [...s, x]))
      out.push(...frontier)
    }
    return out
  }

  describe('shared constants — CONTRACT §4, the values the SPA must agree with', () => {
    it('NAV_TAB_KEYS, MOVABLE_TAB_KEYS, MORE_PIN_ID_RE and MORE_PINS_MAX carry the contract values', () => {
      expect(NAV_TAB_KEYS).toEqual(DEFAULT_ORDER)
      expect(MOVABLE_TAB_KEYS).toEqual(['garden', 'harvests', 'put-up'])
      expect(MORE_PIN_ID_RE.source).toBe('^[a-z][a-z0-9-]{0,39}$')
      expect(MORE_PIN_ID_RE.flags).toBe('')
      expect(MORE_PINS_MAX).toBe(32)
    })

    it('Today and ＋ are never movable, and every movable key is a real tab', () => {
      // Today is where the app lands; ＋ is the only door to the create sheet and the field mic.
      expect(MOVABLE_TAB_KEYS).not.toContain('today')
      expect(MOVABLE_TAB_KEYS).not.toContain('create')
      for (const k of MOVABLE_TAB_KEYS) expect(NAV_TAB_KEYS).toContain(k)
    })
  })

  describe('more_pins', () => {
    const ENTRY_ERROR = 'more_pins entries must be row ids: a lowercase letter, then up to 39 of a-z, 0-9 or -'

    it('accepts [] (the clear), real ids, unknown ids, and the 40-char and 32-entry limits', () => {
      ok({ more_pins: [] })
      ok({ more_pins: ['seeds', 'photos'] })
      ok({ more_pins: ['settings-controls', 'put-up', 'a1'] })
      // SHAPE ONLY: an id no current More row has must be storable, or one retired row would make every
      // later save by that person fail (CONTRACT §3).
      ok({ more_pins: ['retired-row-from-2025'] })
      ok({ more_pins: ['a' + 'b'.repeat(39)] })
      ok({ more_pins: Array.from({ length: MORE_PINS_MAX }, (_, i) => `row-${i}`) })
    })

    it('refuses a non-array — mutation: delete the Array.isArray guard (the validator then THROWS)', () => {
      for (const v of ['seeds', { 0: 'seeds' }, 7, true]) {
        refuses({ more_pins: v }, 'more_pins must be an array of More row ids')
      }
    })

    it('refuses 33 entries — mutation: delete the MORE_PINS_MAX guard', () => {
      refuses({ more_pins: Array.from({ length: MORE_PINS_MAX + 1 }, (_, i) => `row-${i}`) },
        `more_pins exceeds max ${MORE_PINS_MAX}`)
    })

    it('refuses non-string entries — mutation: delete `typeof id !== \'string\'` (RegExp.test coerces)', () => {
      // String(['seeds']) is "seeds", String(null) is "null", String(true) is "true": all three match the
      // pattern, so only the typeof half of the predicate catches them.
      for (const v of [['seeds'], null, true]) refuses({ more_pins: [v] }, ENTRY_ERROR)
    })

    it('refuses malformed ids — mutation: delete the MORE_PIN_ID_RE test', () => {
      for (const id of ['Seeds', '1seeds', '-seeds', 'seeds!', '', 'see ds', 'seeds_x', 'séeds',
        'seeds\n', 'a' + 'b'.repeat(40)]) {
        refuses({ more_pins: ['photos', id] }, ENTRY_ERROR)
      }
    })

    it('refuses a repeated id — mutation: delete the Set-size guard', () => {
      refuses({ more_pins: ['seeds', 'photos', 'seeds'] }, 'more_pins must not repeat an id')
    })

    it('null or absent means unchanged; [] alone is an update — mutation: leave more_pins out of HAS_UPDATABLE', () => {
      ok({ more_pins: [] })
      ok({ more_pins: ['seeds'] })
      ok({ more_pins: null, critter_visit: 'off' })
      refuses({ more_pins: null }, 'no updatable fields present')
    })
  })

  describe('bar_layout', () => {
    const ORDER_ENTRY_ERROR = 'bar_layout.order entries must be one of: today, garden, create, harvests, put-up'
    const HIDDEN_ENTRY_ERROR = 'bar_layout.hidden entries must be one of: garden, harvests, put-up'

    it('accepts every order x every hidden list — all 120 permutations x all 16 ordered movable sets', () => {
      // Also the server's half of CONTRACT §5 invariant 2: whatever a total client resolver outputs as
      // {order, hidden} is one of these 1,920 values, and every one of them is accepted.
      const orders = arrangements(DEFAULT_ORDER, 5)
      const hiddens = [0, 1, 2, 3].flatMap((k) => arrangements(['garden', 'harvests', 'put-up'], k))
      expect(orders).toHaveLength(120)
      expect(hiddens).toHaveLength(16)
      const refused = []
      for (const o of orders) {
        for (const h of hiddens) if (validatePrefsPatchBody(layout(o, h)) !== null) refused.push({ o, h })
      }
      expect(refused).toEqual([])
    })

    it('accepts an order IF AND ONLY IF it is a permutation of the five tabs (55,987 sequences)', () => {
      // Every sequence of length 0..6 over the five keys plus one unknown. Deleting the vocabulary, the
      // repeat or the arity guard admits some non-permutation here; a guard that refuses a real
      // permutation turns the other direction red.
      const perms = new Set(arrangements(DEFAULT_ORDER, 5).map((p) => JSON.stringify(p)))
      const all = sequences([...DEFAULT_ORDER, 'moon'], 6)
      expect(all).toHaveLength(55987)
      const wrong = all.filter((s) => (validatePrefsPatchBody(layout(s, [])) === null) !== perms.has(JSON.stringify(s)))
      expect(wrong.slice(0, 5)).toEqual([])
      expect(all.filter((s) => validatePrefsPatchBody(layout(s, [])) === null)).toHaveLength(120)
    })

    it('accepts a hidden list IF AND ONLY IF it is distinct movable tabs (1,555 sequences)', () => {
      const legal = new Set([0, 1, 2, 3].flatMap((k) => arrangements(['garden', 'harvests', 'put-up'], k))
        .map((h) => JSON.stringify(h)))
      const all = sequences([...DEFAULT_ORDER, 'moon'], 4)
      expect(all).toHaveLength(1555)
      const wrong = all.filter((h) => (validatePrefsPatchBody(layout(DEFAULT_ORDER, h)) === null) !== legal.has(JSON.stringify(h)))
      expect(wrong.slice(0, 5)).toEqual([])
    })

    it('refuses a non-object, naming bar_layout — mutation: delete the object guard', () => {
      // Deleting it changes the MESSAGE, not the verdict: [] and 7 then answer about bar_layout.order,
      // and 'today' / ['today'] about an unknown key "0". Asserted on the message because CONTRACT §3
      // requires the 400 to name the field that is wrong, and here that field is bar_layout itself.
      for (const v of [[], ['today'], 'today', 7, true]) {
        refuses({ bar_layout: v }, 'bar_layout must be an object with keys order and hidden')
      }
    })

    it('refuses any key but order and hidden — mutation: delete the unknown-key guard', () => {
      refuses({ bar_layout: { order: DEFAULT_ORDER, hidden: [], pinned: [] } }, 'bar_layout has unknown key: pinned')
      refuses({ bar_layout: { order: DEFAULT_ORDER, hidden: [], nav_tabs: DEFAULT_ORDER } }, 'bar_layout has unknown key: nav_tabs')
    })

    it('refuses a missing or non-array order — mutation: delete the order Array.isArray guard (then THROWS)', () => {
      refuses({ bar_layout: { hidden: [] } }, 'bar_layout.order must be an array of tab keys')
      for (const v of ['today', { 0: 'today' }, 5, null]) {
        refuses(layout(v, []), 'bar_layout.order must be an array of tab keys')
      }
    })

    it('refuses an unknown or non-string tab in order — mutation: delete the order vocabulary guard', () => {
      for (const o of [
        ['today', 'garden', 'create', 'harvests', 'moon'],
        ['today', 'garden', 'create', 'harvests', 'more'],   // More is always last and is not a tab key
        ['today', 'garden', 'create', 'harvests', 1],
        ['today', 'garden', 'create', 'harvests', null],
        ['today', 'garden', 'create', 'harvests', ['put-up']],
      ]) refuses(layout(o, []), ORDER_ENTRY_ERROR)
    })

    it('refuses a repeated tab in order — mutation: delete the order repeat guard', () => {
      refuses(layout(['today', 'today', 'create', 'harvests', 'put-up'], []), 'bar_layout.order must not repeat a tab')
    })

    it('refuses an order that leaves a tab out — mutation: delete the order arity guard', () => {
      // A tab leaves the bar through `hidden`, never by being dropped from `order`. An order LONGER
      // than five cannot reach this guard (a sixth entry is a repeat or an unknown key), the same honest
      // limit the app-config nav_tabs validator carries.
      refuses(layout([], []), 'bar_layout.order must list all 5 tabs')
      refuses(layout(['today', 'garden', 'create', 'harvests'], []), 'bar_layout.order must list all 5 tabs')
    })

    it('refuses a missing or non-array hidden — mutation: delete the hidden Array.isArray guard (then THROWS)', () => {
      refuses({ bar_layout: { order: DEFAULT_ORDER } }, 'bar_layout.hidden must be an array of tab keys')
      for (const v of ['put-up', { 0: 'put-up' }, 3, null]) {
        refuses(layout(DEFAULT_ORDER, v), 'bar_layout.hidden must be an array of tab keys')
      }
    })

    it('refuses hiding Today, ＋ or anything not movable — mutation: delete the hidden vocabulary guard', () => {
      for (const h of [['create'], ['today'], ['garden', 'today'], ['more'], ['moon'], [1], [null]]) {
        refuses(layout(DEFAULT_ORDER, h), HIDDEN_ENTRY_ERROR)
      }
    })

    it('refuses a repeated hidden tab — mutation: delete the hidden repeat guard', () => {
      refuses(layout(DEFAULT_ORDER, ['garden', 'garden']), 'bar_layout.hidden must not repeat a tab')
    })

    it('a valid order with a bad hidden is refused WHOLE, together with every valid field beside it', () => {
      // Nothing of this body may be written: the validator answers before the route builds any SQL
      // (prefsNavcustom.test.js asserts no statement is sent).
      refuses(layout(DEFAULT_ORDER, ['create']), HIDDEN_ENTRY_ERROR)
      refuses({ critter_visit: 'off', more_pins: ['seeds'], bar_layout: { order: DEFAULT_ORDER, hidden: ['today'] } },
        HIDDEN_ENTRY_ERROR)
      refuses({ more_pins: ['seeds'], bar_layout: { order: DEFAULT_ORDER, hidden: [], extra: 1 } },
        'bar_layout has unknown key: extra')
    })

    it('null or absent means unchanged; a layout alone is an update — mutation: leave bar_layout out of HAS_UPDATABLE', () => {
      ok(layout(DEFAULT_ORDER, []))
      ok({ bar_layout: null, critter_visit: 'off' })
      refuses({ bar_layout: null }, 'no updatable fields present')
    })
  })
})
