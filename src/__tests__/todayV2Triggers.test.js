// V5-TODAYREDESIGN-001 S5 — what opens a section of the redesigned Today by itself (src/lib/todayV2/triggers.js),
// and the chill first-seen memory it reads (src/components/today/v2/todaySeen.js). Plan-v2 §3, Dave's D5, §13 MF1.
//
// §13 Simplify 3: the trigger-predicate mutants (ignoreRemembered, rememberedBeatsUrgent, staleAutoOpens,
// chillOpensEveryNight, headsupAlwaysOpen, householdAlwaysOpen, glanceOpenByDefault) are CELLS of the contract's
// table (today-v2-contract.mjs TRIGGER_CELLS), driven here through the ONE evaluation the page runs at its ready
// point (openAtStart) — every cell, every section. The Protect cells of plan §8 S5 follow on ENGINE-SHAPED plans
// (helpers/twoLowsFixtures.js: the real engine's coldFor and computeCallout), then the parity pins (hard freeze,
// the threshold clause), the first-seen store, and the storage-window boundaries on the real dataset.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  openAtStart, reopens, careTrigger, careOpens, protectTier, protectTrigger, protectThreshold, tonightLowRaw,
  frostNamesTonight, headsupTrigger, headsupReasons, firstNight, id8, HARD_FREEZE_LOW_F, TIER_RANK,
  TRIGGER_SECTIONS, CARE_REASONS, HEADSUP_REASONS,
} from '../lib/todayV2/triggers.js'
import { seenKey, seasonOf, readSeen, markSeen, SEEN_PREFIX } from '../components/today/v2/todaySeen.js'
import { storageDeadlineGroups } from '../components/today/StorageDeadlineAlert.jsx'
import { agreedTonightLow } from '../lib/tonightLow.js'
import { withoutLowClause } from '../lib/tonightLow.js'
import { CLIENT_PREF_KEY_PREFIXES } from '../lib/clientPrefs.js'
import { TRIGGER_CELLS } from '../../tests/harness/_todaymeasure/today-v2-contract.mjs'
import { planFor, tonight, tomorrowNight, imminent } from './helpers/twoLowsFixtures.js'
import frostClass from '../../lambda/daily-plan/frostClass.js'

const TODAY = '2026-09-24'
const YESTERDAY = '2026-09-23'
const sweet = { id: 'p-sp1', name: 'Sweet Potatoes', status: 'vegetative', variety_ref: { id: 'v1', crop_type_slug: 'sweet_potato' } }

// ── the contract's table, through the one evaluation ──────────────────────────────────────────────────────
function cellInputs(cell) {
  const p = cell.plan || {}
  const levels = p.coldLevels || []
  const rows = levels.map((level, i) => ({ plantingId: `c0ffee0${i}-aaaa-bbbb`, level }))
  const seenDay = cell.seen === 'yesterday' ? YESTERDAY : cell.seen === 'today' ? TODAY : null
  const seen = seenDay ? Object.fromEntries(rows.map((r) => [id8(r.plantingId), seenDay])) : {}
  const stale = !!p.stale
  const triggers = {
    protect: protectTrigger({ rows, lowRaw: p.lowRaw ?? null, frostTonight: !!p.frostTonight, seen, planDate: TODAY, stale }),
    care: careTrigger({ never: p.never ? ['n'] : [], hot: !!(p.hot && p.containerDue), small: p.small ? ['s'] : [] }, { stale }),
  }
  const present = ['protect', 'care', 'resting']
  if (cell.storage) {
    const groups = storageDeadlineGroups([sweet], cell.storage.today)
    // The cell's window is the dataset's: a moved date in storageDeadlines.json reds here, not quietly in the cell.
    expect(groups[0]).toMatchObject({ checkFromISO: cell.storage.checkFrom, deadlineISO: cell.storage.deadline })
    triggers.headsup = headsupTrigger(groups, cell.storage.today)
    present.push('headsup')
  }
  // Keys no trigger may open, handed a descriptor anyway: the evaluation must refuse them by construction.
  if (cell.household) { present.push('hh-member_j'); triggers['hh-member_j'] = { r: 'small' } }
  if (cell.expectOpenExcludes?.includes('glance')) { present.push('glance'); triggers.glance = { t: 'frost' } }
  const entries = {}
  if (cell.ack) entries[cell.ack.section] = { open: false, at: cell.ack.at === 'today' ? TODAY : YESTERDAY, ack: cell.ack.t ? { t: cell.ack.t } : { r: cell.ack.r } }
  return { present, triggers, resolve: (k) => entries[k] || null, planDate: TODAY }
}

describe('TRIGGER_CELLS (today-v2-contract.mjs) through openAtStart', () => {
  it('the table covers every section a trigger can open, and the two that never open', () => {
    expect(TRIGGER_CELLS.length).toBe(18)
    const covered = new Set(TRIGGER_CELLS.flatMap((c) => c.expectOpen || []))
    for (const k of TRIGGER_SECTIONS) expect(covered.has(k)).toBe(true)
  })
  for (const cell of TRIGGER_CELLS) {
    it(`${cell.cell}  [kills ${cell.killedMutant}]`, () => {
      const { overlay, triggers } = openAtStart(cellInputs(cell))
      const opened = Object.keys(overlay).sort()
      if (cell.expectOpen) expect(opened).toEqual([...cell.expectOpen].sort())
      for (const pat of cell.expectOpenExcludes || []) {
        const re = new RegExp('^' + pat.replace('*', '.*') + '$')
        expect(opened.filter((k) => re.test(k))).toEqual([])
      }
      // Every section opened carries the descriptor a close would record as its ack.
      for (const k of opened) expect(triggers[k]).toBeTruthy()
    })
  }
})

// ── MF1: the one ack rule ─────────────────────────────────────────────────────────────────────────────────
describe('reopens — date-scoped acks, escalation only (MF1)', () => {
  const close = (at, ack) => ({ open: false, at, ack })
  it('no ack, an ack dated another day, or an open entry holds nothing', () => {
    expect(reopens({ t: 'chill' }, null, TODAY)).toBe(true)
    expect(reopens({ t: 'chill' }, { open: false, at: TODAY }, TODAY)).toBe(true)
    expect(reopens({ t: 'chill' }, close(YESTERDAY, { t: 'hardfreeze' }), TODAY)).toBe(true)
    expect(reopens({ t: 'chill' }, { open: true, at: TODAY }, TODAY)).toBe(true)
  })
  it('a same-day close holds until the tier rises: chill → frost → hardfreeze each re-open, equal or lower hold', () => {
    expect(reopens({ t: 'chill' }, close(TODAY, { t: 'chill' }), TODAY)).toBe(false)
    expect(reopens({ t: 'frost' }, close(TODAY, { t: 'chill' }), TODAY)).toBe(true)
    expect(reopens({ t: 'hardfreeze' }, close(TODAY, { t: 'frost' }), TODAY)).toBe(true)
    expect(reopens({ t: 'frost' }, close(TODAY, { t: 'hardfreeze' }), TODAY)).toBe(false)
    expect(reopens({ t: 'frost' }, close(TODAY, { t: 'frost' }), TODAY)).toBe(false)
    expect(Object.entries(TIER_RANK).sort((a, b) => a[1] - b[1]).map(([t]) => t)).toEqual(['chill', 'frost', 'hardfreeze'])
  })
  it('a same-day close holds until a NEW reason type: one string or a list, on either side', () => {
    expect(reopens({ r: 'window' }, close(TODAY, { r: 'window' }), TODAY)).toBe(false)
    expect(reopens({ r: 'deadline' }, close(TODAY, { r: 'window' }), TODAY)).toBe(true)
    expect(reopens({ r: ['window', 'deadline'] }, close(TODAY, { r: ['deadline', 'window'] }), TODAY)).toBe(false)
    expect(reopens({ r: 'small' }, close(TODAY, { t: 'chill' }), TODAY)).toBe(true)
    expect(reopens(null, close(TODAY, { r: 'small' }), TODAY)).toBe(false)
  })
  it("careOpens is S4's name for the same rule", () => {
    for (const [t, e] of [[{ r: 'small' }, close(TODAY, { r: 'small' })], [{ r: ['never', 'small'] }, close(TODAY, { r: 'small' })], [{ r: 'hot' }, null]]) {
      expect(careOpens(t, e, TODAY)).toBe(reopens(t, e, TODAY))
    }
  })
  it('the vocabularies S7\'s validator must accept', () => {
    expect(Object.keys(TIER_RANK)).toEqual(['chill', 'frost', 'hardfreeze'])
    expect(CARE_REASONS).toEqual(['never', 'hot', 'small'])
    expect(HEADSUP_REASONS).toEqual(['window', 'deadline'])
  })
  it('openAtStart never opens a section that is not on the page, and keeps the fixed order', () => {
    const t = { protect: { t: 'frost' }, headsup: { r: 'window' }, care: { r: 'small' } }
    expect(openAtStart({ present: ['care'], triggers: t, resolve: () => null, planDate: TODAY }).overlay).toEqual({ care: 'open' })
    expect(Object.keys(openAtStart({ present: ['care', 'headsup', 'protect'], triggers: t, resolve: () => null, planDate: TODAY }).overlay)).toEqual(['protect', 'headsup', 'care'])
  })
})

// ── Protect tonight, on engine-shaped plans (plan §8 S5's Protect cells) ─────────────────────────────────────
// planFor(low, entries): the real engine's cold bucket at that low — a flowering pepper (bring_in < 40, optional
// 40–44) and a Fittonia with a 60°F profile (protect ≤ 60) — and its callout.
const rowsOf = (plan) => (plan.cold || []).map((c) => ({ plantingId: c.id, level: c.level, text: c.text }))
function protectOf(plan, { seen = {}, planDate = '2026-10-09', stale = false } = {}) {
  const agreed = agreedTonightLow(plan)
  const rows = rowsOf(plan)
  const lowRaw = tonightLowRaw(plan, agreed)
  const frostTonight = frostNamesTonight(plan)
  return { tier: rows.length ? protectTier({ lowRaw, frostTonight, levels: rows.map((r) => r.level) }) : null, trigger: protectTrigger({ rows, lowRaw, frostTonight, seen, planDate, stale }) }
}

describe('Protect tonight — tiers on engine-shaped plans', () => {
  it('cold > 0 with a frost line naming tonight: frost, even at a 42°F plan low', () => {
    const plan = planFor(42, [tonight(41)])
    expect(frostNamesTonight(plan)).toBe(true)
    expect(protectOf(plan)).toEqual({ tier: 'frost', trigger: { t: 'frost' } })
  })
  it('cold > 0 without an alert: 50°F and 42°F are chill (the Fittonia protect card; at 42°F the pepper is only optional)', () => {
    expect(protectOf(planFor(50))).toEqual({ tier: 'chill', trigger: { t: 'chill' } })
    const p42 = planFor(42)
    expect(rowsOf(p42).map((r) => r.level).sort()).toEqual(['optional', 'protect'])
    expect(protectOf(p42).tier).toBe('chill')
  })
  it('under 40°F: the engine writes bring_in, the tier is frost; at ≤ 33°F hardfreeze', () => {
    expect(rowsOf(planFor(38)).map((r) => r.level).sort()).toEqual(['bring_in', 'protect'])
    expect(protectOf(planFor(38)).tier).toBe('frost')
    expect(protectOf(planFor(33)).tier).toBe('hardfreeze')
    expect(protectOf(planFor(34)).tier).toBe('frost')
  })
  it('optional cards alone never open (a flowering pepper at 42°F, the Fittonia already inside)', () => {
    const plan = { ...planFor(42), cold: planFor(42).cold.filter((c) => c.level === 'optional') }
    expect(protectOf(plan)).toEqual({ tier: null, trigger: null })
  })
  it('cold = 0 with an alert: no Protect, nothing to open', () => {
    const plan = { ...planFor(62, [tonight(38)]), cold: [] }
    expect(frostNamesTonight(plan)).toBe(true)
    expect(protectOf(plan)).toEqual({ tier: null, trigger: null })
  })
  it('a THRESHOLD imminent send names nothing (the freeze cue has tonight), so a 45°F Fittonia night stays chill', () => {
    const plan = planFor(45, [imminent(45)])
    expect(frostNamesTonight(plan)).toBe(false)
    expect(protectOf(plan).tier).toBe('chill')
  })
  it('a rehearsal (run "forced") names nothing', () => {
    const plan = planFor(45, [{ ...imminent(41), trip: 'radiative', run: 'forced' }, tonight(38, { run: 'forced' })])
    expect(frostNamesTonight(plan)).toBe(false)
    expect(protectOf(plan).tier).toBe('chill')
  })
  it('an advisory for TOMORROW night (nightOffset 1) does not make tonight a frost night', () => {
    const plan = planFor(45, [tomorrowNight(36)])
    expect(frostNamesTonight(plan)).toBe(false)
    expect(protectOf(plan).tier).toBe('chill')
  })
  it('the low is the ONE low Today prints: a frost line naming tonight at 32°F under a 45°F plan low is a hard freeze', () => {
    const plan = planFor(45, [tonight(32)])
    expect(agreedTonightLow(plan).lowRaw).toBe(32)
    expect(protectOf(plan).tier).toBe('hardfreeze')
  })
  it('escalation chill → frost → hardfreeze re-opens the same day; a subset (or a superset) at the same tier does not', () => {
    const planDate = '2026-10-09'
    const ack = (t) => ({ open: false, at: planDate, ack: { t } })
    const at50 = protectOf(planFor(50), { planDate }).trigger
    const at38 = protectOf(planFor(38), { planDate }).trigger
    const at31 = protectOf(planFor(31), { planDate }).trigger
    expect(reopens(at38, ack(at50.t), planDate)).toBe(true)
    expect(reopens(at31, ack(at38.t), planDate)).toBe(true)
    // Same tier, fewer plants (one brought in) — MF1 keys on the tier, not the plant set.
    const fewer = { ...planFor(38), cold: planFor(38).cold.slice(0, 1) }
    expect(reopens(protectOf(fewer, { planDate }).trigger, ack('frost'), planDate)).toBe(false)
    expect(reopens(protectOf(planFor(38), { planDate }).trigger, ack('frost'), planDate)).toBe(false)
  })
  it('chill opens only on a protect planting\'s first night on THIS device; frost ignores first-seen', () => {
    const planDate = '2026-10-09'
    const fit = planFor(50).cold.find((c) => c.level === 'protect')
    const seenYesterday = { [id8(fit.id)]: '2026-10-08' }
    expect(protectOf(planFor(50), { planDate, seen: {} }).trigger).toEqual({ t: 'chill' })
    expect(protectOf(planFor(50), { planDate, seen: { [id8(fit.id)]: planDate } }).trigger).toEqual({ t: 'chill' })
    expect(protectOf(planFor(50), { planDate, seen: seenYesterday }).trigger).toBeNull()
    expect(protectOf(planFor(50), { planDate, seen: seenYesterday }).tier).toBe('chill')
    expect(protectOf(planFor(38), { planDate, seen: seenYesterday }).trigger).toEqual({ t: 'frost' })
  })
  it('a stale plan opens nothing, at any tier', () => {
    for (const low of [50, 38, 30]) expect(protectOf(planFor(low), { stale: true }).trigger).toBeNull()
  })
})

// ── parity pins ─────────────────────────────────────────────────────────────────────────────────────────────
describe('parity with the Lambda the thresholds come from', () => {
  it('HARD_FREEZE_LOW_F is frostClass.js\'s tender / tropical / chill-sensitive default (read from the source)', () => {
    const src = readFileSync(resolve(process.cwd(), 'lambda/daily-plan/frostClass.js'), 'utf8')
    const defaults = [...src.matchAll(/numEnv\('FROST_HARD_FREEZE_LOW_F', (\d+)\)/g)].map((m) => Number(m[1]))
    expect(defaults.length).toBeGreaterThanOrEqual(3)
    expect(new Set(defaults)).toEqual(new Set([HARD_FREEZE_LOW_F]))
    if (process.env.FROST_HARD_FREEZE_LOW_F == null) expect(frostClass.BAND_THRESHOLDS.tender.HARD_FREEZE_LOW_F).toBe(HARD_FREEZE_LOW_F)
  })
  it('the threshold clause is parsed from the REAL engine\'s protect card, and is the clause withoutLowClause drops', () => {
    const fit = planFor(50).cold.find((c) => c.level === 'protect')
    expect(fit.text).toMatch(/\(low 50°F ≤ 60°F\)$/)
    expect(protectThreshold(fit.text)).toBe(60)
    expect(protectThreshold(withoutLowClause(fit.text))).toBeNull()
    const pepper38 = planFor(38).cold.find((c) => c.level === 'bring_in')
    const pepper42 = planFor(42).cold.find((c) => c.level === 'optional')
    expect(protectThreshold(pepper38.text)).toBeNull()
    expect(protectThreshold(pepper42.text)).toBeNull()
    expect(protectThreshold(null)).toBeNull()
  })
})

// ── the first-seen store (device-local) ─────────────────────────────────────────────────────────────────────
describe('today-seen — the chill first-seen memory', () => {
  beforeEach(() => { localStorage.clear() })
  it('keys by user, and its prefix is cleared at sign-out', () => {
    expect(seenKey('u 1')).toBe('today-seen:u%201')
    expect(seenKey(null)).toBeNull()
    expect(SEEN_PREFIX).toBe('today-seen:')
    expect(CLIENT_PREF_KEY_PREFIXES).toContain(SEEN_PREFIX)
  })
  it('marks a planting on its first plan day and never moves the mark', () => {
    const k = seenKey('u')
    expect(markSeen(k, '2026-09-24', ['edfc68f5-a28a', 'dc196337-453b'])).toBe(true)
    expect(readSeen(k, '2026-09-24')).toEqual({ edfc68f5: '2026-09-24', dc196337: '2026-09-24' })
    expect(markSeen(k, '2026-09-25', ['edfc68f5-a28a', '0b61a444-bbf8'])).toBe(true)
    expect(readSeen(k, '2026-09-25')).toEqual({ edfc68f5: '2026-09-24', dc196337: '2026-09-24', '0b61a444': '2026-09-25' })
    expect(markSeen(k, '2026-09-26', ['edfc68f5-a28a'])).toBe(false)
    expect(firstNight(readSeen(k, '2026-09-25'), 'edfc68f5-a28a', '2026-09-25')).toBe(false)
    expect(firstNight(readSeen(k, '2026-09-25'), '0b61a444-bbf8', '2026-09-25')).toBe(true)
  })
  it('a new season starts a fresh map (autumn Jul–Dec, spring Jan–Jun)', () => {
    expect(seasonOf('2026-09-24')).toBe('2026-autumn')
    expect(seasonOf('2027-04-02')).toBe('2027-spring')
    expect(seasonOf('nope')).toBeNull()
    const k = seenKey('u')
    markSeen(k, '2026-10-01', ['edfc68f5'])
    expect(readSeen(k, '2027-05-01')).toEqual({})
  })
  it('reads the shape the gate seeds (v2wire.js localSeeds), and unreadable storage reads as never seen', () => {
    localStorage.setItem('today-seen:harness_user', JSON.stringify({ season: '2026-autumn', chill: { edfc68f5: '2026-09-23' } }))
    expect(readSeen(seenKey('harness_user'), '2026-09-24')).toEqual({ edfc68f5: '2026-09-23' })
    localStorage.setItem('today-seen:u', '{nope')
    expect(readSeen(seenKey('u'), '2026-09-24')).toEqual({})
  })
  it('first seen per DEVICE: another device\'s store (a fresh one here) still opens', () => {
    const k = seenKey('u')
    markSeen(k, '2026-10-08', ['pl-fittonia'])
    const planDate = '2026-10-09'
    expect(protectOf(planFor(50), { planDate, seen: readSeen(k, planDate) }).trigger).toBeNull()
    localStorage.clear()
    expect(protectOf(planFor(50), { planDate, seen: readSeen(k, planDate) }).trigger).toEqual({ t: 'chill' })
  })
})

// ── Heads-up: the storage window's boundaries on the real dataset (sweet potato: window 09-28, deadline 10-10) ──
describe('Heads-up — opens on the window\'s first day and its last two days; shown, closed, through the grace', () => {
  const at = (day) => {
    const groups = storageDeadlineGroups([sweet], day)
    return { present: groups.length > 0, trigger: headsupTrigger(groups, day), phase: groups[0]?.phase ?? null }
  }
  it('09-27 nothing · 09-28 opens (window) · 10-07 present, closed', () => {
    expect(at('2026-09-27')).toEqual({ present: false, trigger: null, phase: null })
    expect(at('2026-09-28')).toEqual({ present: true, trigger: { r: 'window' }, phase: 'check' })
    for (const d of ['2026-09-29', '2026-10-01', '2026-10-07']) expect(at(d)).toEqual({ present: true, trigger: null, phase: 'check' })
  })
  it('10-08, 10-09, 10-10 open (deadline)', () => {
    for (const d of ['2026-10-08', '2026-10-09', '2026-10-10']) expect(at(d)).toEqual({ present: true, trigger: { r: 'deadline' }, phase: 'check' })
  })
  it('10-11 … 10-24 present in the past phase, never opened · 10-25 gone', () => {
    for (const d of ['2026-10-11', '2026-10-17', '2026-10-24']) expect(at(d)).toEqual({ present: true, trigger: null, phase: 'past' })
    expect(at('2026-10-25')).toEqual({ present: false, trigger: null, phase: null })
  })
  it('two groups firing different reasons record both (a close then holds against both)', () => {
    const g = [{ phase: 'check', checkFromISO: '2026-10-08', daysUntil: 12 }, { phase: 'check', checkFromISO: '2026-09-28', daysUntil: 2 }]
    expect(headsupReasons(g, '2026-10-08')).toEqual(['window', 'deadline'])
    expect(headsupTrigger(g, '2026-10-08')).toEqual({ r: ['window', 'deadline'] })
    expect(headsupTrigger([], '2026-10-08')).toBeNull()
  })
})
