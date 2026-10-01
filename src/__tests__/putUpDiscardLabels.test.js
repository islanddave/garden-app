// Put-Up UX pass R1 (prep) — putItUp.js DISCARD_LABELS: the discard choice's three words, exported ONCE so
// the Pantry door, the Walk and Put it up render the same strings. Prep only exports it; the lanes wire it.
// MUTATION: reword one label, or unfreeze the object -> red.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import { DISCARD_LABELS, newRow, putUpBody } from '../components/putup/putItUp.js'

const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const place = { key: 'id:p1', id: 'p1', label: 'Fridge', kind: 'fridge' }
const sentRow = (discard) => putUpBody({
  key: '00000000-0000-4000-8000-000000000001', when: { date: '2026-09-29', precision: 'day' }, method: 'hot_sauce',
  rows: [{ ...newRow(), place, discard }], finish: true, batch: { label: 'Pepper mash' },
}).body.rows[0]

describe('DISCARD_LABELS — the discard choice, worded once', () => {
  it('is exactly the three words', () => {
    expect(DISCARD_LABELS).toStrictEqual({ auto: 'Work it out', date: 'From the label', none: 'No date' })
  })

  it('is keyed by the modes a Put it up row holds: a new row is auto, and date and none are what the body reads', () => {
    expect(Object.keys(DISCARD_LABELS)).toEqual(['auto', 'date', 'none'])
    expect(newRow().discard.mode).toBe('auto')
    expect('discard_by' in sentRow({ mode: 'auto', date: '' })).toBe(false)
    expect(sentRow({ mode: 'date', date: '2027-01-05' }).discard_by).toBe('2027-01-05')
    expect(sentRow({ mode: 'none', date: '' }).discard_by).toBe('none')
  })

  it('is frozen: one surface cannot reword it for the others', () => {
    expect(Object.isFrozen(DISCARD_LABELS)).toBe(true)
    expect(() => { DISCARD_LABELS.auto = 'Guess' }).toThrow(TypeError)
    expect(DISCARD_LABELS.auto).toBe('Work it out')
  })

  it('carries no banned word', () => {
    for (const words of Object.values(DISCARD_LABELS)) expect(`${words}: ${BANNED.test(words)}`).toBe(`${words}: false`)
    // Non-vacuity: the sweep does fire on a banned word, and "label" is not mistaken for one.
    expect(BANNED.test('From the table')).toBe(true)
  })
})
