// BUG-USEBYDAYBOUNDARY-001 — the use-by window classifier.
//
// WHY THIS FILE EXISTS AT ALL. Before it, `grep -rln classifyUseBy --include='*.test.js'` returned
// NOTHING. The function is computed server-side and shipped to every client as `use_by_status`, it
// drives the Today-page band and the Put-Up row chips, and it had zero behavioural coverage. The one
// place it was mentioned (tests/integration/preservation.int.test.js) asserts an already-long-past
// date, which cannot see a one-day boundary. That is how a four-hours-a-night defect lived in prod.
//
// EVERY TEST HERE IS ANCHORED TO A MUTATION. A test that cannot fail is not coverage, so each block
// below names the exact one-line change to useBy.js that must turn it red. If you edit that file and
// this suite stays green, the suite is wrong, not the edit.
//
// TIME IS REAL, NOT FAKED. `now` is injected as an argument (useBy.js is pure by contract), so these
// pin specific instants without touching timers. The ET assertions use explicit `-04:00`/`-05:00`
// offsets rather than zoneless local strings, so the results are identical under the root `npm test`
// run (UTC) and under ci.yml's blocking `TZ=America/New_York` re-run — this file must not be one of
// the ones that gate is vacuous over.
import { describe, it, expect } from 'vitest';
import { classifyUseBy, dayMs, etDay, USE_SOON_FRACTION } from './useBy.js';

describe('classifyUseBy — the day boundary (the actual defect)', () => {
  // THE REGRESSION. Mutation: `const today = dayMs(etDay(now))` → `const today = now.getTime()`.
  // That is the shipped bug verbatim, and these two assertions are what catch it.
  it('does NOT flip to past_use_by on the evening BEFORE the use-by date', () => {
    // 20:01 EDT on Sep 9 is already Sep 10 00:01 UTC. The old instant-vs-UTC-midnight comparison
    // returned 'past_use_by' here; a jar good until tomorrow read as expired, on every device.
    const at2001ET = new Date('2026-09-09T20:01:00-04:00');
    expect(classifyUseBy('2026-03-10', '2026-09-10', at2001ET)).not.toBe('past_use_by');
  });

  it('is still not past ON the use-by date, even at 23:59 ET', () => {
    // The `today > useBy` comparison is strict on purpose: the date itself is the last good day.
    // Mutation: `today > useBy` → `today >= useBy` turns this red.
    const lastMinute = new Date('2026-09-10T23:59:00-04:00');
    expect(classifyUseBy('2026-03-10', '2026-09-10', lastMinute)).not.toBe('past_use_by');
  });

  it('IS past_use_by at 00:01 ET the following day', () => {
    // The other half of the boundary. Without this, a mutation to `today >= useBy + 1` (or dropping
    // the branch entirely) would leave the pair above passing. Both sides, or neither proves an edge.
    const justAfter = new Date('2026-09-11T00:01:00-04:00');
    expect(classifyUseBy('2026-03-10', '2026-09-10', justAfter)).toBe('past_use_by');
  });

  it('holds across the ET/UTC offset in winter too (EST, -05:00)', () => {
    // EDT is -04:00 and EST is -05:00. A fix hardcoding a 4-hour shift instead of doing real zone
    // conversion passes the EDT cases above and fails here. Mutation: replace etDay() with a fixed
    // `now.getTime() - 4*3600e3` offset.
    const decEvening = new Date('2026-12-09T20:01:00-05:00');
    expect(classifyUseBy('2026-06-10', '2026-12-10', decEvening)).not.toBe('past_use_by');
    const decNextDay = new Date('2026-12-11T00:01:00-05:00');
    expect(classifyUseBy('2026-06-10', '2026-12-10', decNextDay)).toBe('past_use_by');
  });
});

describe('classifyUseBy — a null start cannot manufacture use_soon', () => {
  // Mutation: delete the `if (preservedAt == null) return 'ok'` guard. `dayMs(null)` then falls
  // through to `new Date(null)` = the epoch, the span becomes ~56 years, the threshold lands a decade
  // early, and this returns 'use_soon'. Unreachable from today's NOT NULL writer; reachable the
  // moment V5-INFLIGHTBATCH-001 gives a row a nullable start.
  it('returns ok, not use_soon, when preserved_at is null and the date is far off', () => {
    const now = new Date('2026-09-03T12:00:00-04:00');
    expect(classifyUseBy(null, '2027-08-19', now)).toBe('ok');
  });

  it('still reports past_use_by with a null start once the date has passed', () => {
    // The null guard must not swallow the past branch — that would hide a genuinely expired row.
    // Mutation: move the null guard ABOVE the `today > useBy` check.
    const now = new Date('2026-09-03T12:00:00-04:00');
    expect(classifyUseBy(null, '2026-08-19', now)).toBe('past_use_by');
  });

  it('returns null (no expiry) when there is no use_by_target at all', () => {
    // Distinct from 'ok': null means the row opted out of expiry entirely (method='other',
    // purchased_preserved), which is why it is excluded from use-soon rather than merely fresh.
    const now = new Date('2026-09-03T12:00:00-04:00');
    expect(classifyUseBy('2026-08-19', null, now)).toBeNull();
    expect(classifyUseBy(null, null, now)).toBeNull();
  });
});

describe('classifyUseBy — the use_soon window is proportional, and both edges are pinned', () => {
  // A 200-day span: 2026-01-01 → 2026-07-20. 17.5% of 200 = 35 days, so the window opens 2026-06-15.
  const PRESERVED = '2026-01-01';
  const USE_BY = '2026-07-20';
  const at = (iso) => new Date(`${iso}T12:00:00-04:00`);

  it('is ok the day BEFORE the window opens', () => {
    expect(classifyUseBy(PRESERVED, USE_BY, at('2026-06-14'))).toBe('ok');
  });

  it('is use_soon on the day the window opens', () => {
    // The pair above and below is the point. Asserting only one side survives an off-by-one in the
    // threshold; asserting only 'somewhere in the middle' survives almost anything.
    expect(classifyUseBy(PRESERVED, USE_BY, at('2026-06-15'))).toBe('use_soon');
  });

  it('scales with the span rather than using a fixed number of days', () => {
    // Mutation: `useBy - span * USE_SOON_FRACTION` → `useBy - 35 * 86400000` (a constant lifted from
    // the case above). That passes every assertion in this block except this one. A short 20-day span
    // gets a 3.5-day window, so 10 days out must still be 'ok' — under the constant it reads
    // 'use_soon'.
    expect(classifyUseBy('2026-07-01', '2026-07-21', at('2026-07-11'))).toBe('ok');
    expect(classifyUseBy('2026-07-01', '2026-07-21', at('2026-07-18'))).toBe('use_soon');
  });

  it('treats a degenerate zero-or-negative span as already use_soon', () => {
    expect(classifyUseBy('2026-07-20', '2026-07-20', at('2026-07-20'))).toBe('use_soon');
  });

  it('pins USE_SOON_FRACTION itself, since every boundary above is derived from it', () => {
    // If someone retunes the fraction, the dated assertions above go red with no explanation. This
    // line is the explanation.
    expect(USE_SOON_FRACTION).toBe(0.175);
  });
});

describe('the date primitives', () => {
  it('dayMs normalizes a Date and an equivalent string to the same UTC midnight', () => {
    // The neon driver hands back Date objects for date/timestamptz columns while the app passes
    // strings, and both reach this function. Mutation: `d.getUTCFullYear()` → `d.getFullYear()`.
    expect(dayMs(new Date('2026-09-10T00:00:00Z'))).toBe(dayMs('2026-09-10'));
    expect(dayMs('2026-09-10')).toBe(Date.UTC(2026, 8, 10));
  });

  it('etDay resolves an instant to its EASTERN calendar day, not the UTC one', () => {
    // 20:01 EDT Sep 9 is Sep 10 in UTC and Sep 9 in ET. This single assertion is the fix in miniature.
    expect(etDay(new Date('2026-09-09T20:01:00-04:00'))).toBe('2026-09-09');
    expect(etDay(new Date('2026-09-10T00:30:00-04:00'))).toBe('2026-09-10');
  });

  it('etDay is unaffected by the process timezone', () => {
    // The assertions in this file must mean the same thing under the root run (UTC) and under
    // ci.yml's blocking TZ=America/New_York re-run. An implementation that reached for the ambient
    // zone instead of naming ET would differ between the two lanes and this pins that it does not.
    expect(etDay(new Date('2026-01-15T22:00:00Z'))).toBe('2026-01-15');
    expect(etDay(new Date('2026-06-15T22:00:00Z'))).toBe('2026-06-15');
  });
});
