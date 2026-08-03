// comboboxInput.test.js — V4-PICKERVOICE-001 normalization, as pure functions.
// The directive's boundary: normalization-level only ("don't build a fuzzy-match engine").
// These pin BOTH sides of that boundary — what must match, and what must still miss.
import { describe, it, expect } from 'vitest'
import { looseKey, looseIncludes } from '../lib/comboboxInput.js'

describe('looseKey', () => {
  it('lowercases and drops whitespace/hyphens/apostrophes/periods', () => {
    expect(looseKey('Sun Ray')).toBe('sunray')
    expect(looseKey("Farmer's-Market  Mix.")).toBe('farmersmarketmix')
  })

  it('strips diacritics — "Jalapeño" is speakable', () => {
    expect(looseKey('Jalapeño')).toBe('jalapeno')
    expect(looseKey('Jalapeño')).toBe(looseKey('jalapeno'))
  })

  it('collapses repeated letters so common transcription spellings converge', () => {
    expect(looseKey('chilli')).toBe(looseKey('chili'))
    expect(looseKey('Minnesota')).toBe(looseKey('minesota'))
  })

  it('null/undefined are empty keys, never a throw', () => {
    expect(looseKey(null)).toBe('')
    expect(looseKey(undefined)).toBe('')
  })
})

describe('looseIncludes', () => {
  it.each([
    ['Sunray', 'sun ray'],
    ['Chili Red', 'chilli red'],
    ['Minnesota Mini', 'minnesota mini'],
    ['Spineless', 'spine less'],
  ])('%j is found by spoken %j', (name, spoken) => {
    expect(looseIncludes(name, spoken)).toBe(true)
  })

  it('empty needle matches everything (the browse-mode contract)', () => {
    expect(looseIncludes('anything', '')).toBe(true)
    expect(looseIncludes('anything', null)).toBe(true)
  })

  it('is a strict widening: plain lowercase substring matches all still hold', () => {
    for (const [hay, q] of [['Dark Green Zucchini', 'green'], ['Early Jalapeño', 'jala'], ['Sunray', 'sun']]) {
      expect(hay.toLowerCase().includes(q.toLowerCase())).toBe(true) // the old rule matched...
      expect(looseIncludes(hay, q)).toBe(true)                       // ...and the new rule must too
    }
  })

  it('does not become fuzzy: unrelated text still misses', () => {
    expect(looseIncludes('Sunray', 'moonbeam')).toBe(false)
    expect(looseIncludes('Chili Red', 'chard')).toBe(false)
  })
})
