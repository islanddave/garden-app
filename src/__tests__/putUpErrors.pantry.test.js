// Put-Up B′ release 2 — the Pantry routes' refusal codes get this bundle's plain words (putUpErrors.js),
// so a phone that outlives a server wording change still reads right; the counts are the SERVER's.
// MUTATION: drop a case -> the unknown-code arm answers with the server's text and the literal reds.
import { describe, it, expect } from 'vitest'
import {
  describeRefusal, REFUSAL_CODES, jarWasUsedText, JAR_WAS_USED_SOME_TEXT, JAR_IN_BATCH_TEXT, ALREADY_UNDONE_TEXT,
  USE_IS_BATCH_LINE_TEXT, USE_IS_REVERSAL_TEXT, COUNT_CHANGED_TEXT, ITEM_REMOVED_TEXT,
} from '../lib/putUpErrors.js'

const err = (body) => Object.assign(new Error(body?.error ?? 'HTTP 409'), { status: 409, body })
const SERVER = 'the server said something else'

describe('the Pantry routes\' refusals', () => {
  it('jar_was_used counts from the server\'s n, with a path', () => {
    expect(describeRefusal(err({ code: 'jar_was_used', n: 1, error: SERVER })).text).toBe('1 was used — mark the rest Went bad, or undo that use.')
    expect(describeRefusal(err({ code: 'jar_was_used', n: 3, error: SERVER })).text).toBe(jarWasUsedText(3))
    expect(describeRefusal(err({ code: 'jar_was_used', error: SERVER })).text).toBe(JAR_WAS_USED_SOME_TEXT)
  })
  it('jar_in_batch keeps the server\'s words (they name the batch), else its own', () => {
    expect(describeRefusal(err({ code: 'jar_in_batch', lines: 1, error: 'Some of it went into “Petri Dish” — take that line out first.' })).text)
      .toBe('Some of it went into “Petri Dish” — take that line out first.')
    expect(describeRefusal(err({ code: 'jar_in_batch', lines: 1 })).text).toBe(JAR_IN_BATCH_TEXT)
  })
  it.each([
    ['already_undone', ALREADY_UNDONE_TEXT], ['use_is_batch_line', USE_IS_BATCH_LINE_TEXT],
    ['use_is_reversal', USE_IS_REVERSAL_TEXT], ['count_changed', COUNT_CHANGED_TEXT], ['item_removed', ITEM_REMOVED_TEXT],
  ])('%s has its own sentence, never the server\'s', (code, text) => {
    const r = describeRefusal(err({ code, error: SERVER }))
    expect(r).toEqual({ code, text, refresh: false })
  })
  it('every new code is in REFUSAL_CODES, none offers Refresh now, and none uses a banned word', () => {
    const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
    for (const code of ['jar_was_used', 'jar_in_batch', 'already_undone', 'use_is_batch_line', 'use_is_reversal', 'count_changed', 'item_removed']) {
      expect(Object.values(REFUSAL_CODES)).toContain(code)
      const r = describeRefusal(err({ code, n: 2 }))
      expect(r.refresh).toBe(false)
      expect(r.text).not.toMatch(BANNED)
    }
  })
})
