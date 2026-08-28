// Cross-file timezone-agreement guard for last_fert (feed card was a day late).
//
// The newest fertilizing date for a planting is computed TWICE, by the two halves of one mechanism:
// generation (handler.js, the nightly planting query) and the read-time done check
// (daily-plan-read/index.js lastFertByPlant). Both results are compared against an ET "today", so
// both must be ET dates. They were not: generation used `at time zone 'UTC'`, which is one day later
// than ET for anything logged live between 20:00 and 23:59 ET, and generation therefore
// over-suppressed the feed card by up to a day. Nothing pinned the agreement.
//
// STATIC SOURCE, not import, for the read side: daily-plan-read/index.js pulls in
// @neondatabase/serverless + @clerk/backend + @aws-sdk/client-secrets-manager at module load, none of
// which resolve at the repo root, so the unit run cannot execute it. Same constraint and same
// precedent as daily-plan-read/index.test.js. handler.js is read statically for the same reason (pg
// + the AWS SDK) and because the projection is a SQL string, not a callable.
//
// WHAT THIS PROVES: that both SQL expressions name the same timezone, and that the timezone
// generation names puts a 21:00-ET instant on the ET calendar day. WHAT IT DOES NOT PROVE: that
// Postgres evaluates either expression as intended -- no database runs here. The `max()` placement
// differs between the two files (`max(x) AT TIME ZONE z` vs `max((x AT TIME ZONE z)::date)`) and
// that difference is NOT checked; it is date-equivalent because the conversion is monotonic outside
// the one-hour DST fall-back ambiguity, which never straddles midnight.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';

const { daysBetween } = engine;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Same decommenter as daily-plan-read/index.test.js: a zone NAMED IN A COMMENT is not that zone, and
// this file's SQL carries a prose comment mentioning both zones directly above the expression.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const GEN_SRC = decomment(readFileSync(resolve(__dirname, 'handler.js'), 'utf8'));
const READ_SRC = decomment(readFileSync(resolve(__dirname, '../daily-plan-read/index.js'), 'utf8'));

// BOUNDED extraction -- one physical line, never a `[\s\S]*` span. An unbounded match between the
// `as last_fert` alias and `AT TIME ZONE` would run on to the NEXT such clause anywhere later in the
// file (both files have several) and report a zone the expression does not carry. Asserting the line
// is found, and that it carries exactly one zone clause, is what keeps this from going vacuous if
// either projection is ever reformatted across lines.
function lastFertZone(src, label) {
  const lines = src.split('\n').filter((l) => /\bas\s+last_fert\b/i.test(l));
  expect(lines.length, `${label}: expected exactly one single-line last_fert projection`).toBe(1);
  const zones = [...lines[0].matchAll(/AT\s+TIME\s+ZONE\s+'([^']+)'/gi)].map((m) => m[1]);
  expect(zones.length, `${label}: last_fert must state exactly one explicit AT TIME ZONE`).toBe(1);
  return zones[0];
}

// 2026-08-11 21:00 EDT. The recon worked example, and the discriminating instant: an evening feed
// logged live, whose UTC calendar date is the 12th and whose ET calendar date is the 11th.
const EVENING_FEED_UTC = '2026-08-12T01:00:00Z';
const calendarDate = (zone, iso) => new Intl.DateTimeFormat('en-CA',
  { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

describe('last_fert timezone agreement — generation and read compute one quantity', () => {
  it('the fixture instant actually discriminates UTC from ET', () => {
    expect(calendarDate('UTC', EVENING_FEED_UTC)).toBe('2026-08-12');
    expect(calendarDate('America/New_York', EVENING_FEED_UTC)).toBe('2026-08-11');
  });

  it('both last_fert expressions name the same timezone, and it is ET', () => {
    const gen = lastFertZone(GEN_SRC, 'daily-plan/handler.js');
    const read = lastFertZone(READ_SRC, 'daily-plan-read/index.js');
    expect(gen).toBe(read);
    // ET specifically, because the "today" both are compared against is ET on both sides.
    expect(gen).toBe('America/New_York');
  });

  it("generation's zone puts an evening feed on the day the gardener fed, not the day after", () => {
    const gen = lastFertZone(GEN_SRC, 'daily-plan/handler.js');
    expect(calendarDate(gen, EVENING_FEED_UTC))
      .toBe(calendarDate('America/New_York', EVENING_FEED_UTC));
  });

  // The consequence, through the engine's own day math: engine.js suppresses the feed card while
  // dF < iv. With a 14-day interval and the ET date the card is due on 08-25; with the UTC date it
  // is one short and the card slips to 08-26.
  it('a 14-day feed is due on day 14 under the zone generation names', () => {
    const lastFert = calendarDate(lastFertZone(GEN_SRC, 'daily-plan/handler.js'), EVENING_FEED_UTC);
    expect(daysBetween('2026-08-25', lastFert)).toBe(14);
    expect(daysBetween('2026-08-25', calendarDate('UTC', EVENING_FEED_UTC))).toBe(13);
  });
});
