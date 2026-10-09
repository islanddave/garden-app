// The gate:today-shape:v2 contract and its fixture transforms, checked without a browser (V5-TODAYREDESIGN-001 S0).
// The gate proves the page; this proves the table and the grafts the page is served, so a typo in either fails
// in the unit suite instead of as a confusing red in real Chrome.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATES, SLICES, LANDED, SHELL, REGIONS_V2, TRIGGER_CELLS, KILLER_FAMILIES, isArmed } from './today-v2-contract.mjs'
import { redatePayload, applyGrafts, localSeeds, selectorFor, flipState, flipAttr } from './v2wire.js'
import { groupsOfRows, EXPECTED_GROUPS } from './v2groups.mjs'
import { MUTANTS_V2 } from '../todayMutantsV2.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'))
const D = read('dailyplan.dave.json')
const PLANTS = read('plants.json')
const G = read('v2-grafts.json')
const FIXTURES = ['busy', 'busyfull', 'busyhh', 'quiet', 'noplan', 'storage']

describe('today-v2 contract table', () => {
  it('names every state once, with a known fixture, a prefs file that exists, and an ET-10:30 clock', () => {
    const names = STATES.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('v2-closed-today') // MF1's added state
    for (const s of STATES) {
      expect(FIXTURES).toContain(s.fixture)
      expect(existsSync(join(HERE, s.prefs))).toBe(true)
      expect(s.clock).toMatch(/^\d{4}-\d{2}-\d{2}T14:30:00\.000Z$/)
      for (const g of s.grafts || []) expect(Object.keys(G)).toContain(g)
    }
  })
  it('arms checks only by slices that exist, and S0 arms the instrument on every state', () => {
    const all = [...STATES.flatMap((s) => s.checks), ...SHELL, ...REGIONS_V2]
    for (const c of all) for (const sl of [].concat(c.armedAt)) expect(SLICES).toContain(sl)
    for (const s of STATES) expect(s.checks.some((c) => c.family === 'prefs-instrument' && isArmed(c))).toBe(true)
    // S3 and S4 landed in parallel (wave 3), merged by the integrator; S4g, S5 and S6 (wave 4, in parallel) on that
    // merge, merged by the second integrator (build-int2.md).
    expect(LANDED).toEqual(['S0', 'S2', 'S3', 'S4', 'S4g', 'S5', 'S6'])
  })
  // S3 arms the glance + bar everywhere a plan exists, and split the checks that also measure a later slice: the S3
  // half is armed, the rest keeps its later slice. Pinned so the split cannot quietly arm (or drop) either half.
  it('S3 arms the glance, the verdict, the bar and its chips, and leaves the later halves waiting', () => {
    const armedIn = (name, fam) => STATES.find((s) => s.name === name).checks.filter((c) => c.family === fam && isArmed(c))
    const pendingIn = (name, fam) => STATES.find((s) => s.name === name).checks.filter((c) => c.family === fam && !isArmed(c))
    for (const s of STATES) {
      expect(armedIn(s.name, 'glance')).toHaveLength(1)
      if (s.fixture !== 'noplan') expect(armedIn(s.name, 'verdict-truncation')).toHaveLength(1)
    }
    expect(armedIn('v2-frost', 'first-screen').flatMap((c) => c.mustContain)).toEqual(expect.arrayContaining(['today-glance', 'weather-cue-line', 'frost-alert-line', 'today-jumpbar']))
    expect(armedIn('v2-frost', 'first-screen').flatMap((c) => c.mustShowText || [])).toEqual(['today-verdict'])
    // S5 landed the Protect half of the split.
    expect(pendingIn('v2-frost', 'first-screen')).toEqual([])
    expect(armedIn('v2-frost', 'first-screen').flatMap((c) => c.mustContain)).toEqual(expect.arrayContaining(['today-sec-protect', 'protect-pick']))
    // S5 and S6 landed together (integration 2): the whole-bar half (exactly these chips) arms beside S3's own half.
    expect(armedIn('v2-frost', 'jumpbar').map((c) => c.chipsOfPresent || c.chips)).toEqual([['protect', 'water', 'feed', 'check', 'harvest'], ['protect', 'water', 'feed', 'check', 'harvest']])
    expect(armedIn('v2-frost', 'jumpbar').filter((c) => c.chips).map((c) => c.armedAt)).toEqual([['S3', 'S5', 'S6']])
    expect(pendingIn('v2-frost', 'jumpbar')).toEqual([])
    for (const fam of ['chip-census', 'weather-once', 'region-headcount']) expect(armedIn('v2-frost', fam), fam).toHaveLength(1)
    expect(armedIn('v2-quiet', 'jumpbar').map((c) => c.present)).toEqual([false])
    expect(armedIn('v2-stale', 'stale-marker')).toHaveLength(1)
    expect(armedIn('v2-busy', 'first-screen').flatMap((c) => c.mustContain)).toEqual(expect.arrayContaining(['today-glance', 'today-jumpbar']))
    // The page must be taller than a screen for the bar to pin or a jump to land under it: S4's body gives that.
    for (const fam of ['sticky', 'jump-landing', 'jump-focus']) expect(SHELL.find((c) => c.family === fam).armedAt).toEqual(['S3', 'S4'])
    // The glance's REGIONS rows arm with S3 (the gate counts a row only once its own slice has landed); merged with
    // S4, Needs care's v2-frost rows are armed beside them; S5 adds the pick link; S6 arms Resting's and Harvest's.
    const glanceRows = ['today-weather', 'weather-cue-line', 'frost-alert-line', 'drought-line', 'leaf-wetness-line', 'today-basis-stamp', 'care-rain-note', 'care-drought-list']
    expect(REGIONS_V2.filter((r) => r.state === 'v2-frost' && r.armedAt === 'S3').map((r) => r.id)).toEqual(glanceRows)
    expect(REGIONS_V2.filter((r) => r.state === 'v2-frost' && isArmed(r)).map((r) => r.id)).toEqual([...glanceRows, 'today-substrate-note', 'care-cap-note', 'care-show-more', 'care-moist', 'care-bulk-chips', 'care-dormant', 'care-feed-suppressed', 'today-watch-band', 'compose-harvest-band', 'protect-pick'])
  })
  // S5 arms what Protect tonight and Heads-up can answer. Pinned so a later edit cannot quietly un-arm (or drop) any
  // of it — and so the three contract rows S5 had to restate stay restated.
  it('S5 arms the Protect / Heads-up states, with the rows it restated', () => {
    const armedIn = (name, fam) => STATES.find((s) => s.name === name).checks.filter((c) => c.family === fam && isArmed(c))
    const openSet = (name) => armedIn(name, 'section-open-set').map((c) => ({ open: c.open, closed: c.closed }))
    expect(openSet('v2-freeze')).toEqual([{ open: ['protect'], closed: undefined }])
    expect(openSet('v2-storage-open')).toEqual([{ open: ['headsup'], closed: undefined }])
    expect(openSet('v2-storage-deadline')).toEqual([{ open: ['headsup'], closed: undefined }])
    expect(openSet('v2-storage-past')).toEqual([{ open: undefined, closed: ['headsup'] }])
    expect(openSet('v2-remembered-urgent')).toEqual([{ open: ['protect'], closed: undefined }])
    expect(openSet('v2-routine')).toEqual([{ open: ['protect'], closed: ['care'] }])
    expect(openSet('v2-stale')).toEqual([{ open: [], closed: undefined }])
    for (const name of ['v2-busy-seen', 'v2-closed-today']) {
      const [c] = armedIn(name, 'section-open-set')
      expect(c.orderOf).toEqual(['protect', 'care'])
      expect(c.order).toBeUndefined() // the busy fixture carries Resting: a strict whole-page order could never be [protect, care]
    }
    expect(armedIn('v2-storage-open', 'region-headcount')).toHaveLength(1)
    expect(REGIONS_V2.filter((r) => r.state === 'v2-storage-open' && isArmed(r)).map((r) => r.id)).toEqual(['storage-deadline-alert'])
    // R16 re-stated from the measurement (673 vs 668): the Needs care header whole on the first screen.
    expect(armedIn('v2-busy', 'first-screen').some((c) => c.allRows === 'protect-row' && c.headerTopMax?.care === 'FIRST_SCREEN+-48')).toBe(true)
    expect(armedIn('v2-frost', 'first-screen').some((c) => c.headerTopMax?.care === 'FIRST_SCREEN+72')).toBe(true)
    expect(armedIn('v2-frost', 'visibility')).toHaveLength(1)
    // The S5 real-Chrome mutants carry their source (the runner refuses an armed mutant without one).
    for (const n of ['openNone', 'coldRowsInNeedsCare', 'pickLinkMissing', 'openAll', 'reorderSections']) {
      expect(isArmed(MUTANTS_V2[n]), n).toBe(true)
      expect(MUTANTS_V2[n].file && MUTANTS_V2[n].find, n).toBeTruthy()
    }
  })
  it('every chip the contract names is a chip the bar knows, and lands where the contract thinks', async () => {
    const { CHIP_ORDER, CHIPS } = await import('../../../src/lib/todayV2/chips.js')
    const named = STATES.flatMap((s) => s.checks).flatMap((c) => [...(c.chips || []), ...(c.chipsOfPresent || [])])
    for (const chip of named) expect(CHIP_ORDER).toContain(chip)
    expect(CHIPS.water.section).toBe('care')
  })
  // S2 arms the skeleton on EVERY state (version, prefs-loaded, no side-scroll, floors, title + date on the
  // first screen) plus the states S2's surface can answer: the quiet and no-plan first screens and both
  // remembered states. Pinned so a later edit cannot quietly un-arm them.
  it('S2 arms the skeleton everywhere and the quiet / no-plan / remembered states', () => {
    for (const s of STATES) for (const fam of ['version', 'prefs-loaded-attr', 'no-hscroll', 'floors', 'first-screen']) {
      expect(s.checks.some((c) => c.family === fam && isArmed(c))).toBe(true)
    }
    const armedIn = (name, fam) => STATES.find((s) => s.name === name).checks.filter((c) => c.family === fam && isArmed(c))
    expect(armedIn('v2-quiet', 'first-screen').some((c) => c.mustContain?.includes('care-empty') && c.wholePage)).toBe(true)
    expect(armedIn('v2-noplan', 'first-screen').some((c) => c.mustContain?.includes('today-noplan-card'))).toBe(true)
    // S6 arms v2-remembered's Harvest half beside S2's Resting half.
    expect(armedIn('v2-remembered', 'section-open-set').map((c) => c.open)).toEqual([['resting'], ['harvest', 'resting']])
    expect(armedIn('v2-remembered-conflict', 'section-open-set').map((c) => c.closed)).toEqual([['care']])
  })
  // S4g arms its own checks on the S4 surface only, and every S4g mutant names ≥ 2 killer families.
  it('S4g arms MF3\'s failure round trip on v2-busy, and its mutants each name ≥ 2 killers', () => {
    const busy = STATES.find((s) => s.name === 'v2-busy').checks.filter((c) => c.family === 'spot-retry')
    expect(busy).toHaveLength(1)
    expect(busy[0]).toMatchObject({ armedAt: 'S4g', group: 'Outside', fail: 2 })
    expect(isArmed(busy[0])).toBe(true)
    // §2.6's announcement, on v2-frost (its jump step is S3's chip): the plan's own sentence first.
    const ann = STATES.find((s) => s.name === 'v2-frost').checks.filter((c) => c.family === 'announce')
    expect(ann).toHaveLength(1)
    expect(ann[0].armedAt).toEqual(['S3', 'S4g'])
    expect(ann[0].steps[0]).toEqual({ press: 'tasks:Water', say: 'Needs care: Water, 168 in 8 spots.' })
    expect(ann[0].steps.some((s) => s.quiet)).toBe(true)
    // §2.5's emptied header, LAST on v2-frost (it leaves Needs care empty); busyfull's rain_skipped is 70.
    const frost = STATES.find((s) => s.name === 'v2-frost').checks
    const cu = frost.filter((c) => c.family === 'caught-up')
    expect(cu).toHaveLength(1)
    expect(cu[0]).toMatchObject({ armedAt: 'S4g', title: 'Needs care · all caught up', summary: '5 logged today, 70 watered by rain' })
    const s4g = Object.entries(MUTANTS_V2).filter(([, m]) => [].concat(m.armedAt).includes('S4g'))
    expect(s4g.map(([n]) => n)).toEqual(expect.arrayContaining(['dropSpotRetry', 'retryNewBatch', 'spotShareIsGroupTotal', 'noFilterAnnouncement', 'announceEveryRender', 'emptiedTitleStays', 'dropCaughtUpSummary']))
    for (const [n, m] of s4g) { expect(m.file && m.find, n).toBeTruthy(); expect(new Set(m.killers).size, n).toBeGreaterThanOrEqual(2) }
  })
  // S6 arms Harvest / Put-Up / Resting / household / the Sow row where S6 alone can answer; the checks that also
  // need Protect or Heads-up (S5) waited in S6's lane and arm here, with S5 landed beside it (integration 2).
  // Pinned so neither half can quietly arm or drop.
  it('S6 arms its own states and splits, and the S5 + S6 halves arm together', () => {
    const find = (name) => STATES.find((s) => s.name === name).checks
    const armedIn = (name, fam) => find(name).filter((c) => c.family === fam && isArmed(c))
    const pendingIn = (name, fam) => find(name).filter((c) => c.family === fam && !isArmed(c))
    expect(armedIn('v2-household', 'section-open-set').map((c) => c.closed)).toEqual([['hh-member_j']])
    expect(armedIn('v2-household', 'header-text').map((c) => [c.counts, c.summaries])).toEqual([[{ 'hh-member_j': 15 }, { 'hh-member_j': 'Water 8 · Feed 7' }]])
    expect(armedIn('v2-household', 'region-headcount')).toHaveLength(1)
    expect(armedIn('v2-storage-mid', 'section-open-set').map((c) => c.closed)).toEqual([['headsup', 'putup'], ['putup']])
    expect(pendingIn('v2-storage-mid', 'section-open-set')).toEqual([])
    for (const fam of ['region-headcount', 'owner-floors', 'header-text']) expect(armedIn('v2-storage-mid', fam), fam).toHaveLength(1)
    for (const name of ['v2-frost', 'v2-busy']) {
      expect(armedIn(name, 'section-open-set').filter((c) => c.orderOf).map((c) => c.orderOf)).toContainEqual(['care', 'harvest', 'resting'])
      expect(armedIn(name, 'header-text').filter((c) => c.sowRow).map((c) => c.sowRow)).toEqual(['All sow windows ›'])
      expect(armedIn(name, 'section-open-set').filter((c) => c.order).map((c) => c.order)).toEqual([['protect', 'care', 'harvest', 'resting']])
      expect(pendingIn(name, 'section-open-set')).toEqual([])
    }
    expect(armedIn('v2-frost', 'owner-floors').map((c) => c.owners)).toEqual([['glance', 'care', 'harvest', 'resting']])
    const s6Rows = REGIONS_V2.filter((r) => r.armedAt === 'S6').map((r) => [r.id, r.state, isArmed(r)])
    expect(s6Rows).toEqual([['care-dormant', 'v2-frost', true], ['today-watch-band', 'v2-frost', true], ['compose-harvest-band', 'v2-frost', true], ['cultivation-lead', '*', true], ['today-household', 'v2-household', true], ['putup-use-soon', 'v2-storage-mid', true]])
    // Every state owning an S6 REGIONS row runs a region-headcount check — v2-household and v2-storage-mid had none,
    // so their rows could never be counted. (S2's care-empty / today-noplan-card rows are counted instead by their
    // states' first-screen mustContain, which fails on absence.)
    for (const r of REGIONS_V2.filter((x) => x.armedAt === 'S6' && x.state !== '*')) expect(armedIn(r.state, 'region-headcount').length, r.id).toBeGreaterThan(0)
  })
  it('keeps every trigger-predicate mutant as a unit-table cell (Simplify 3), never silently dropped', () => {
    const cellMutants = new Set(TRIGGER_CELLS.map((c) => c.killedMutant))
    for (const [n, m] of Object.entries(MUTANTS_V2)) if (m.kind === 'unit-table') expect(cellMutants.has(n)).toBe(true)
  })
  // Integration 2 (S4g x S5 x S6): lanes built in parallel point mutants into each other's files (S5's
  // coldRowsInNeedsCare at useNeedsCare's CARE_NEEDS line, S6's five dropRegionInOwner at GlanceCard.jsx and one at
  // NeedsCare's FeedSuppressedList mount). The served plugin (vite.harness.v2mutant.mjs) throws on a missing pattern
  // and replaces EVERY occurrence, so each armed real-Chrome mutant's text must occur exactly once in its file —
  // checked here, so a merge that moves the text reds the unit suite, not the matrix forty minutes later.
  // Integration 2 (orchestrator, 2026-09-29): the container census is an IDENTITY check against the design's surfaces
  // as measured on the merged page — three fingerprints, since the glance card and the row card are one material —
  // and no card sits inside a card (plan-v2 Visual), on every state. extraCardFingerprint arms against exactly those.
  it('the visual census holds the three measured design surfaces, card-nesting runs everywhere, and extraCardFingerprint is armed against both', () => {
    const [vc] = STATES.find((s) => s.name === 'v2-frost').checks.filter((c) => c.family === 'visual-census' && isArmed(c))
    expect(vc.maxFingerprints).toBeUndefined()
    expect(Object.keys(vc.surfaces)).toEqual(['glance card + row card (one material)', 'jump bar', 'section band'])
    expect(new Set(Object.values(vc.surfaces)).size).toBe(3)
    for (const s of STATES) expect(s.checks.filter((c) => c.family === 'card-nesting' && isArmed(c)), s.name).toHaveLength(1)
    const m = MUTANTS_V2.extraCardFingerprint
    expect(isArmed(m)).toBe(true)
    expect(m.killers).toEqual(['visual-census', 'card-nesting'])
    for (const k of m.killers) expect(KILLER_FAMILIES).toContain(k)
  })
  // OPS-TODAYV2GATECOVERAGE-001: the flows driven by trusted taps. Pinned so none can quietly drop out of the armed
  // set, and so a flow known to be open (Feed all's Undo, Protect's leave-then-Back line) is not armed by accident.
  it('arms the six trusted-taps flows, and each of their mutants names its killers', () => {
    const flows = (name) => STATES.find((s) => s.name === name).checks.filter((c) => c.family === 'trusted-taps' && isArmed(c)).map((c) => c.flow)
    expect(flows('v2-busy')).toEqual(['away-back', 'close-reopen', 'row-tap', 'two-spots', 'feed-all'])
    expect(flows('v2-freeze')).toEqual(['cover-all'])
    expect(STATES.flatMap((s) => s.checks).filter((c) => c.family === 'trusted-taps')).toHaveLength(6)
    const taps = Object.entries(MUTANTS_V2).filter(([n]) => n.startsWith('taps'))
    expect(taps.map(([n]) => n)).toEqual(['tapsParkedRunNotTaken', 'tapsRunNotParked', 'tapsRowDoneNotRecorded', 'tapsSecondRunReplacesFirst', 'tapsBulkResultUnsaid', 'tapsPostsTwice', 'tapsCoverNoDoneLine'])
    for (const [n, m] of taps) {
      expect(isArmed(m), n).toBe(true)
      for (const k of m.killers) expect(KILLER_FAMILIES, n).toContain(k)
      expect(m.killers.some((k) => k === 'trusted-taps' || k === 'post-once'), n).toBe(true)
      // One killer is allowed only with its reason written down.
      if (new Set(m.killers).size < 2) expect(m.oneKiller, n).toBeTruthy()
    }
  })
  it('every armed real-Chrome mutant\'s pattern occurs exactly once in its file', () => {
    const root = join(HERE, '..', '..', '..')
    const armed = Object.entries(MUTANTS_V2).filter(([, m]) => m.kind === 'chrome' && isArmed(m))
    expect(armed.length).toBeGreaterThan(40)
    for (const [n, m] of armed) {
      expect(m.file && m.find, n).toBeTruthy()
      expect(readFileSync(join(root, m.file), 'utf8').split(m.find).length - 1, `${n} → ${m.file}`).toBe(1)
    }
  })
})

describe('v2 grafts and the re-dating helper', () => {
  it('re-dates plan_date and moves generated_at by whole days', () => {
    const p = redatePayload({ plan_date: '2026-10-01', generated_at: '2026-10-01T14:00:25.318Z' }, '2026-10-08')
    expect(p).toEqual({ plan_date: '2026-10-08', generated_at: '2026-10-08T14:00:25.318Z' })
    expect(() => redatePayload({ plan_date: '2026-10-01' }, '10/08')).toThrow()
  })
  it('routine moves exactly the 8 tray cells to fabric_bag and nothing else', () => {
    const { plants } = applyGrafts(D, PLANTS, ['routine'], G)
    const moved = plants.filter((p, i) => p.container_type !== PLANTS[i].container_type)
    expect(moved).toHaveLength(8)
    expect(new Set(moved.map((p) => p.container_type))).toEqual(new Set(['fabric_bag']))
  })
  it('never moves one real row to no_history with the engine never-arm shape', () => {
    const { payload } = applyGrafts(D, PLANTS, ['routine', 'never'], G)
    expect(payload.plan.water_due).toHaveLength(D.plan.water_due.length - 1)
    expect(payload.plan.no_history).toEqual([expect.objectContaining({ never: true, days_since: null, overdue_by: null })])
  })
  it('bedwait (SF4) leaves Outside Water all at 137, the two carve-out beds still listed and in it', () => {
    const { payload } = applyGrafts(D, PLANTS, ['bedwait'], G)
    const beds = payload.plan.water_due.filter((r) => r.in_ground)
    expect(beds).toHaveLength(2)
    expect(payload.plan.rain_skipped).toHaveLength(17)
    expect(payload.plan.hydrology).toMatchObject({ tomorrow_precip_in: 0.62, tomorrow_pop: 70 })
    const g = groupsOfRows(payload.plan.water_due, PLANTS, read('locations.full.json'))
    expect(g.Outside).toBe(137)
    expect(G.bedwait.expect.outside_water_all_after).toBe(137)
  })
  // BUG-RAINTOMORROWMISLABEL-001 (b): the one state with its own weather, held to v2-frost's own numbers.
  it('gaugerain moves the two measured-rain fields and nothing else, and v2-frost-rain carries v2-frost\'s ceilings', () => {
    const { payload } = applyGrafts(D, PLANTS, ['gaugerain'], G)
    expect(payload.plan.hydrology).toEqual({ ...D.plan.hydrology, today_observed_in: 0.45, today_remaining_in: 0 })
    expect({ ...payload.plan, hydrology: null }).toEqual({ ...D.plan, hydrology: null })
    expect(STATES.filter((x) => x.wx).map((x) => x.name)).toEqual(['v2-frost-rain'])
    const rain = STATES.find((x) => x.name === 'v2-frost-rain')
    const cols = Object.values(rain.wx.models)
    expect(cols).toHaveLength(5)
    expect(Math.round(cols.reduce((a, c) => a + c[1], 0) / 5 * 100) / 100).toBe(0.4)      // D1 mean: over the 0.30″ bar
    expect(cols.filter((c) => c[1] >= 0.01).length * 20).toBe(80)                          // D1 chance: over 50%
    expect(rain.checks.filter((c) => c.family === 'glance-rain' && isArmed(c))).toHaveLength(1)
    expect(rain.checks.some((c) => c.headerTopMax?.care === 'FIRST_SCREEN+72')).toBe(true)
    const B = read('today-shape-budget.v2.json').states
    for (const k of ['clock', 'contentBottomFloor', 'contentBottomCeiling', 'controlsFloor', 'scrollHeightCeiling']) expect(B['v2-frost-rain'][k], k).toBe(B['v2-frost'][k])
    expect(STATES).toHaveLength(21)
    expect(STATES.reduce((a, x) => a + x.checks.filter((c) => isArmed(c)).length, 0)).toBe(265)
  })
  it('stale serves the plan one day back', () => {
    expect(applyGrafts(D, PLANTS, ['stale'], G).payload.plan_date).toBe('2026-09-23')
  })
  it('seeds the flag always, and first-seen for every served cold card', () => {
    const s = STATES.find((x) => x.name === 'v2-busy-seen')
    const seeds = Object.fromEntries(localSeeds(s, D, 'harness_user'))
    expect(seeds['garden.todayV2']).toBe('1')
    expect(Object.keys(JSON.parse(seeds['today-seen:harness_user']).chill)).toHaveLength(D.plan.cold.length)
  })
  it('resolves interaction targets to the contract anchors, and refuses an unknown one', () => {
    expect(selectorFor('jump:water')).toBe('[data-testid="today-jumpbar"] [data-chip="water"]')
    expect(selectorFor('today-sec-care', '-X')).toBe('[data-testid="today-sec-care-X"] [aria-expanded]')
    expect(() => selectorFor('bogus:thing')).toThrow()
  })
  // Integration S3 × S4: v2-frost's chip step flips the Water task filter's pre-select (aria-pressed), since Needs
  // care is already open there and a flip of today-sec-care could never happen (the step VOIDed as first written).
  it('reads a task-filter flip as aria-pressed and every other flip as aria-expanded', () => {
    document.body.innerHTML = '<div data-testid="care-filter-tasks"><button aria-pressed="false">Water</button><button aria-pressed="true">Feed</button></div>'
      + '<section data-testid="today-sec-care"><button aria-expanded="true">Needs care</button></section>'
    expect(flipState('task-filter:Water')).toBe('false')
    expect(flipState('task-filter:Feed')).toBe('true')
    expect(flipState('task-filter:Check')).toBeNull()
    expect(flipState('today-sec-care')).toBe('true')
    expect(flipAttr('task-filter:Water')).toBe('aria-pressed')
    expect(flipAttr('spot:Bag Area')).toBe('aria-expanded')
    expect(() => flipState('bogus:thing')).toThrow()
    document.body.innerHTML = ''
    const frost = STATES.find((x) => x.name === 'v2-frost').checks.filter((c) => c.family === 'interaction')
    expect(frost).toHaveLength(1)
    expect(frost[0].armedAt).toEqual(['S3', 'S4'])
    expect(frost[0].steps[0]).toEqual({ tap: 'jump:water', flip: 'task-filter:Water' })
  })
})

describe('SF5 — the locations dump groups into exactly Outside / Stable / House', () => {
  it('over every busy care row', () => {
    const p = D.plan
    const g = groupsOfRows([...p.water_due, ...p.fertilize, ...p.pest], PLANTS, read('locations.full.json'))
    expect(Object.keys(g).sort()).toEqual([...EXPECTED_GROUPS].sort())
    expect(g).toEqual({ Outside: 216, Stable: 15, House: 2 })
  })
})
