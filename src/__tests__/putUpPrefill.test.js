// V4-PUTUPENGINE-001 slice 2 — harvest -> Put-Up prefill mapping.
//
// The guards here are built to FAIL against the naive implementation (copy harvest_log.unit
// straight across), because that naive version is the one PutUp.jsx's UNIT_GROUPS comment warned
// about by name. Every "maps to X" case therefore asserts against a value that is NOT the input.
import { describe, it, expect } from 'vitest'
import {
  HARVEST_TO_PUTUP_UNIT,
  mapHarvestUnit,
  prefillFromHarvestEntry,
  harvestPickLabel,
  harvestPickAmount,
} from '../lib/putUpPrefill.js'
import { HARVEST_UNITS } from '../lib/harvest-constants.js'
import { UNIT_GROUPS } from '../pages/PutUp.jsx'

const PUTUP_UNITS = UNIT_GROUPS.flatMap(g => g.options)

// A harvest entry as lambda/harvests/aggregate.js projectEntry() actually emits it.
function entry(over = {}) {
  return {
    event_id: 'e1',
    day_key: '2026-08-21',
    plant_id: 'plant-1',
    planting_name: 'Sungold — wave 2',
    planting_removed: false,
    crop_type_slug: 'tomato',
    crop_name: 'Tomato',
    variety_id: 'var-1',
    variety_name: 'Sungold',
    quantity: '4',
    unit: 'cup',
    harvest_log_id: 'h-1',
    ...over,
  }
}

describe('mapHarvestUnit — the two vocabularies genuinely differ', () => {
  // THE anti-copy guard. 'cup' -> 'cups': input and expectation are different strings, so a
  // pass-through implementation fails here rather than sliding by.
  it('maps singular harvest units to the plural Put-Up spelling', () => {
    expect(mapHarvestUnit('cup')).toBe('cups')
    expect(mapHarvestUnit('cup')).not.toBe('cup')
    expect(mapHarvestUnit('lb')).toBe('lbs')
    expect(mapHarvestUnit('lb')).not.toBe('lb')
  })

  it('maps the count-like units that have no Put-Up noun onto count', () => {
    expect(mapHarvestUnit('head')).toBe('count')
    expect(mapHarvestUnit('bunch')).toBe('count')
  })

  it('passes through only where the two vocabularies genuinely agree', () => {
    expect(mapHarvestUnit('oz')).toBe('oz')
    expect(mapHarvestUnit('count')).toBe('count')
  })

  it('returns null for mass units that would need an arithmetic conversion', () => {
    // Not "unsupported" — REFUSED. Converting kg to lbs writes a computed guess into a column the
    // UI renders as a fact, which PutUp.jsx's Bulk-units comment rejects explicitly.
    expect(mapHarvestUnit('kg')).toBeNull()
    expect(mapHarvestUnit('g')).toBeNull()
  })

  it('is case- and whitespace-insensitive, and null-safe', () => {
    expect(mapHarvestUnit(' CUP ')).toBe('cups')
    expect(mapHarvestUnit(null)).toBeNull()
    expect(mapHarvestUnit(undefined)).toBeNull()
    expect(mapHarvestUnit('')).toBeNull()
    expect(mapHarvestUnit('furlong')).toBeNull()
  })
})

describe('the map is pinned to both real vocabularies, not to hand-copied lists', () => {
  it('every mapped VALUE is a selectable option in the live Put-Up pick-list', () => {
    // Reads PutUp.jsx's own UNIT_GROUPS. If someone edits that list and drops an option this map
    // targets, the prefill would silently select a non-existent <option> — this fails instead.
    for (const [from, to] of Object.entries(HARVEST_TO_PUTUP_UNIT)) {
      expect(PUTUP_UNITS, `${from} -> ${to} must be a real Put-Up unit`).toContain(to)
    }
  })

  it('every mapped KEY is a unit the harvest form can actually produce', () => {
    // Guards the other direction: a typo'd key would sit dead in the map forever, silently never
    // firing, and the "unmappable" branch would take rows it was never meant to take.
    for (const from of Object.keys(HARVEST_TO_PUTUP_UNIT)) {
      expect(HARVEST_UNITS, `${from} must be a real harvest unit`).toContain(from)
    }
  })

  it('covers every harvest unit that is mappable without arithmetic', () => {
    const unmapped = HARVEST_UNITS.filter(u => !(u in HARVEST_TO_PUTUP_UNIT))
    // Exactly the two mass units, and nothing else. A new harvest unit added upstream without a
    // decision here shows up as a failure rather than as silently-dropped quantities.
    expect(unmapped.sort()).toEqual(['g', 'kg'])
  })
})

describe('prefillFromHarvestEntry', () => {
  it('carries the four identity keys plus a mapped quantity pair', () => {
    expect(prefillFromHarvestEntry(entry())).toEqual({
      crop_type_slug: 'tomato',
      variety_id: 'var-1',
      plant_id: 'plant-1',
      harvest_log_id: 'h-1',
      quantity_value: 4,
      quantity_unit: 'cups', // mapped, NOT the entry's 'cup'
    })
  })

  it('drops the quantity PAIR when the unit cannot be mapped, keeping identity', () => {
    const out = prefillFromHarvestEntry(entry({ unit: 'kg', quantity: '2.5' }))
    expect(out.quantity_value).toBeUndefined()
    expect(out.quantity_unit).toBeUndefined()
    // Identity survives — the user still skips the crop/variety/planting pickers.
    expect(out.crop_type_slug).toBe('tomato')
    expect(out.plant_id).toBe('plant-1')
    expect(out.harvest_log_id).toBe('h-1')
  })

  it('drops the pair when quantity is missing, zero or unparseable', () => {
    // A quantity-less harvest event is a real row the read model deliberately renders.
    for (const q of [null, undefined, '', 0, '0', 'abc', -3]) {
      const out = prefillFromHarvestEntry(entry({ quantity: q }))
      expect(out.quantity_value, `quantity=${JSON.stringify(q)}`).toBeUndefined()
      expect(out.quantity_unit, `quantity=${JSON.stringify(q)}`).toBeUndefined()
    }
  })

  it('coerces the driver string to a number rather than passing the string through', () => {
    // numeric columns arrive from the neon driver as STRINGS; a string here would concatenate
    // downstream instead of adding.
    const out = prefillFromHarvestEntry(entry({ quantity: '4' }))
    expect(out.quantity_value).toBe(4)
    expect(out.quantity_value).not.toBe('4')
  })

  it('omits absent identity fields rather than writing nulls', () => {
    // prefillContextKey collapses falsy to '', but an explicit null key would still change the
    // object shape the draft stash snapshots.
    const out = prefillFromHarvestEntry(entry({ plant_id: null, variety_id: null, harvest_log_id: null }))
    expect('plant_id' in out).toBe(false)
    expect('variety_id' in out).toBe(false)
    expect('harvest_log_id' in out).toBe(false)
    expect(out.crop_type_slug).toBe('tomato')
  })

  it('keeps plant_id for a soft-deleted planting (Deleted-Planting History Rule)', () => {
    // The harvest genuinely happened in that container; retracting the planting record does not
    // retract the history, and its events stay live and visible.
    const out = prefillFromHarvestEntry(entry({ planting_removed: true }))
    expect(out.plant_id).toBe('plant-1')
  })

  it('carries a FRACTIONAL head/bunch through as a fractional count — known wart, pinned', () => {
    // Found by running these helpers over 12 real prod rows, not by reading code: prod contains
    // `0.2 head` (a fifth of a broccoli head), which maps to `0.2 count`. "0.2 count" reads oddly.
    //
    // Kept anyway, and the reason is the asymmetry that runs through this whole slice: the unit
    // lands in a VISIBLE, EDITABLE <select> on the form, so a user who dislikes it changes it in one
    // tap. That is categorically different from harvest_log_id, which has no control at all and is
    // why it alone gets guarded. Dropping the pair instead would cost the prefill on all 17 live
    // `head` rows to fix a label on a fraction of them.
    //
    // The NUMBER is what must not move, and this asserts it does not.
    const out = prefillFromHarvestEntry(entry({ unit: 'head', quantity: '0.2' }))
    expect(out.quantity_value).toBe(0.2)
    expect(out.quantity_unit).toBe('count')
  })

  it('returns an empty object for junk input', () => {
    expect(prefillFromHarvestEntry(null)).toEqual({})
    expect(prefillFromHarvestEntry(undefined)).toEqual({})
    expect(prefillFromHarvestEntry('nope')).toEqual({})
  })
})

describe('picker row rendering helpers', () => {
  it('prefers the planting name, which is the handle the user recognises', () => {
    expect(harvestPickLabel(entry())).toBe('Sungold — wave 2')
  })

  it('falls back through variety then crop for an unattributed row', () => {
    expect(harvestPickLabel(entry({ planting_name: null }))).toBe('Sungold')
    expect(harvestPickLabel(entry({ planting_name: null, variety_name: null }))).toBe('Tomato')
    expect(
      harvestPickLabel(entry({ planting_name: null, variety_name: null, crop_name: null })),
    ).toBe('tomato')
    expect(
      harvestPickLabel(
        entry({ planting_name: null, variety_name: null, crop_name: null, crop_type_slug: null }),
      ),
    ).toBe('Unattributed harvest')
  })

  it('shows the amount in the HARVEST vocabulary, not the mapped one', () => {
    // The picker must agree with the Harvests page the user is remembering. The mapped unit is a
    // write-time concern.
    expect(harvestPickAmount(entry())).toBe('4 cup')
    expect(harvestPickAmount(entry())).not.toBe('4 cups')
  })

  it('renders nothing for a quantity-less entry', () => {
    expect(harvestPickAmount(entry({ quantity: null }))).toBeNull()
  })
})
