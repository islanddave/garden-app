/**
 * src/__tests__/moreRegistry.test.js
 *
 * V5-NAVCUSTOM-001 — the More sheet as data, and the ids a person's pins are stored under.
 *
 * WHY THE IDS GET THEIR OWN FILE. A pin is a promise to a stored list in user_notification_prefs, so
 * an id that is renamed or reused silently un-pins (or worse, re-pins something else) for everyone who
 * held it — with no error anywhere. I10: pins are keyed by id, never by label or href, because both of
 * those have already changed under this menu (Spaces→Zones, /sow→/seeds).
 *
 * Every case names the mutation that turns it red. Mutations were run against the module, not assumed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MORE_ROWS, MORE_SECTIONS, RETIRED_MORE_IDS, MORE_ID_ALIASES, MORE_PIN_ID_RE, MORE_PINS_MAX_STORED,
  MORE_PINS_MAX_SHOWN, MOVED_SUB, resolvePins, layoutMoreSheet, drawnPinIds, drawableMoreRows, movedTabRow,
  barSlotRow, barSlotRows, ADORNMENT_IN_MORE, moreButtonAdornments,
} from '../lib/moreRegistry.js'
import { TAB_REGISTRY, MOVABLE_TAB_KEYS } from '../lib/navConfig.js'
import { getIcon, NEUTRAL_ICON } from '../lib/iconRegistry.js'

const liveIds = () => [...MORE_ROWS.map(r => r.id), ...Object.keys(TAB_REGISTRY)]

// THE MINTED IDS, frozen. Adding a row means adding its id here on purpose; renaming or removing one
// reds below unless the old id moves to RETIRED_MORE_IDS or MORE_ID_ALIASES.
const MINTED = [
  'dashboard', 'findings', 'photos', 'space', 'locations', 'inventory', 'seeds', 'achievements',
  'catch-up', 'collection', 'helper', 'settings', 'settings-controls', 'about', 'releases', 'admin',
  'today', 'garden', 'create', 'harvests', 'put-up',
  // End of season (lane seasonend-20260929) — a NEW row, minted here on purpose.
  'season-end',
  // Season stats (lane stats-l2-statspage-20260929) — a NEW row, minted here on purpose.
  'season-stats',
]

describe('the ids — minted once, frozen', () => {
  // KILLING MUTATION: give a row an id already used (e.g. photos → 'garden'). RESULT: RED.
  it('are unique across MORE_ROWS and TAB_REGISTRY, so a page has one id wherever it sits', () => {
    const ids = liveIds()
    expect(new Set(ids).size).toBe(ids.length)
  })

  // I10. KILLING MUTATION: rename an id (locations → 'zones') or delete a row. RESULT: RED here — the
  // old id is neither live, retired nor aliased, and the new one was never minted.
  it('SNAPSHOT: no minted id is renamed or dropped, and no live id is unminted', () => {
    const live = new Set(liveIds())
    for (const id of MINTED) {
      expect(live.has(id) || RETIRED_MORE_IDS.includes(id) || Object.hasOwn(MORE_ID_ALIASES, id),
        `${id} was minted and is now neither live, retired nor aliased — every pin on it just vanished`).toBe(true)
    }
    for (const id of live) expect(MINTED, `${id} is live but was never recorded as minted`).toContain(id)
  })

  it('every id matches the contract pattern, so the server will accept a pin on it', () => {
    for (const id of liveIds()) expect(MORE_PIN_ID_RE.test(id), id).toBe(true)
  })

  // KILLING MUTATION: add a live id (e.g. 'photos') to RETIRED_MORE_IDS. RESULT: RED.
  // The list is empty today, so the SELF-TEST beside it proves the check is not vacuous.
  it('retired ∩ live = ∅', () => {
    const live = new Set(liveIds())
    expect(RETIRED_MORE_IDS.filter(id => live.has(id))).toEqual([])
  })
  it('SELF-TEST: the retired∩live check can fail', () => {
    const live = new Set(liveIds())
    expect(['photos', 'gone'].filter(id => live.has(id))).toEqual(['photos'])
  })

  // KILLING MUTATION: alias to a typo ('seed') or to a retired id. RESULT: RED. And an alias KEY that
  // is itself live would silently redirect every pin on that live row.
  it('every alias targets a live id, and no alias shadows a live id', () => {
    const live = new Set(liveIds())
    expect(Object.keys(MORE_ID_ALIASES).length).toBeGreaterThan(0)
    for (const [from, to] of Object.entries(MORE_ID_ALIASES)) {
      expect(live.has(to), `${from} -> ${to}`).toBe(true)
      expect(live.has(from), `${from} is live and aliased`).toBe(false)
      expect(RETIRED_MORE_IDS, `${from} -> ${to}`).not.toContain(to)
    }
    // The V5-SEEDSTAB-001 merge, by name.
    expect(MORE_ID_ALIASES).toMatchObject({ sow: 'seeds', 'saved-seeds': 'seeds' })
  })
})

describe('the rows — every door leads somewhere real', () => {
  // Read as TEXT, like DebugMenu.reachability: the invariant is about what the router declares.
  const appSrc = readFileSync(resolve(process.cwd(), 'src/App.jsx'), 'utf8')
  const routes = new Set([...appSrc.matchAll(/path:\s*'([^']+)'/g)].map(m => m[1]))

  it('SELF-TEST: the route scan found the table', () => {
    expect(routes.size).toBeGreaterThanOrEqual(50)
    expect(routes.has('/today')).toBe(true)
  })

  // KILLING MUTATION: point a row at a route that does not exist ('/zones'). RESULT: RED.
  it('every row and every movable tab points at a route App.jsx declares', () => {
    for (const r of MORE_ROWS) expect(routes.has(r.to), `${r.id} -> ${r.to}`).toBe(true)
    for (const k of MOVABLE_TAB_KEYS) expect(routes.has(TAB_REGISTRY[k].to), k).toBe(true)
  })

  it('no two rows share a destination (one door per destination)', () => {
    const tos = drawableMoreRows({ moved: MOVABLE_TAB_KEYS }).map(r => r.to)
    expect(new Set(tos).size).toBe(tos.length)
  })

  it('every link row names an icon the registry really draws', () => {
    for (const r of MORE_ROWS.filter(r => !r.component)) {
      expect(getIcon(r.iconName), `${r.id} -> ${r.iconName}`).not.toBe(NEUTRAL_ICON)
    }
  })

  it('every row sits in a known section, in the sheet’s section order', () => {
    const keys = MORE_SECTIONS.map(s => s.key)
    expect(keys).toEqual(['garden', 'rewards', 'help', 'debug'])
    for (const r of MORE_ROWS) expect(keys, r.id).toContain(r.section)
  })

  // I12, at the data level (the render half is in BottomNav.test.jsx).
  it('row extras live in the data: Seeds subtitle + testid, Critters subtitle, the What’s-New dot', () => {
    const byId = Object.fromEntries(MORE_ROWS.map(r => [r.id, r]))
    expect(byId.seeds).toMatchObject({ sub: 'My seeds · Saved seeds · Sow now', testId: 'more-seeds' })
    expect(byId.collection.sub).toBe("Who's been visiting")
    expect(byId.releases.adornment).toBe('whatsNew')
    // V5-PLANTSTARTDATES-001: catch-up was the one unpinnable row (a CatchUpBadge component row). It is
    // a plain link row now, with a fixed subtitle and no count — so no row is unpinnable.
    expect(MORE_ROWS.filter(r => r.pinnable === false).map(r => r.id)).toEqual([])
    expect(byId['catch-up']).toMatchObject({ to: '/plants/catch-up', label: 'Catch up', sub: 'Add missing start dates' })
    expect(byId['catch-up']).not.toHaveProperty('component')
  })

  // KILLING MUTATION: move the row, rename it, or change its door. RESULT: RED.
  it('Season stats sits right after End of season in Your garden, exactly as the plan gives it', () => {
    const ids = MORE_ROWS.map(r => r.id)
    expect(ids.indexOf('season-stats')).toBe(ids.indexOf('season-end') + 1)
    expect(MORE_ROWS.find(r => r.id === 'season-stats')).toEqual({
      id: 'season-stats', to: '/season-stats', label: 'Season stats', iconName: 'nav.harvests', section: 'garden',
      sub: 'How this season went', barLabel: 'Stats',
    })
  })
})

// V5-NAVANYSLOT-001 — any More row may take a tab-bar slot (Dave 2026-09-30).
describe('barSlotRow / barSlotRows — a slot id becomes the row the bar draws', () => {
  // KILLING MUTATION: read MORE_ROWS only (drop the TAB_REGISTRY arm). RESULT: RED — Today draws nothing.
  it('a tab key draws its tab, FAB flag and all', () => {
    expect(barSlotRow('today')).toEqual({ ...TAB_REGISTRY.today, key: 'today' })
    expect(barSlotRow('create').highlight).toBe(true)
  })

  it('a More row id draws that row, wearing its bar label when it has one', () => {
    expect(barSlotRow('photos')).toEqual({ key: 'photos', to: '/photos', label: 'Photos', iconName: 'media.camera' })
    expect(barSlotRow('season-stats')).toMatchObject({ key: 'season-stats', to: '/season-stats', label: 'Stats' })
  })

  // KILLING MUTATION: drop the alias lookup. RESULT: RED — a slot stored as 'sow' draws nothing.
  it('an aliased id draws the live row it merged into', () => {
    expect(barSlotRow('sow')).toMatchObject({ key: 'seeds', label: 'Seeds' })
  })

  // KILLING MUTATION: drop rowEnabled. RESULT: RED — a flag-off row takes a slot to a dead page.
  it('an unknown id, a flag-off row, a prototype name and a non-string draw nothing', () => {
    const rows = [{ id: 'off', to: '/off', label: 'Off', iconName: 'nav.more', section: 'garden', enabled: false }]
    expect(barSlotRow('off', { rows })).toBeNull()
    for (const id of ['future-row', 'constructor', 'toString', '__proto__', null, 7, ['photos']]) {
      expect(barSlotRow(id), String(id)).toBeNull()
    }
  })

  // KILLING MUTATION: drop the repeat check in barSlotRows. RESULT: RED — Seeds drawn twice.
  it('barSlotRows skips what it cannot draw and draws each page once', () => {
    expect(barSlotRows(['today', 'future-row', 'seeds', 'sow', 'create']).map(r => r.key))
      .toEqual(['today', 'seeds', 'create'])
  })

  // Every row that can take a slot has a label that fits a ~53px slot at 0.62rem: 10 characters or
  // fewer, the width "Inventory" and "Dashboard" already prove. A longer label needs a barLabel.
  it('every drawable slot label is short enough for the bar', () => {
    for (const id of [...Object.keys(TAB_REGISTRY), ...MORE_ROWS.map(r => r.id)]) {
      const row = barSlotRow(id)
      if (!row) continue
      expect(row.label.length, id).toBeLessThanOrEqual(10)
    }
  })
})

// V5-NAVSLOTADORN-001 — a page's dot follows it onto the tab bar (Dave 2026-10-01). The render half
// is BottomNav.slotAdornment.test.jsx.
describe('adornments — a row’s dot goes where the row goes', () => {
  // KILLING MUTATION: barSlotRow returns the four slot fields only (the v4.168.0 shape). RESULT: RED.
  it('a slotted row keeps its adornment, and a row without one gains no key', () => {
    expect(barSlotRow('releases')).toEqual({ key: 'releases', to: '/releases', label: 'Releases', iconName: 'nav.notes', adornment: 'whatsNew' })
    expect(barSlotRow('collection').adornment).toBe('critterVisitor')
    expect(barSlotRow('photos')).not.toHaveProperty('adornment')
    for (const key of Object.keys(TAB_REGISTRY)) expect(barSlotRow(key), key).not.toHaveProperty('adornment')
  })

  // KILLING MUTATION: declare an adornment ADORNMENT_IN_MORE does not list. RESULT: RED — it would be
  // drawn nowhere while its row is in More, with no error.
  it('every declared adornment says where it is drawn inside More', () => {
    expect(ADORNMENT_IN_MORE).toEqual({ whatsNew: 'row', critterVisitor: 'more' })
    const declared = MORE_ROWS.filter(r => r.adornment)
    expect(declared.map(r => r.id)).toEqual(['collection', 'releases'])
    for (const r of declared) expect(['row', 'more'], r.id).toContain(ADORNMENT_IN_MORE[r.adornment])
  })

  // KILLING MUTATION: moreButtonAdornments ignores `onBar` (reads every enabled row). RESULT: RED —
  // More keeps a dot for a page that is on the bar.
  it('the More button wears a dot only for a page still INSIDE More', () => {
    expect(moreButtonAdornments()).toEqual(['critterVisitor'])
    expect(moreButtonAdornments({ moved: ['garden'], onBar: ['today', 'create', 'put-up'] })).toEqual(['critterVisitor'])
    expect(moreButtonAdornments({ onBar: ['today', 'create', 'collection'] })).toEqual([])
    // A 'row' dot never reaches the button, whether its page is in More or on the bar.
    expect(moreButtonAdornments({ onBar: ['today', 'create', 'releases'] })).toEqual(['critterVisitor'])
    const row = (id, extra) => ({ id, to: `/${id}`, label: id, iconName: 'nav.more', section: 'garden', adornment: 'critterVisitor', ...extra })
    // A flag-off row is not in the sheet, so it does not dot the button.
    expect(moreButtonAdornments({ rows: [row('off', { enabled: false })] })).toEqual([])
    // Two rows naming one dot: once, and it stays until the LAST of them leaves More.
    const two = [row('a'), row('b')]
    expect(moreButtonAdornments({ rows: two })).toEqual(['critterVisitor'])
    expect(moreButtonAdornments({ rows: two, onBar: ['a'] })).toEqual(['critterVisitor'])
    expect(moreButtonAdornments({ rows: two, onBar: ['a', 'b'] })).toEqual([])
  })
})

describe('a page on the bar leaves the More sheet (V5-NAVANYSLOT-001)', () => {
  // KILLING MUTATION: ignore `onBar` in drawableMoreRows. RESULT: RED — Photos on the bar AND in More.
  it('its row is not drawn in any section, and its pin sleeps', () => {
    const view = layoutMoreSheet({ pins: ['photos', 'seeds'], onBar: ['today', 'create', 'photos'] })
    const ids = [...view.pinned, ...view.sections.flatMap(sec => sec.rows)].map(r => r.id)
    expect(ids).not.toContain('photos')
    expect(view.pinned.map(r => r.id)).toEqual(['seeds'])
    expect(drawnPinIds(['photos', 'seeds'], { onBar: ['photos'] })).toEqual(['seeds'])
  })

  it('a bar slot stored under an alias takes the live row out too', () => {
    expect(drawableMoreRows({ onBar: ['sow'] }).map(r => r.id)).not.toContain('seeds')
  })

  // The other direction still holds: a movable tab off the bar is a More row.
  it('a moved tab is still drawn at the top of Your garden', () => {
    const view = layoutMoreSheet({ moved: ['harvests'], onBar: ['today', 'create', 'put-up'] })
    expect(view.sections[0].rows[0]).toMatchObject({ id: 'harvests', moved: true })
  })
})

describe('resolvePins — entry by entry, never throws', () => {
  it('null, undefined and non-arrays are no pins', () => {
    // KILLING MUTATION: delete the Array.isArray guard. RESULT: RED — for…of walks the STRING
    // 'seeds' character by character and pins 's', 'e', 'd'.
    for (const raw of [null, undefined, 'seeds', 42, { 0: 'seeds' }]) {
      expect(resolvePins(raw), JSON.stringify(raw)).toEqual([])
    }
  })

  // KILLING MUTATION: drop the typeof check. RESULT: RED — RegExp.test coerces ['seeds'] to 'seeds'.
  it('drops non-strings, including an array-wrapped id', () => {
    expect(resolvePins([7, null, {}, ['seeds'], 'photos'])).toEqual(['photos'])
  })

  // I10 at the read boundary: a label or an href is not an id. KILLING MUTATION: drop the
  // MORE_PIN_ID_RE test. RESULT: RED.
  it('drops ids that fail the contract pattern — a label or an href is not an id', () => {
    const bad = ['Seeds', '/seeds', 'seeds!', '', 'a'.repeat(41), '9lives', 'sow now']
    expect(resolvePins([...bad, 'photos'])).toEqual(['photos'])
    expect(resolvePins(['a'.repeat(40)])).toEqual(['a'.repeat(40)])
  })

  // KILLING MUTATION: skip the alias map. RESULT: RED — 'sow' is pinned as itself and sleeps forever.
  it('maps merged ids onto the row that absorbed them', () => {
    expect(resolvePins(['sow'])).toEqual(['seeds'])
    expect(resolvePins(['photos', 'saved-seeds'])).toEqual(['photos', 'seeds'])
  })

  // KILLING MUTATION: `Object.hasOwn(aliases, entry)` → `aliases[entry] ?? entry`. RESULT: RED —
  // 'constructor' resolves to Object itself.
  it('an id that happens to name an Object.prototype member is just an unknown id', () => {
    expect(resolvePins(['constructor', 'photos'])).toEqual(['constructor', 'photos'])
  })

  // KILLING MUTATION: delete the repeat check. RESULT: RED on both.
  it('drops repeats, first wins — including an alias that lands on a pin already held', () => {
    expect(resolvePins(['photos', 'seeds', 'photos'])).toEqual(['photos', 'seeds'])
    expect(resolvePins(['seeds', 'sow', 'photos'])).toEqual(['seeds', 'photos'])
  })

  // KILLING MUTATION: delete the retired check. RESULT: RED.
  it('drops retired ids', () => {
    expect(resolvePins(['old-row', 'photos'], { retired: ['old-row'] })).toEqual(['photos'])
  })

  // KILLING MUTATION: filter to known ids. RESULT: RED — a newer build's pin is lost on the next save.
  it('KEEPS unknown ids, so a save from this build preserves a newer build’s pins', () => {
    expect(resolvePins(['future-row', 'photos'])).toEqual(['future-row', 'photos'])
  })

  // KILLING MUTATION: delete the cap. RESULT: RED — 40 ids come back, which the server would 400.
  it(`stops at ${MORE_PINS_MAX_STORED}`, () => {
    const many = Array.from({ length: 40 }, (_, i) => `row-${i}`)
    expect(resolvePins(many)).toEqual(many.slice(0, MORE_PINS_MAX_STORED))
  })

  it('does not mutate its input', () => {
    const raw = ['sow', 'photos', 'photos']
    resolvePins(raw)
    expect(raw).toEqual(['sow', 'photos', 'photos'])
  })

  // I4, client vs contract (CONTRACT §3): whatever the column holds, the list this build keeps — and
  // therefore sends back on the next save — is one the server's more_pins validator accepts: strings
  // matching the pattern, no repeats, at most 32. Restated from the contract text (the Lambda cannot
  // be imported from src/); the integration step adds the parity run against validators.js.
  // KILLING MUTATION: any resolvePins rule removed above. RESULT: RED on the input that rule covers.
  it('I4 — every output is a list the contract accepts', () => {
    const accepts = (ids) => Array.isArray(ids) && ids.length <= 32 && new Set(ids).size === ids.length &&
      ids.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id))
    const hostile = [
      null, 'seeds', 42, {}, [], [null, 7, {}, ['seeds']], ['Seeds', '/seeds', 'seeds', 'seeds'],
      ['sow', 'saved-seeds', 'seeds'], Array.from({ length: 60 }, (_, i) => `row-${i % 45}`),
      ['a'.repeat(41), 'a'.repeat(40), 'constructor', '__proto__'],
    ]
    for (const raw of hostile) expect(accepts(resolvePins(raw)), JSON.stringify(raw)).toBe(true)
    // The client constant IS the contract's pattern, character for character.
    expect(MORE_PIN_ID_RE.source).toBe('^[a-z][a-z0-9-]{0,39}$')
    expect(MORE_PINS_MAX_STORED).toBe(32)
    expect(MORE_PINS_MAX_SHOWN).toBe(4)
  })
})

describe('layoutMoreSheet — I1 at the data level: exactly one door per destination', () => {
  const idsOf = (layout) => [...layout.pinned, ...layout.sections.flatMap(s => s.rows)].map(r => r.id)
  const spaceOff = MORE_ROWS.map(r => (r.id === 'space' ? { ...r, enabled: false } : r))
  // CATCH_UP_EDITOR_SHIPPED is on in MORE_ROWS since V5-PLANTSTARTDATES-001, so the third flag state
  // enumerated is now its OFF arm (the rollback lever).
  const catchUpOff = MORE_ROWS.map(r => (r.id === 'catch-up' ? { ...r, enabled: false } : r))
  const movedSets = [[], ['garden'], ['harvests'], ['put-up'], ['garden', 'harvests'], ['garden', 'put-up'],
    ['harvests', 'put-up'], ['garden', 'harvests', 'put-up']]
  const pinSets = [
    [], ['seeds', 'photos'], ['space'], ['put-up', 'seeds'], ['future-row', 'old', 'catch-up'],
    ['admin', 'releases', 'seeds', 'photos', 'garden', 'dashboard'], ['today', 'create'],
  ]

  // Enumerated: 8 moved sets × 7 pin sets × 3 flag states. KILLING MUTATIONS: draw a pinned row at
  // home too (drop the home filter) → a duplicate; drop the moved rows → a lost door; draw a flag-off
  // row → a door to a route that does not exist. RESULT: RED for each.
  it('every drawable row appears once — pinned or at home, never both, never neither', () => {
    for (const rows of [MORE_ROWS, spaceOff, catchUpOff]) {
      for (const moved of movedSets) {
        for (const pins of pinSets) {
          const layout = layoutMoreSheet({ pins, moved, rows })
          const ids = idsOf(layout)
          const expected = drawableMoreRows({ moved, rows }).map(r => r.id)
          const label = JSON.stringify({ moved, pins, space: rows !== spaceOff })
          expect(new Set(ids).size, label).toBe(ids.length)
          expect([...ids].sort(), label).toEqual([...expected].sort())
          expect(layout.pinned.length, label).toBeLessThanOrEqual(MORE_PINS_MAX_SHOWN)
        }
      }
    }
  })

  it('moved tabs come FIRST in Your garden, in bar order, subtitled with where they came from', () => {
    const layout = layoutMoreSheet({ moved: ['harvests', 'put-up'] })
    const garden = layout.sections.find(s => s.key === 'garden').rows
    expect(garden.slice(0, 2).map(r => r.id)).toEqual(['harvests', 'put-up'])
    expect(garden[0]).toMatchObject({ to: '/harvests', label: 'Harvests', sub: MOVED_SUB, moved: true })
    expect(garden[2].id).toBe('dashboard')
  })

  // KILLING MUTATION: order Pinned by registry order instead of pin order. RESULT: RED.
  it('Pinned follows pin order, and a pinned row returns home when unpinned', () => {
    expect(layoutMoreSheet({ pins: ['seeds', 'photos'] }).pinned.map(r => r.id)).toEqual(['seeds', 'photos'])
    const garden = layoutMoreSheet({ pins: [] }).sections.find(s => s.key === 'garden').rows.map(r => r.id)
    expect(garden.indexOf('photos')).toBeLessThan(garden.indexOf('seeds'))
  })

  // KILLING MUTATION: count every stored pin (not only drawn ones) toward the cap. RESULT: RED — a
  // sleeping pin would take a visible slot and Dave, seeing three, could not add a fourth.
  it('a sleeping pin does not take a visible slot', () => {
    expect(drawnPinIds(['future-row', 'seeds', 'photos', 'admin'])).toEqual(['seeds', 'photos', 'admin'])
    expect(layoutMoreSheet({ pins: ['future-row', 'seeds', 'photos', 'admin', 'about'] }).pinned.map(r => r.id))
      .toEqual(['seeds', 'photos', 'admin', 'about'])
  })

  it('at most four are shown; a fifth drawn pin stays at home rather than vanishing', () => {
    const layout = layoutMoreSheet({ pins: ['seeds', 'photos', 'admin', 'about', 'helper'] })
    expect(layout.pinned.map(r => r.id)).toEqual(['seeds', 'photos', 'admin', 'about'])
    expect(layout.sections.find(s => s.key === 'help').rows.map(r => r.id)).toContain('helper')
  })

  it('a pin on a tab that is back on the bar sleeps; a flag-off row’s pin sleeps; catch-up pins like any row', () => {
    expect(layoutMoreSheet({ pins: ['put-up'], moved: [] }).pinned).toEqual([])
    expect(layoutMoreSheet({ pins: ['put-up'], moved: ['put-up'] }).pinned.map(r => r.id)).toEqual(['put-up'])
    expect(layoutMoreSheet({ pins: ['space'], rows: spaceOff }).pinned).toEqual([])
    expect(layoutMoreSheet({ pins: ['catch-up'], rows: catchUpOff }).pinned).toEqual([])
    expect(layoutMoreSheet({ pins: ['catch-up'] }).pinned.map(r => r.id)).toEqual(['catch-up'])
  })

  // I10, from the render side: relabel the row and the pin still holds, because it is keyed by id.
  // KILLING MUTATION: match pins against row.label (or row.to). RESULT: RED.
  it('a pin survives a relabel and a route change, because it is keyed by id', () => {
    const relabelled = MORE_ROWS.map(r => (r.id === 'locations' ? { ...r, label: 'Spaces', to: '/zones' } : r))
    expect(layoutMoreSheet({ pins: ['locations'], rows: relabelled }).pinned[0]).toMatchObject({ id: 'locations', label: 'Spaces' })
  })

  it('movedTabRow carries the tab’s own route, label and icon — in the bar’s colour variant', () => {
    expect(movedTabRow('put-up')).toMatchObject({ id: 'put-up', to: '/put-up', label: 'Put-Up', iconName: 'nav.putup', iconVariant: 'filled' })
  })
})
