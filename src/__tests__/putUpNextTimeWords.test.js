// Put-Up UX pass R1 (prep) — howItWasMade.js nextTimeWords(line, now): one stored "Next time (2026-09-02):
// <text>" line as it is read, "Next time: <text> · Sep 2" (", 2025" only when it is not this year). Any
// other string comes back as it was given. Prep only exports it; the row sheet, How it was made and the
// planting page call it in their own lanes.
//
// Instants are ZONELESS LOCAL literals, never derived from the function under test, so the TZ lane has
// something to bite on: `npm test` plus the blocking TZ re-run (America/New_York and UTC).
// MUTATION: build the day with `new Date('YYYY-MM-DD')` -> "the day does not move with the zone" reds in
// New York (and stays green in UTC, which is why both lanes run).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTimeWords, nextTimeLines } from '../components/putup/howItWasMade.js'

const NOW = new Date(2026, 9, 1, 12, 0, 0)        // Thu Oct 1 2026, noon local
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i

afterEach(() => { vi.useRealTimers() })

describe('nextTimeWords — a stored Next time line, as it is read', () => {
  it('moves the date to the end as a short day: Next time: <text> · <Mon D>', () => {
    expect(nextTimeWords('Next time (2026-09-02): more salt', NOW)).toBe('Next time: more salt · Sep 2')
    expect(nextTimeWords('Next time (2026-10-01): pull it a day sooner', NOW)).toBe('Next time: pull it a day sooner · Oct 1')
  })

  it('adds the year only when it is not the current one', () => {
    expect(nextTimeWords('Next time (2025-12-31): less sugar', NOW)).toBe('Next time: less sugar · Dec 31, 2025')
    expect(nextTimeWords('Next time (2027-01-04): less sugar', NOW)).toBe('Next time: less sugar · Jan 4, 2027')
    expect(nextTimeWords('Next time (2026-01-01): less sugar', NOW)).toBe('Next time: less sugar · Jan 1')
    expect(nextTimeWords('Next time (2026-12-31): less sugar', NOW)).toBe('Next time: less sugar · Dec 31')
    // The current year is the LOCAL year of `now`: half past midnight on New Year's Day is already 2027.
    const newYear = new Date(2027, 0, 1, 0, 30, 0)
    expect(nextTimeWords('Next time (2026-12-31): less sugar', newYear)).toBe('Next time: less sugar · Dec 31, 2026')
    expect(nextTimeWords('Next time (2027-01-01): less sugar', newYear)).toBe('Next time: less sugar · Jan 1')
  })

  it('the day does not move with the zone', () => {
    // The first of a month and of a year are where a UTC parse shows: west of Greenwich it reads the day before.
    expect(nextTimeWords('Next time (2026-01-01): x', NOW)).toBe('Next time: x · Jan 1')
    expect(nextTimeWords('Next time (2026-03-01): x', NOW)).toBe('Next time: x · Mar 1')
    expect(nextTimeWords('Next time (2026-09-30): x', NOW)).toBe('Next time: x · Sep 30')
    // The control, so this test says which lane it ran in: the UTC parse this function never uses DOES
    // move the day west of Greenwich (New York), and does not at UTC.
    const west = new Date(2026, 0, 1).getTimezoneOffset() > 0
    expect(new Date('2026-01-01').getDate()).toBe(west ? 31 : 1)
  })

  it('prints the month words its neighbours print, for all twelve', () => {
    const said = Array.from({ length: 12 }, (_, i) => nextTimeWords(`Next time (2026-${String(i + 1).padStart(2, '0')}-15): x`, NOW))
    expect(said).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      .map(m => `Next time: x · ${m} 15`))
  })

  it('keeps the text exactly as it was written', () => {
    expect(nextTimeWords('Next time (2026-09-02): try 3% salt (not 2%): see the card · page 4', NOW))
      .toBe('Next time: try 3% salt (not 2%): see the card · page 4 · Sep 2')
    expect(nextTimeWords('Next time (2026-09-02):  two spaces, kept inside  the text', NOW))
      .toBe('Next time: two spaces, kept inside  the text · Sep 2')
    expect(nextTimeWords('Next time (2028-02-29): a leap day', NOW)).toBe('Next time: a leap day · Feb 29, 2028')
  })

  it('returns a line that does not match unchanged', () => {
    const others = [
      'Next time: more salt',
      'More salt next time',
      'next time (2026-09-02): lower case',
      'Next Time (2026-09-02): another case',
      'Next time (2026-9-2): short parts',
      'Next time (Sep 2): a worded day',
      'Next time (2026-09-02) no colon',
      'Next time(2026-09-02): no space',
      ' Next time (2026-09-02): a leading space',
      'Note. Next time (2026-09-02): not at the start',
      'Next time (2026-09-02):',
      'Next time (2026-09-02):    ',
      'Next time (2026-09-02): one\nNext time (2026-09-03): two',
      '',
      'Blanched two minutes',
    ]
    for (const line of others) expect(nextTimeWords(line, NOW)).toBe(line)
  })

  it('returns a line whose date is not a calendar day unchanged', () => {
    for (const ymd of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-06-00', '2027-02-29', '0026-09-02']) {
      const line = `Next time (${ymd}): more salt`
      expect(nextTimeWords(line, NOW)).toBe(line)
    }
  })

  it('hands back what is not a string as it was given', () => {
    expect(nextTimeWords(null, NOW)).toBeNull()
    expect(nextTimeWords(undefined, NOW)).toBeUndefined()
    expect(nextTimeWords(7, NOW)).toBe(7)
    // …even one that would READ as a dated line if it were turned into a string.
    const worded = { toString: () => 'Next time (2026-09-02): x' }
    expect(nextTimeWords(worded, NOW)).toBe(worded)
  })

  it('with the line alone it reads the clock for the current year', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 12, 0, 0))
    expect(nextTimeWords('Next time (2026-09-02): more salt')).toBe('Next time: more salt · Sep 2')
    vi.setSystemTime(new Date(2027, 0, 2, 12, 0, 0))
    expect(nextTimeWords('Next time (2026-09-02): more salt')).toBe('Next time: more salt · Sep 2, 2026')
  })

  it('reads the lines nextTimeLines returns, dated or not, and leaves nextTimeLines as it was', () => {
    const notes = 'Blanched two minutes\nNext time (2026-09-02): more salt\n  next time, less garlic  \nNext time (2026-09-02): more salt'
    const lines = nextTimeLines(notes)
    expect(lines).toEqual(['Next time (2026-09-02): more salt', 'next time, less garlic'])
    expect(lines.map(l => nextTimeWords(l, NOW))).toEqual(['Next time: more salt · Sep 2', 'next time, less garlic'])
  })

  it('adds no banned word of its own', () => {
    const said = [nextTimeWords('Next time (2026-09-02): x', NOW), nextTimeWords('Next time (2025-09-02): x', NOW)]
    for (const s of said) expect(`${s}: ${BANNED.test(s)}`).toBe(`${s}: false`)
  })
})
