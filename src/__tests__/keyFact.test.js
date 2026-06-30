// keyFact + formatBotanical unit tests (V200 Slice 5b). Pure helpers — no DOM, no jest-dom.
import { describe, it, expect } from 'vitest'
import { selectKeyFact, formatBotanical, cropFamilyGlyph } from '../lib/keyFact.js'

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

  it('(2) tomato -> Indeterminate / Determinate from growth_habit', () => {
    expect(selectKeyFact({ variety_ref: { type: 'Tomato' }, metadata: { growth_habit: 'indeterminate' } })).toBe('Indeterminate')
    expect(selectKeyFact({ variety_ref: { type: 'tomato' }, attr_override: { growth_habit: 'Determinate' } })).toBe('Determinate')
  })

  it('(2) tomato without growth_habit falls through to DTM', () => {
    const pl = { variety_ref: { type: 'Tomato', days_to_maturity_min: 60, days_to_maturity_max: 60 } }
    expect(selectKeyFact(pl)).toBe('60 days')
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
