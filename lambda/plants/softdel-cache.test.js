// BUG-CACHEORPHANLEAK-001 — soft-deleting a planting must take its care-cache row with it,
// and must only be able to do so for a planting the caller actually owns.
//
// THE LEAK. `scripts/integrity-weekly-check.sh`'s `entity_memory_orphans` metric counts, as an
// ORPHAN, exactly `em.plant_id IS NOT NULL AND NOT EXISTS (plants p WHERE p.id = em.plant_id AND
// p.deleted_at IS NULL)`. DELETE /api/plants/:id soft-deleted the planting and left the cache row
// standing, so every soft-delete of a planting that HAS a cache row ratchets a shipped alert metric
// by one, permanently. Measured on prod 2026-08-10 (dev be610ee): 1 of 33 soft-deleted plantings
// carries a cache row — the other 32 predate the plant-keyed cache — and that single one is the
// entire gap between the metric's live value (5) and its committed baseline (4). Monotonic: the
// next soft-delete of a live planting adds another forever.
//
// THE AUTHORIZATION HAZARD, which is why this file exists rather than just a one-line fix.
// The obvious repair is a second statement, `DELETE FROM entity_memory WHERE plant_id = $1`. That
// carries NO ownership predicate and would turn this route into a cross-household write primitive:
// any authenticated caller could erase any planting's care cache by id. Worse, it would be silent —
// this route returns `{ok:true}` regardless of rows affected (a pre-existing contract quirk noted in
// the handler), so nothing would surface it. Driving the delete off the UPDATE's RETURNING binds it
// to the ownership predicate that was already proven, in one statement.
//
// Rehearsed against live prod inside BEGIN/ROLLBACK, both directions:
//   correct household -> soft-deletes AND `DELETE 1`, cache row gone
//   foreign household -> `DELETE 0`, cache row survives, planting still live
//
// Source-text rather than behavioural: this is the plants handler, not a pure builder, and it
// cannot be imported in CI (per-dir node_modules do not exist there). The house convention for
// handler assertions is to read index.js as text.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
// Comments stripped before matching: this file's rationale is mirrored in the handler's own
// comment block, and a bare substring test would match the prose and pass on a broken handler.
const CODE = SRC.replace(/--[^\n]*/g, '').replace(/\/\/[^\n]*/g, '');

// The DELETE branch only. Bounded to the branch so a match cannot be satisfied from the PUT or the
// archive route — the extractor-swallows-too-much defect that let a deleted column pass
// projects/select-columns from an entirely different statement.
function deleteBranch(src) {
  const start = src.indexOf("if (method === 'DELETE')");
  if (start < 0) return null;
  const end = src.indexOf("return resp(405", start);
  return end > start ? src.slice(start, end) : src.slice(start);
}

describe('BUG-CACHEORPHANLEAK-001 — the soft-delete drops the cache row', () => {
  const branch = deleteBranch(CODE);

  it('the DELETE branch is findable and bounded', () => {
    expect(branch, 'DELETE branch not found in the plants handler').toBeTruthy();
    // Vacuity floor: an empty or truncated slice would make every assertion below pass trivially.
    expect(branch.length).toBeGreaterThan(200);
  });

  // MUTATION: drop the `DELETE FROM public.entity_memory` clause -> RED. That is the leak returning.
  it('deletes the plant-keyed entity_memory row', () => {
    expect(branch).toMatch(/DELETE FROM public\.entity_memory/);
    expect(branch).toMatch(/em\.plant_id\s*=\s*gone\.id/);
  });

  // MUTATION: split it into a standalone `DELETE ... WHERE plant_id = ${plantId}` -> RED.
  // THIS IS THE SECURITY ASSERTION. The cache delete must be driven off the UPDATE's RETURNING,
  // so it inherits the ownership predicate rather than trusting a caller-supplied id.
  it('drives the cache delete off the UPDATE RETURNING, not off the raw path id', () => {
    expect(branch).toMatch(/WITH gone AS \(/);
    expect(branch).toMatch(/RETURNING p\.id/);
    // the id bind must NOT appear in the DELETE's own predicate
    const del = branch.slice(branch.indexOf('DELETE FROM public.entity_memory'));
    expect(del).not.toMatch(/\$\{plantId\}/);
  });

  // MUTATION: remove either ownership arm from the UPDATE -> RED. The cache delete is only as safe
  // as the predicate it inherits, so that predicate is asserted here too rather than assumed.
  it('the UPDATE still carries both household ownership arms', () => {
    expect(branch).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(branch).toMatch(/p\.container_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(branch).toMatch(/p\.deleted_at IS NULL/);
  });
});
