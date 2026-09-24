// V5-SEEDSTAB-001 — the shared seed-lot vocabulary (src/components/seed/seedLots.js), and the two fixes
// that landed with the move out of SavedSeeds.jsx:
//   · BUG-SEEDSOWRELDAY-001 — "today" is a CALENDAR date in Eastern, not "less than 24 hours ago";
//   · the vendor is the source-registry name, never the free-text `source` (an order reference).
import { describe, it, expect } from 'vitest'
import {
  elapsedDays, elapsedLabel, fermentUrgency, dueFerments, hasLotInProcess, isSavedLot,
  candidateFacts, labelCandidates, seedCountLabel, lotMeasure,
  FERMENT_WARN_DAYS, FERMENT_ALARM_DAYS, isF2Lot, F2_LABEL,
} from '../components/seed/seedLots.js'

// 08:00 Eastern on 18 Sep 2026 (EDT, UTC-4).
const NOW = new Date('2026-09-18T12:00:00Z')

describe('elapsedDays — calendar days in Eastern (BUG-SEEDSOWRELDAY-001)', () => {
  it('a lot entered last night reads 1 the next morning, though fewer than 24 hours have passed', () => {
    // 21:00 Eastern the evening before = 01:00Z on the 18th: eleven hours ago, and a different DATE.
    expect(elapsedDays('2026-09-18T01:00:00Z', NOW)).toBe(1)
    expect(elapsedLabel('2026-09-18T01:00:00Z', NOW)).toBe('1 day')
    // The rolling-window answer it replaces would have been 0, i.e. "today" — the reported defect.
    expect(Math.floor((NOW - new Date('2026-09-18T01:00:00Z')) / 86400000)).toBe(0)
  })

  it('earlier the same Eastern day is 0 ("today"), even across the UTC midnight', () => {
    // 00:30Z on the 18th is 20:30 Eastern on the 17th — so from 23:30 Eastern on the 17th it is today.
    const lateEvening = new Date('2026-09-18T03:30:00Z')
    expect(elapsedDays('2026-09-18T00:30:00Z', lateEvening)).toBe(0)
    expect(elapsedLabel('2026-09-18T00:30:00Z', lateEvening)).toBe('today')
  })

  it('counts whole calendar days, reads a bare date as that date, and nulls junk', () => {
    expect(elapsedDays('2026-09-13', NOW)).toBe(5)
    expect(elapsedLabel('2026-09-13', NOW)).toBe('5 days')
    expect(elapsedDays(null, NOW)).toBeNull()
    expect(elapsedDays('not a date', NOW)).toBeNull()
    expect(elapsedLabel('', NOW)).toBeNull()
  })
})

describe('fermentUrgency / dueFerments', () => {
  const ferm = (iso, over = {}) => ({ id: iso, seed_stage: 'fermenting', stage_entered_at: iso, ...over })
  it('warns on calendar day 4 and alarms on day 5, fermenting only', () => {
    expect(FERMENT_WARN_DAYS).toBe(4)
    expect(FERMENT_ALARM_DAYS).toBe(5)
    expect(fermentUrgency(ferm('2026-09-15'), NOW)).toBeNull()      // day 3
    expect(fermentUrgency(ferm('2026-09-14'), NOW)).toBe('warn')    // day 4
    expect(fermentUrgency(ferm('2026-09-13'), NOW)).toBe('alarm')   // day 5
    expect(fermentUrgency({ seed_stage: 'drying', stage_entered_at: '2026-08-01' }, NOW)).toBeNull()
    expect(fermentUrgency(ferm(null), NOW)).toBeNull()
  })

  it('lists the due ferments most overdue first, and nothing else', () => {
    const due = dueFerments([
      ferm('2026-09-14'), ferm('2026-09-10'), ferm('2026-09-17'),
      { id: 'dry', seed_stage: 'drying', stage_entered_at: '2026-08-01' },
    ], NOW)
    expect(due.map((d) => d.item.id)).toEqual(['2026-09-10', '2026-09-14'])
    expect(due.map((d) => d.level)).toEqual(['alarm', 'warn'])
    expect(dueFerments(null, NOW)).toEqual([])
  })
})

describe('hasLotInProcess — the Seeds default-view rule', () => {
  it('is true for any fermenting or drying lot, whatever its status, and false otherwise', () => {
    expect(hasLotInProcess([{ seed_stage: 'fermenting' }])).toBe(true)
    expect(hasLotInProcess([{ seed_stage: ' Drying ' }])).toBe(true)
    expect(hasLotInProcess([{ seed_stage: 'drying', status: 'retired' }])).toBe(true)
    expect(hasLotInProcess([{ seed_stage: 'stored' }, { seed_stage: null }])).toBe(false)
    expect(hasLotInProcess([])).toBe(false)
    expect(hasLotInProcess(null)).toBe(false)
  })
})

describe('isSavedLot — own seed vs a bought packet', () => {
  it('any of: a parent plant, a recorded origin kind, a stage', () => {
    expect(isSavedLot({ source_plant_id: 'p1' })).toBe(true)
    expect(isSavedLot({ source_kind: 'farm_stand' })).toBe(true)
    expect(isSavedLot({ seed_stage: 'stored' })).toBe(true)
    expect(isSavedLot({ source_id: 'src-fedco', source: 'Order #1' })).toBe(false)
    expect(isSavedLot({ source_plant_id: '', source_kind: '', seed_stage: '' })).toBe(false)
    expect(isSavedLot(null)).toBe(false)
  })
})

// V5-SEEDSTAB-001 slice 3 (design §2 rule 8, §5.4) — the one F2 predicate and the one label.
describe('isF2Lot / F2_LABEL — seed saved off an F1 plant', () => {
  it('a SAVED lot of an F1 cultivar is F2, by each of the three facts that make a lot saved', () => {
    expect(isF2Lot({ source_plant_id: 'p1', breeding_system: 'f1' })).toBe(true)
    expect(isF2Lot({ source_kind: 'farm_stand', breeding_system: 'f1' })).toBe(true)
    expect(isF2Lot({ seed_stage: 'drying', breeding_system: 'f1' })).toBe(true)
  })

  it('a BOUGHT F1 packet is never F2 — it sows true as the F1 (rule 8: no badge on bought packets)', () => {
    expect(isF2Lot({ source_id: 'src-johnny', breeding_system: 'f1' })).toBe(false)
    expect(isF2Lot({ source_plant_id: null, source_kind: null, seed_stage: null, breeding_system: 'f1' })).toBe(false)
  })

  it('only f1 speaks: open-pollinated, landrace, "unknown", NULL and an absent key say nothing', () => {
    for (const breeding_system of ['open_pollinated', 'landrace', 'unknown', null, undefined, 'F1', '']) {
      expect(isF2Lot({ source_plant_id: 'p1', breeding_system }), String(breeding_system)).toBe(false)
    }
    expect(isF2Lot({ source_plant_id: 'p1' })).toBe(false)
    expect(isF2Lot(null)).toBe(false)
  })

  it('the label names the consequence and never calls saving F2 seed a mistake', () => {
    expect(F2_LABEL).toBe('F2 — won’t come true')
    expect(F2_LABEL).not.toMatch(/mistake|wrong|bad|avoid|don.t save|shouldn.t/i)
  })
})

describe('candidateFacts — the vendor comes from the registry, never from `source`', () => {
  const row = { quantity_on_hand: 2, unit: 'packet', source_id: 'src-fedco', source: 'Order #4411 rec’d 7/2', purchase_date: '2026-01-14' }
  it('prints the resolved vendor and not the order reference', () => {
    const facts = candidateFacts(row, (i) => (i.source_id === 'src-fedco' ? 'Fedco' : ''))
    expect(facts).toContain('Fedco')
    expect(facts).toContain('2 packet')
    expect(facts).toContain('Jan 14, 2026')
    expect(facts).not.toContain('Order #4411')
  })
  it('with no resolver, or an unknown source, the vendor segment is simply absent', () => {
    expect(candidateFacts(row)).not.toContain('Order')
    expect(candidateFacts(row, () => '')).toBe('2 packet · Jan 14, 2026')
  })
})

describe('labelCandidates — uniqueness over whatever line the caller renders', () => {
  it('takes a facts function and a title function, and names identical groups', () => {
    const rows = [{ id: 'a', t: 'X', f: 'same' }, { id: 'b', t: 'X', f: 'same' }, { id: 'c', t: 'Y', f: 'other' }]
    const out = labelCandidates(rows, (r) => r.f, (r) => r.t)
    expect(out.map((r) => r.detail)).toEqual([
      'same · 1 of 2 with identical details', 'same · 2 of 2 with identical details', 'other',
    ])
    expect(new Set(out.map((r) => `${r.title}\n${r.detail}`)).size).toBe(3)
  })
})

describe('seedCountLabel / lotMeasure (unchanged by the move)', () => {
  it('keeps "approx." as a word, "1 seed" singular, and a measured 0', () => {
    expect(seedCountLabel(175, true)).toBe('approx. 175 seeds')
    expect(seedCountLabel(1, false)).toBe('1 seed')
    expect(seedCountLabel(0, false)).toBe('0 seeds')
    expect(seedCountLabel(null)).toBe('')
    expect(lotMeasure({ seed_count: null, seed_weight_g: null })).toBe('')
  })
})
