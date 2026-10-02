// Put-Up R2a, lane F (D4; QA-M5) — the day a batch began, as recipe detail's "Made from this" says it.
// `started_at` is an INSTANT: Start's "Today" sends now.toISOString(), so a batch started at 9:30 pm on
// Oct 1 in New York is stored as 2026-10-02T01:30:00.000Z. Read by its first ten characters it said Oct 2.
//
// TWO CELLS, EACH RUN IN America/New_York AND UTC (the CI lane runs `npm test` and the TZ re-run):
//   · a timestamp reads as the reader's local day;
//   · a date-only value reads as that day — never through `new Date(at)`, which is UTC midnight and lands
//     on the day before, west of Greenwich.
// Under UTC the defect and the fix print the same day, so the first cell can only FAIL in New York; the
// zone-literal arm below says so in each zone's own words.
// MUTATIONS (each run in New York, each red here):
//   F-M3  read the first ten characters (= the base)        -> "started 9:30 pm Oct 1 reads Oct 1"
//   F-M3b `new Date(at)` for a date-only value              -> "a plain 2026-10-01 reads Oct 1"
import { describe, it, expect } from 'vitest'
import { madeBatchWords } from '../components/recipes/recipes.js'

const NOW = new Date(2026, 9, 9, 12, 0, 0)
const when = (started_at, now = NOW) => madeBatchWords({ started_at }, now).when
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
// What the one wire value 2026-10-02T01:30:00.000Z must read as, by the zone the suite is run in.
const WIRE_LITERAL = { 'America/New_York': 'Oct 1', UTC: 'Oct 2' }

describe('"Made from this" — the day a batch began is the reader\'s day (D4)', () => {
  it('started 9:30 pm Oct 1 reads Oct 1', () => {
    // The instant as Start sends it: 9:30 pm on Oct 1 by this machine's clock, as an ISO string.
    const sent = new Date(2026, 9, 1, 21, 30, 0).toISOString()
    expect(when(sent)).toBe('Oct 1')
    // 11:59 pm and one minute past midnight sit on either side of the day's edge.
    expect(when(new Date(2026, 9, 1, 23, 59, 0).toISOString())).toBe('Oct 1')
    expect(when(new Date(2026, 9, 2, 0, 1, 0).toISOString())).toBe('Oct 2')
  })

  it.runIf(ZONE in WIRE_LITERAL)('the wire value 2026-10-02T01:30:00.000Z reads as this zone\'s day', () => {
    expect(when('2026-10-02T01:30:00.000Z')).toBe(WIRE_LITERAL[ZONE])
    // The same instant written with its offset is the same day.
    expect(when('2026-10-01T21:30:00-04:00')).toBe(WIRE_LITERAL[ZONE])
  })

  it('a plain 2026-10-01 reads Oct 1', () => {
    expect(when('2026-10-01')).toBe('Oct 1')
    expect(when('2026-01-01')).toBe('Jan 1')
    expect(when('2025-12-31')).toBe('Dec 31, 2025')
  })

  it('the year is the local day\'s year: 10 pm on New Year\'s Eve is last year\'s Dec 31', () => {
    const now = new Date(2027, 0, 2, 12, 0, 0)
    expect(when(new Date(2026, 11, 31, 22, 0, 0).toISOString(), now)).toBe('Dec 31, 2026')
    expect(when(new Date(2027, 0, 1, 0, 30, 0).toISOString(), now)).toBe('Jan 1')
  })

  it('first_recorded_at stands in for a batch with no start, read the same way', () => {
    const at = new Date(2026, 9, 1, 21, 30, 0).toISOString()
    expect(madeBatchWords({ started_at: null, first_recorded_at: at }, NOW).when).toBe('Oct 1')
    expect(madeBatchWords({ started_at: null, first_recorded_at: null }, NOW).when).toBe('date not recorded')
  })

  // A Date in hand is read by its local parts; text that is no instant keeps what it read as before.
  it('a Date reads as its local day, and text that is not an instant is left to its leading date', () => {
    expect(when(new Date(2026, 9, 1, 21, 30, 0))).toBe('Oct 1')
    expect(when('2026-10-01 or so')).toBe('Oct 1')
    expect(when('sometime')).toBe('')
  })
})
