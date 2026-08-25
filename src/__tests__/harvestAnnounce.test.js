// harvestAnnounce — V4-HAPTICVOCAB-001.
//
// The WORDING is the conformance artefact (WCAG 2.2 SC 4.1.3 Status Messages), so it is pinned
// here rather than left to a rendering test. The second half of the file is the agreement check:
// the spoken total must be computed by the SAME rule the visible session strip uses
// (EventNew.jsx:2657-2664), because if the two can be computed differently they will eventually
// disagree, and the eyes-free channel would be the one that was wrong.
import { describe, it, expect } from 'vitest'
import { formatHarvestSaveAnnouncement, formatHarvestUndoAnnouncement } from '../lib/harvestAnnounce.js'

const row = (over = {}) => ({ eventId: `e${Math.random()}`, plantId: 'p1', plantName: 'Cayenne #1', qty: 4, unit: 'fruit', grams: 320, undone: false, undoError: null, ...over })

describe('save announcement', () => {
  it('leads with the outcome, then names plant, quantity and weight', () => {
    // "Saved" first: a polite region can be cut off by the next keypress, so the first clause has to
    // carry the answer he is waiting on.
    const text = formatHarvestSaveAnnouncement([row()])
    expect(text.startsWith('Saved. Cayenne #1, 4 fruit, 320 grams.')).toBe(true)
  })

  it('carries the session count and the running total', () => {
    const rows = [row({ grams: 320 }), row({ grams: 250 }), row({ grams: 100 })]
    expect(formatHarvestSaveAnnouncement(rows)).toBe(
      'Saved. Cayenne #1, 4 fruit, 100 grams. 3 harvests this session, 670 grams total.'
    )
  })

  it('singularises one harvest', () => {
    expect(formatHarvestSaveAnnouncement([row()])).toContain('1 harvest this session')
    expect(formatHarvestSaveAnnouncement([row(), row()])).toContain('2 harvests this session')
  })

  it('omits the weight clause entirely when nothing was weighed', () => {
    // The weight is optional (validateHarvest lets an empty field through), and "0 grams" would be
    // a false statement about the row rather than an absent one.
    const text = formatHarvestSaveAnnouncement([row({ grams: null })])
    expect(text).toBe('Saved. Cayenne #1, 4 fruit. 1 harvest this session.')
  })

  it('EXCLUDES undone rows from both the count and the total', () => {
    // Same `!undone` filter the visible strip applies. An undone row still sitting in the total
    // would have the spoken number disagreeing with the printed one.
    const rows = [row({ grams: 500, undone: true }), row({ grams: 200 })]
    expect(formatHarvestSaveAnnouncement(rows)).toContain('1 harvest this session, 200 grams total')
  })

  it('rolls over to kilograms at the same 1000g boundary the strip uses', () => {
    const under = formatHarvestSaveAnnouncement([row({ grams: 999 })])
    expect(under).toContain('999 grams total')
    const over = formatHarvestSaveAnnouncement([row({ grams: 600 }), row({ grams: 650 })])
    expect(over).toContain('1.3 kilograms total')
  })

  it('spells units out — this string is spoken, never displayed', () => {
    const text = formatHarvestSaveAnnouncement([row({ grams: 1200 })])
    expect(text).toMatch(/kilograms/)
    expect(text).not.toMatch(/\bkg\b/)
    expect(formatHarvestSaveAnnouncement([row()])).not.toMatch(/\bg\b/)
  })

  it('says nothing at all rather than something wrong when there is no row', () => {
    expect(formatHarvestSaveAnnouncement([])).toBe('')
    expect(formatHarvestSaveAnnouncement()).toBe('')
  })

  it('falls back to a literal noun when the row has no plant name', () => {
    expect(formatHarvestSaveAnnouncement([row({ plantName: null })])).toContain('Saved. Planting, 4 fruit')
  })
})

describe('undo announcement', () => {
  it('names the planting that was removed', () => {
    expect(formatHarvestUndoAnnouncement('Cayenne #1')).toBe('Cayenne #1 harvest removed.')
  })

  it('falls back to a literal noun', () => {
    expect(formatHarvestUndoAnnouncement(null)).toBe('Planting harvest removed.')
  })
})
