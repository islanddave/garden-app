// BUG-PROJEVENTTRUNC-001 — GET /api/events (Route 4) offset paging + the response-shape contract.
//
// The ledger premise was that ProjectDetail sliced its event log client-side. It does not: it
// renders every row it receives and passes no limit, so the 50 it showed was this route's SERVER
// default. &limit=200 alone lifts 35 of the 44 affected prod projects to their full history; the
// remaining 9 (max 5,257 events) need real paging, which is what these guards pin.
//
// THE CONTRACT (the thing a future edit is most likely to break silently):
//   offset ABSENT  -> a bare array, byte-identical to the pre-change response.
//   offset PRESENT -> { events, limit, offset, has_more }.
// Presence, not value. Every pre-existing caller omits offset, so none of them can be broken by
// this route growing pages — but flip the discriminator to `offset > 0` and PlantingDetail starts
// receiving an object where it destructures an array, with nothing in the unit suite going red.
//
// Static-source (L-072), DB-free — the house pattern for asserting handler SQL shape in a Lambda
// with no DB harness (mirrors hs2-plant-filter.test.js / feed-route.test.js / softdel-feed.test.js).
// Behavioural proof over real rows belongs in tests/integration/events.int.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct. Assertions run against decommented source
// so an explanatory comment describing a predicate can never satisfy a guard looking for it.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Route-bounded windows, never a fixed character count (feed-route.test.js documents why a
// byte-count slice silently truncates or, worse, matches foreign code).
function block(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  expect(i, `start marker not found — update this anchor: ${startMarker}`).toBeGreaterThan(-1);
  const j = src.indexOf(endMarker, i + startMarker.length);
  expect(j, `end marker not found — update this anchor: ${endMarker}`).toBeGreaterThan(-1);
  return src.slice(i, j + endMarker.length);
}

const plantArm = () => block(SRC, 'if (plantId && !projectId) {', 'return resp(200, plantRows);');
const ladder = () => block(SRC, 'const rows = (projectId && plantId)', 'return resp(200, rows);');
// [0] plant-scoped (project_id + plant_id), [1] project-scoped, [2] bare — declaration order.
const ladderBranches = () => ladder().split('FROM event_log e').slice(1);

describe('events Route 4 — offset parsing', () => {
  it('reads offset from the query string and floors it at 0', () => {
    expect(SRC).toMatch(/const offset = Math\.max\(parseInt\(qp\.offset \?\? '0', 10\) \|\| 0, 0\);/);
  });

  // MUTATION: change to `qp.offset > 0` -> RED here. That mutation is the dangerous one: it makes
  // the FIRST page of a paging client an array and every later page an object.
  it('the envelope discriminator is the PRESENCE of offset, not its value', () => {
    expect(SRC).toMatch(/const paged = qp\.offset != null;/);
    expect(SRC).not.toMatch(/const paged = qp\.offset > 0/);
  });

  it('limit is still defaulted at 50 and hard-clamped at 200 (paging did not raise the cap)', () => {
    expect(SRC).toMatch(/const limit = Math\.min\(parseInt\(event\.queryStringParameters\?\.limit \?\? '50', 10\), 200\);/);
  });
});

describe('events Route 4 — every branch pages', () => {
  // MUTATION: drop OFFSET from the bare branch -> RED with a count of 3. Without a per-branch
  // count, a lane that paged only the branch it cared about would ship a route where page 2 of
  // some other shape silently re-serves page 1.
  it('all four Route-4 queries carry LIMIT ... OFFSET', () => {
    const queries = [plantArm(), ...ladderBranches()];
    expect(queries.length, '1 plant-only arm + 3 ladder branches').toBe(4);
    for (const [i, q] of queries.entries()) {
      expect(q, `Route-4 query ${i} is not paged`).toMatch(/LIMIT \$\{limit\} OFFSET \$\{offset\}/);
    }
  });

  // MUTATION: drop `, e.id DESC` from any one branch -> RED. This is not cosmetic: (event_date,
  // created_at) is NOT unique in this table, and OFFSET paging over a non-total ordering may
  // legally return tied rows in a different order per page — duplicating some and skipping others
  // across the page seam. The bug it produces (a missing event) looks like data loss, not paging.
  it('all four order by a TOTAL ordering, so offset pages cannot duplicate or skip tied rows', () => {
    const queries = [plantArm(), ...ladderBranches()];
    for (const [i, q] of queries.entries()) {
      expect(q, `Route-4 query ${i} has no unique tiebreaker in its ORDER BY`)
        .toMatch(/ORDER BY e\.event_date DESC, e\.created_at DESC, e\.id DESC/);
    }
  });
});

describe('events Route 4 — the response-shape contract', () => {
  // MUTATION: delete either bare `return resp(200, rows);` / `return resp(200, plantRows);` -> RED.
  it('returns a BARE ARRAY when offset is absent (every pre-existing caller is untouched)', () => {
    expect(SRC).toMatch(/return resp\(200, rows\);/);
    expect(SRC).toMatch(/return resp\(200, plantRows\);/);
  });

  it('returns the feed-shaped envelope when offset is present', () => {
    expect(SRC).toMatch(
      /return resp\(200, \{ events: rows, limit, offset, has_more: rows\.length === limit \}\);/);
    expect(SRC).toMatch(
      /return resp\(200, \{ events: plantRows, limit, offset, has_more: plantRows\.length === limit \}\);/);
  });

  // MUTATION: move either paged return BELOW its bare sibling -> RED. Below it the paged return is
  // unreachable, the route answers an array to a paging client, and has_more is never sent — so
  // the client stops after page 1 and the truncation bug is back with a paging button on top.
  it('the paged return precedes its bare sibling in BOTH arms (below it, it is dead code)', () => {
    const pagedLadder = SRC.indexOf('return resp(200, { events: rows,');
    const bareLadder = SRC.indexOf('return resp(200, rows);');
    expect(pagedLadder).toBeGreaterThan(-1);
    expect(pagedLadder).toBeLessThan(bareLadder);

    const pagedArm = SRC.indexOf('return resp(200, { events: plantRows,');
    const bareArm = SRC.indexOf('return resp(200, plantRows);');
    expect(pagedArm).toBeGreaterThan(-1);
    expect(pagedArm).toBeLessThan(bareArm);
  });

  // The envelope key names are the wire contract shared with ProjectDetail. Named explicitly so a
  // rename to `rows`/`more` fails here rather than in a client suite that mocks its own fetch.
  it('the envelope names match /api/events/feed exactly (one paging shape in this Lambda)', () => {
    const feed = block(SRC, "rawPath === '/api/events/feed'", 'has_more: rows.length === limit });');
    expect(feed).toMatch(/\{ events: rows, limit, offset, has_more: rows\.length === limit \}/);
  });
});
