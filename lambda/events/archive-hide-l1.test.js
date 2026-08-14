// V4-ARCHIVEHIDE-001 leak L1 — archived PLANTINGS must not leak their events onto default surfaces.
//
// THE TWO AXES ARE NOT THE SAME THING, and conflating them is the failure this file exists to
// prevent. `archived_at` is "put it away, keep the record, unarchive later"; `deleted_at` is the
// soft-delete axis with its own Recently-deleted recovery surface. The archive UPDATE in
// lambda/plants/index.js explicitly writes archived_at WHERE deleted_at IS NULL — orthogonal
// columns, orthogonal semantics. A "simplification" that folds them into one predicate silently
// makes unarchive unrecoverable on these routes.
//
// Measured on prod 2026-08-13 through the read-only role: 19 archived plantings carrying 932 live
// events, all of them reaching /api/events/feed and every project event log. The container axis
// was already filtered on the feed (pp.archived_at); the planting axis was filtered nowhere.
//
// THE DELIBERATE EXEMPTION is as load-bearing as the filter. A request that NAMES a planting is a
// deliberate request for that planting, and an archived planting keeps its own detail page (that
// page is what renders the Unarchive affordance — it is the only way back). Same precedent
// GET /api/plants/:id and this file's harvest-summary route already set. So the two plant-scoped
// Route-4 shapes are exempt BY DESIGN, and a future lane "finishing the job" by adding the
// predicate there would blank an archived planting's own log and strand it archived forever.
//
// Static-source (L-072), DB-free. Behavioural proof over real rows belongs in
// tests/integration/events.int.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

function block(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  expect(i, `start marker not found — update this anchor: ${startMarker}`).toBeGreaterThan(-1);
  const j = src.indexOf(endMarker, i + startMarker.length);
  expect(j, `end marker not found — update this anchor: ${endMarker}`).toBeGreaterThan(-1);
  return src.slice(i, j + endMarker.length);
}

// The predicate under test, matched structurally rather than by exact whitespace.
const ARCHIVED_PLANTING_FILTER =
  /NOT EXISTS \(SELECT 1 FROM public\.garden_node ga\s*\n?\s*WHERE ga\.id = e\.plant_id AND ga\.archived_at IS NOT NULL\)/;

const feedRoute = () => block(SRC, "rawPath === '/api/events/feed'", 'has_more: rows.length === limit });');
const plantOnlyArm = () => block(SRC, 'if (plantId && !projectId) {', 'return resp(200, plantRows);');
const ladder = () => block(SRC, 'const rows = (projectId && plantId)', 'return resp(200, rows);');
// [0] plant-scoped (project_id + plant_id), [1] project-scoped, [2] bare — declaration order.
const ladderBranches = () => ladder().split('FROM event_log e').slice(1);

describe('events Lambda — V4-ARCHIVEHIDE-001 L1, the leaking surfaces are filtered', () => {
  // MUTATION: delete the NOT EXISTS from the feed WHERE clause -> RED. 932 prod events return.
  it('GET /api/events/feed filters events on ARCHIVED plantings', () => {
    expect(feedRoute()).toMatch(ARCHIVED_PLANTING_FILTER);
  });

  // MUTATION: delete it from the project-scoped branch -> RED. This is the branch ProjectDetail
  // reads, i.e. the one where a user sees an archived planting's events under a live project.
  it('the project-scoped Route-4 branch filters events on ARCHIVED plantings', () => {
    expect(ladderBranches()[1]).toMatch(ARCHIVED_PLANTING_FILTER);
  });

  // MUTATION: delete it from the bare branch -> RED. No client sends this shape today, which is
  // exactly why it would rot unnoticed.
  it('the bare (unscoped) Route-4 branch filters events on ARCHIVED plantings', () => {
    expect(ladderBranches()[2]).toMatch(ARCHIVED_PLANTING_FILTER);
  });

  // The container axis was already correct; pinned so a lane reworking this WHERE clause cannot
  // trade one axis for the other and still pass the assertions above.
  it('the feed still filters the CONTAINER archive axis too (both axes, not one)', () => {
    expect(feedRoute()).toMatch(/pp\.archived_at IS NULL/);
  });
});

describe('events Lambda — V4-ARCHIVEHIDE-001 L1, the exemption is deliberate', () => {
  // MUTATION: ADD the predicate to either plant-scoped shape -> RED. An archived planting's own
  // detail page would render an empty log next to its Unarchive button.
  it('the plant_id-only arm is EXEMPT (naming a planting is the deliberate request for it)', () => {
    expect(plantOnlyArm()).not.toMatch(ARCHIVED_PLANTING_FILTER);
  });

  it('the project_id + plant_id branch is EXEMPT for the same reason', () => {
    expect(ladderBranches()[0]).not.toMatch(ARCHIVED_PLANTING_FILTER);
  });
});

describe('events Lambda — the two axes stay separate', () => {
  // MUTATION: rewrite the predicate as `ga.deleted_at IS NOT NULL` (or fold archived into the
  // existing deleted_at predicate) -> RED. Soft-delete and archive have different recovery
  // surfaces; a merged predicate makes the archived rows unreachable by unarchive.
  it('the filter tests archived_at, and the soft-delete predicate is still present alongside it', () => {
    for (const q of [feedRoute(), ladderBranches()[1], ladderBranches()[2]]) {
      expect(q).toMatch(/ga\.archived_at IS NOT NULL/);
      expect(q).toMatch(/e\.deleted_at IS NULL/);
    }
  });

  // The switch subquery in these same WHERE clauses binds `gn`. A same-named alias here would be
  // shadowed inside it, which is silent and wrong rather than loud and wrong.
  it('uses an alias distinct from the deleted-planting switch subquery (no shadowing)', () => {
    expect(SRC).not.toMatch(/SELECT 1 FROM public\.garden_node gn\s*\n?\s*WHERE gn\.id = e\.plant_id AND gn\.archived_at/);
  });

  // NOT EXISTS, not a join or an EXISTS-is-null-safe rewrite: an event with no plant_id, and an
  // event whose planting row is invisible to this query, must both STAY on the surface. An inner
  // join would drop every project-level event in the garden.
  it('is NOT EXISTS, so unanchored events are not collateral', () => {
    for (const q of [feedRoute(), ladderBranches()[1], ladderBranches()[2]]) {
      expect(q).toMatch(/AND NOT EXISTS \(SELECT 1 FROM public\.garden_node ga/);
    }
  });
});
