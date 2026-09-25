// keyFact + formatBotanical unit tests (V200 Slice 5b). Pure helpers — no DOM, no jest-dom.
import { describe, it, expect } from 'vitest'
import { selectKeyFact, selectCropType, formatBotanical, cropFamilyGlyph } from '../lib/keyFact.js'

describe('selectKeyFact — priority cascade', () => {
  it('(1) pepper with an SHU value -> "{N} SHU" (formatted with separators)', () => {
    const pl = { variety_ref: { type: 'Pepper', name: 'Megatron' }, metadata: { shu: 30000 } }
    expect(selectKeyFact(pl)).toBe('30,000 SHU')
  })

  it('(1) pepper SHU via attr_override beats metadata', () => {
    const pl = { variety_ref: { type: 'pepper' }, metadata: { shu: 1000 }, attr_override: { shu: 50000 } }
    expect(selectKeyFact(pl)).toBe('50,000 SHU')
  })

  it('(1) pepper detected by name when no type/group field', () => {
    const pl = { name: 'Habanero Orange', variety_ref: { scoville: 200000 } }
    // name -> isPepper true; scoville read as SHU fallback.
    expect(selectKeyFact(pl)).toBe('200,000 SHU')
  })

  it('(1) pepper without any SHU falls through to the next applicable rule (DTM)', () => {
    const pl = { variety_ref: { type: 'Pepper', days_to_maturity_min: 70, days_to_maturity_max: 80 } }
    expect(selectKeyFact(pl)).toBe('70–80 days')
  })

  // A tomato is the cultivar's crop type (variety_ref.crop_type_slug), the field the plants Lambda sends.
  // These fixtures used a variety_ref.type the Lambda never sends, which is how rung 2 passed here while
  // reaching 2 of 46 live tomatoes.
  it('(2) tomato -> Indeterminate / Determinate from growth_habit', () => {
    expect(selectKeyFact({ variety_ref: { crop_type_slug: 'tomato' }, metadata: { growth_habit: 'indeterminate' } })).toBe('Indeterminate')
    expect(selectKeyFact({ variety_ref: { crop_type_slug: 'tomato' }, attr_override: { growth_habit: 'Determinate' } })).toBe('Determinate')
  })

  it('(2) tomato without growth_habit falls through to DTM', () => {
    const pl = { variety_ref: { crop_type_slug: 'tomato', days_to_maturity_min: 60, days_to_maturity_max: 60 } }
    expect(selectKeyFact(pl)).toBe('60 days')
  })

  // Prod rows: plantings are named by cultivar, so none of these names says "tomato". Until 2026-09-25
  // the tomato test read names, and these heroes showed their days (75–85, 65–75, 70–75) instead.
  it('(2) the crop type makes it a tomato, not the name: live cultivar-named tomatoes get their word', () => {
    const live = (name, growth_habit, dmin, dmax) => ({ name, variety_ref: { name, crop_type_slug: 'tomato',
      days_to_maturity_min: dmin, days_to_maturity_max: dmax, sun_requirements: 'full_sun', growth_habit } })
    expect(selectKeyFact(live('Cherokee Green', 'indeterminate vine; 6-8 ft; stake or cage required', 75, 85))).toBe('Indeterminate')
    expect(selectKeyFact(live('Cherry Falls', 'trailing/cascading determinate; 24-36 in spreading; bred for hanging baskets and containers; no staking required', 65, 75))).toBe('Determinate')
    expect(selectKeyFact(live('Celebrity', 'semi-determinate bush, 4-5 ft', 70, 75))).toBe('Semi-determinate')
  })

  it('(2) a tomato with no habit prose keeps its days, or has no pill', () => {
    expect(selectKeyFact({ name: 'Large Red Cherry', variety_ref: { name: 'Large Red Cherry', crop_type_slug: 'tomato',
      days_to_maturity_min: 70, days_to_maturity_max: 80, sun_requirements: 'full_sun', growth_habit: null } })).toBe('70–80 days')
    expect(selectKeyFact({ name: 'Yellow Brandywine', variety_ref: { name: 'Yellow Brandywine', crop_type_slug: 'tomato',
      days_to_maturity_min: null, days_to_maturity_max: null, sun_requirements: null, growth_habit: null } })).toBeNull()
  })

  // The chosen rule when there is no crop type: a name never makes a tomato. On prod no live cultivar lacks
  // a crop type and the 3 cultivar-less plantings have no habit to read, so this changes nothing live; it
  // keeps the name test from coming back as a fallback. A tomatillo is its own crop, even with the word.
  it('(2) a name alone never makes a tomato, and a tomatillo is not one', () => {
    expect(selectKeyFact({ name: 'Sungold Tomato', variety_ref: { name: 'Sungold', growth_habit: 'indeterminate vine',
      days_to_maturity_min: 57, days_to_maturity_max: 65 } })).toBe('57–65 days')
    expect(selectKeyFact({ name: 'Sungold Tomato', variety_ref: { type: 'Tomato', growth_habit: 'indeterminate vine',
      days_to_maturity_min: 57, days_to_maturity_max: 65 } })).toBe('57–65 days')
    expect(selectKeyFact({ name: 'Tomato', metadata: { growth_habit: 'determinate' } })).toBeNull()
    expect(selectKeyFact({ name: 'Cisneros Tomatillo', variety_ref: { name: 'Cisneros', crop_type_slug: 'tomatillo',
      days_to_maturity_min: 80, days_to_maturity_max: 85, sun_requirements: 'full_sun',
      growth_habit: 'sprawling indeterminate vine; benefits from tomato cage or trellis; 3-4 ft tall, spreading 3+ ft' } })).toBe('80–85 days')
  })

  // Prod rows (plants Lambda variety_ref, 2026-09-25). Rung 2 used to return any habit that did not START
  // with determ/indeterm whole, capitalised, into a nowrap pill: these two live tomatoes-by-name wore
  // 43 and 113 characters of prose. No determinacy word now means the next rung, here their days.
  it('(2) prose with no determinacy word is never the pill: the two tomatillo sentences fall through', () => {
    const blushProse = 'bushy upright; 3-5 in jalapeño-size fruit, compact productive plants; simultaneous green/purple/red fruit display'
    const blush = { name: 'Purple Blush Tomatillo', variety_ref: { name: 'Purple blush', crop_type_slug: 'tomatillo',
      days_to_maturity_min: 70, days_to_maturity_max: 75, sun_requirements: 'full_sun', growth_habit: blushProse } }
    const pineapple = { name: 'Pineapple Tomatillo', variety_ref: { name: 'Pineapple Tomatillo', crop_type_slug: 'tomatillo',
      days_to_maturity_min: 75, days_to_maturity_max: 90, sun_requirements: 'full_sun',
      growth_habit: 'low sprawling/bushy, 12-24 in; husked fruit' } }
    expect(selectKeyFact(blush)).toBe('70–75 days')
    expect(selectKeyFact(pineapple)).toBe('75–90 days')
    // With nothing further down the ladder the pill is absent, not the prose.
    expect(selectKeyFact({ name: 'Purple Blush Tomatillo', variety_ref: { growth_habit: blushProse } })).toBeNull()
  })

  // Live prose that does not open with the word (Celebrity, Cherry Falls, Rosa Sicilian cultivars). The
  // old test printed the first two whole; leftmost-term wins, as on the CropCard pill and the facet chip.
  it('(2) the determinacy word is read wherever it sits in the prose, leftmost first', () => {
    const tomato = (growth_habit) => ({ name: 'Test Tomato', variety_ref: { crop_type_slug: 'tomato', growth_habit,
      days_to_maturity_min: 70, days_to_maturity_max: 75 } })
    expect(selectKeyFact(tomato('semi-determinate bush, 4-5 ft'))).toBe('Semi-determinate')
    expect(selectKeyFact(tomato('trailing/cascading determinate; 24-36 in spreading; bred for hanging baskets and containers; no staking required'))).toBe('Determinate')
    expect(selectKeyFact(tomato('indeterminate vine (semi-determinate per some sources); deeply ribbed costoluto-type; 5-6 ft; stake or cage required'))).toBe('Indeterminate')
    // "semi-" alone is not a determinacy class.
    expect(selectKeyFact(tomato('semi-compact bush'))).toBe('70–75 days')
  })

  it('(3) DTM window for a non-pepper/non-tomato crop', () => {
    expect(selectKeyFact({ variety_ref: { name: 'Basil', days_to_maturity_min: 50, days_to_maturity_max: 70 } })).toBe('50–70 days')
  })

  it('(3) DTM with only one bound', () => {
    expect(selectKeyFact({ variety_ref: { name: 'Kale', days_to_maturity_max: 55 } })).toBe('55 days')
  })

  it('(4) sun requirement when no SHU/habit/DTM', () => {
    expect(selectKeyFact({ variety_ref: { name: 'Lettuce', sun_requirements: 'Full sun' } })).toBe('Full sun')
  })

  it('(4) long sun string is shortened to the first clause', () => {
    expect(selectKeyFact({ variety_ref: { name: 'Mint', sun_requirements: 'Partial shade, tolerates full sun' } })).toBe('Partial shade')
  })

  // Prod shape: sun_requirements is a code. Until 2026-09-25 the gold hero pill printed it on 45 live
  // plantings (29 full_sun, 13 part_shade, 3 part_sun) — mostly ornamentals, which skip the DTM rung.
  it('(4) a sun code reads as the editor words, never the code', () => {
    const coleus = {
      name: 'Fairway Orange Coleus Clone 1',
      variety_ref: { name: 'Fairway Orange', crop_type_slug: 'coleus', days_to_maturity_min: 60, sun_requirements: 'part_shade' },
    }
    expect(selectKeyFact(coleus)).toBe('Part shade')
    expect(selectKeyFact({ variety_ref: { name: 'Lettuce', sun_requirements: 'full_sun' } })).toBe('Full sun')
    expect(selectKeyFact({ variety_ref: { name: 'Mint', sun_requirements: 'part_sun' } })).toBe('Part sun')
    expect(selectKeyFact({ variety_ref: { name: 'Hosta', crop_type_slug: 'hosta', sun_requirements: 'full_shade' } })).toBe('Full shade')
  })

  it('(4) no sun value still means no pill', () => {
    expect(selectKeyFact({ variety_ref: { name: 'Fairway Orange', crop_type_slug: 'coleus', sun_requirements: null } })).toBeNull()
  })

  it('(5) returns null when nothing qualifies (no empty pill)', () => {
    expect(selectKeyFact({ variety_ref: { name: 'Mystery' } })).toBeNull()
    expect(selectKeyFact({})).toBeNull()
    expect(selectKeyFact(null)).toBeNull()
  })

  it('reads JSON fields defensively (garbage SHU is ignored, falls through)', () => {
    const pl = { variety_ref: { type: 'Pepper', sun_requirements: 'Full sun' }, metadata: { shu: 'not-a-number' } }
    expect(selectKeyFact(pl)).toBe('Full sun')
  })
})

describe('formatBotanical', () => {
  it('genus + species -> "Genus species", italic', () => {
    expect(formatBotanical({ genus: 'capsicum', species: 'Annuum' })).toEqual({ text: 'Capsicum annuum', italic: true })
  })

  it('genus only -> capitalized genus, italic', () => {
    expect(formatBotanical({ genus: 'solanum' })).toEqual({ text: 'Solanum', italic: true })
  })

  it('bare species field packed with "Genus species" is split', () => {
    expect(formatBotanical({ species: 'Capsicum annuum' })).toEqual({ text: 'Capsicum annuum', italic: true })
  })

  it('single-word species only -> italic species as-is', () => {
    expect(formatBotanical({ species: 'annuum' })).toEqual({ text: 'annuum', italic: true })
  })

  it('neither -> null (row omitted)', () => {
    expect(formatBotanical({})).toBeNull()
    expect(formatBotanical(null)).toBeNull()
  })
})

describe('cropFamilyGlyph — no-photo fallback glyph by family', () => {
  it('fruiting crops -> lifecycle.fruit', () => {
    expect(cropFamilyGlyph({ variety_ref: { type: 'Pepper' } })).toBe('lifecycle.fruit')
    expect(cropFamilyGlyph({ name: 'Sungold Tomato' })).toBe('lifecycle.fruit')
    expect(cropFamilyGlyph({ name: 'Albion Strawberry' })).toBe('lifecycle.fruit')
  })

  it('flowers -> lifecycle.bloom', () => {
    expect(cropFamilyGlyph({ name: 'Marigold' })).toBe('lifecycle.bloom')
    expect(cropFamilyGlyph({ variety_ref: { type: 'flower' } })).toBe('lifecycle.bloom')
  })

  it('everything else -> lifecycle.sprout', () => {
    expect(cropFamilyGlyph({ name: 'Basil' })).toBe('lifecycle.sprout')
    expect(cropFamilyGlyph({})).toBe('lifecycle.sprout')
  })
})

describe('selectCropType — V4-ABOVEFOLD-001 crop-type chip', () => {
  it('prefers an explicit structured crop field, title-cased', () => {
    expect(selectCropType({ variety_ref: { type: 'pepper' } })).toBe('Pepper')
    expect(selectCropType({ variety_ref: { group: 'leafy green' } })).toBe('Leafy green')
    expect(selectCropType({ variety_ref: { crop_family: 'brassica' } })).toBe('Brassica')
  })

  it('normalizes underscores/hyphens in the structured value', () => {
    expect(selectCropType({ variety_ref: { type: 'root_vegetable' } })).toBe('Root vegetable')
  })

  it('falls back to pepper/tomato family detection by name', () => {
    expect(selectCropType({ name: 'Habanero Orange', variety_ref: {} })).toBe('Pepper')
    expect(selectCropType({ name: 'Sungold Tomato', variety_ref: {} })).toBe('Tomato')
  })

  it('returns null when no crop signal exists', () => {
    expect(selectCropType({ name: 'Mystery', variety_ref: {} })).toBeNull()
    expect(selectCropType({})).toBeNull()
    expect(selectCropType(null)).toBeNull()
  })

  it('clamps an over-long type to keep the pill compact', () => {
    const out = selectCropType({ variety_ref: { type: 'a'.repeat(40) } })
    expect(out.length).toBeLessThanOrEqual(22)
    expect(out.endsWith('…')).toBe(true)
  })
})
