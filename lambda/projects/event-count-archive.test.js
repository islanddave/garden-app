// M14 — GET /api/projects/:id event_count must count the rows the LIST returns.
//
// ProjectDetail's "Event log (N)" badge reads this number while its list is still a prefix. The list
// is lambda/events' Route 4 project-scoped branch, which since V4-ARCHIVEHIDE-001 L1 hides events
// whose planting is ARCHIVED. This COUNT did not, so it described a strictly larger set. Measured on
// prod before the fix: 8 projects diverged (Peppers 5257 vs 4517, Tomatoes 3277 vs 3238, Lettuce 96
// vs 57, Succulents & Cacti 60 vs 59) and four went to zero (Loofah Sponge 67, Cilantro 32, Spinach
// 13, Lithops 1) — on those four the badge would have sat above "No events yet".
//
// Static-source guard, like every other Lambda test in this repo: it proves the predicate is present
// and correctly shaped, NOT that Postgres returns the same rows. The cross-Lambda equality is
// asserted structurally below (same predicate text in both files) rather than by execution; a real
// proof needs an integration run against a database, which this suite does not have.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct: without this, deleting the predicate and
// leaving the comment that explains it behind would keep every assertion below green.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const EVENTS_SRC = decomment(readFileSync(resolve(__dirname, '..', 'events', 'index.js'), 'utf8'));

// The event_count query, isolated: the COUNT block that reads event_log.
const countBlock = () => {
  const m = /SELECT COUNT\(\*\)::int AS count\s+FROM event_log[\s\S]*?`/.exec(SRC);
  return m ? m[0] : null;
};

const NORM = (s) => s.replace(/\s+/g, ' ').trim();

describe('projects Lambda — event_count agrees with the event list', () => {
  it('still has exactly one event_log COUNT block to reason about', () => {
    const all = SRC.match(/SELECT COUNT\(\*\)::int AS count\s+FROM event_log/g) ?? [];
    expect(all).toHaveLength(1);
    expect(countBlock()).not.toBeNull();
  });

  // MUTATION: delete the NOT EXISTS clause -> RED. In prod that RED is a badge reading (67) above a
  // log that correctly renders nothing.
  it('excludes events whose planting is archived', () => {
    expect(NORM(countBlock())).toContain(
      NORM('AND NOT EXISTS (SELECT 1 FROM public.garden_node ga WHERE ga.id = e.plant_id AND ga.archived_at IS NOT NULL)'),
    );
  });

  // The predicate must stay byte-comparable with the list's. Two hand-maintained copies of one
  // filter is the drift the events lane refused this fix over; making the copies identical is what
  // makes the drift detectable here rather than in a user's badge.
  it('uses the identical predicate the events Lambda list branch uses', () => {
    const PRED = NORM('NOT EXISTS (SELECT 1 FROM public.garden_node ga WHERE ga.id = e.plant_id AND ga.archived_at IS NOT NULL)');
    expect(NORM(EVENTS_SRC)).toContain(PRED);
    expect(NORM(countBlock())).toContain(PRED);
  });

  // NOT EXISTS, never a join. A join drops events with NO planting anchor (plant_id NULL), which the
  // list keeps — silently emptying the count on any project logged without plantings.
  it('does not reach the planting through a join, which would drop unanchored events', () => {
    expect(countBlock()).not.toMatch(/JOIN\s+public\.garden_node/i);
  });

  // archived_at and deleted_at are orthogonal columns (lambda/plants' archive UPDATE deliberately
  // keeps deleted_at NULL so unarchive stays recoverable). Folding them together here would make the
  // count disagree with the list in the other direction.
  it('keeps the soft-delete axis and the archive axis separate', () => {
    expect(NORM(countBlock())).toContain(NORM('AND e.deleted_at IS NULL'));
    expect(countBlock()).toMatch(/ga\.archived_at IS NOT NULL/);
    expect(countBlock()).not.toMatch(/ga\.deleted_at/);
  });

  it('is still scoped to the requested project', () => {
    expect(NORM(countBlock())).toContain(NORM('WHERE e.project_id = ${projectId}'));
  });
});
