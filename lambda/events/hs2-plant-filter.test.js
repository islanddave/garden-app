// HS-2 (V002 §4 / Lane C — V3-NAV-001): the events LIST endpoint must support a server-side
// &plant_id= filter so a planting's event log is scoped on the DB side BEFORE the LIMIT 200 cap.
// Client-side filtering over a 200-row window would silently drop a busy planting's older events
// → false "no events". Static-source (L-072), DB-free — mirrors household-mode.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('events Lambda — HS-2 server-side plant_id filter', () => {
  it('reads plant_id from query string params', () => {
    expect(SRC).toMatch(/const plantId = event\.queryStringParameters\?\.plant_id \?\? null;/);
  });

  it('branches on (projectId && plantId) for the planting-scoped query', () => {
    expect(SRC).toMatch(/const rows = \(projectId && plantId\)/);
  });

  it('the planting-scoped query filters by e.plant_id', () => {
    expect(SRC).toMatch(/AND e\.plant_id = \$\{plantId\}/);
  });

  // ROUTE-SCOPED ANCHOR (hardened 2026-07-21). These assertions previously used a GLOBAL
  // SRC.indexOf('AND e.plant_id = ${plantId}') first-match. index.js has since grown routes
  // containing near-identical predicates (harvest-summary carries
  // `WHERE e.plant_id = ${plantId}::uuid`), and any future route inserted ABOVE the list route with
  // a literal `AND e.plant_id = ${plantId}` would silently RE-TARGET these asserts at foreign SQL
  // while still passing — the filter-precedes-cap check would find some other LIMIT and go green.
  // Anchoring to the list route's own branch marker makes that class of drift impossible.
  const listRouteFrom = () => {
    const branchIdx = SRC.indexOf('const rows = (projectId && plantId)');
    expect(branchIdx, 'list-route branch marker not found — update this anchor').toBeGreaterThan(-1);
    return SRC.slice(branchIdx);
  };

  it('the plant_id filter is applied BEFORE the LIMIT (so the cap scopes to the planting)', () => {
    const route = listRouteFrom();
    const plantIdx = route.indexOf('AND e.plant_id = ${plantId}');
    expect(plantIdx, 'plant_id predicate not found inside the list route').toBeGreaterThan(-1);
    // The very next LIMIT after the plant_id predicate must follow it (filter precedes cap).
    const after = route.slice(plantIdx);
    const limitIdx = after.indexOf('LIMIT ${limit}');
    expect(limitIdx).toBeGreaterThan(-1);
    // And no second plant_id predicate sneaks in after that LIMIT within this block.
    expect(after.slice(0, limitIdx)).toMatch(/AND e\.deleted_at IS NULL/);
  });

  it('still household-scoped (does not leak another household\'s planting events)', () => {
    const route = listRouteFrom();
    const plantIdx = route.indexOf('AND e.plant_id = ${plantId}');
    expect(plantIdx).toBeGreaterThan(-1);
    const block = route.slice(Math.max(0, plantIdx - 300), plantIdx);
    expect(block).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('preserves the project-only (no plant_id) branch as a fallback', () => {
    expect(SRC).toMatch(/: projectId\s*\n\s*\? await sql`/);
  });
});

// BUG-UNSCOPEDPLANTLOG-001 — plant_id WITHOUT project_id.
//
// The guards above only ever asserted the TWO-param path, which is why this shipped: the ladder
// was (projectId && plantId) → projectId → unfiltered, so plant_id alone matched no guard and fell
// through to the household feed with plantId read-but-unused. Every assertion here is about the
// arm that catches that shape BEFORE the ladder. Behavioural proof lives in
// tests/integration/events.int.test.js (real handler, real rows); these are the cheap static
// guards that fail in the unit suite the moment the arm is removed or reordered.
describe('events Lambda — plant_id-only list scope (BUG-UNSCOPEDPLANTLOG-001)', () => {
  const armFrom = () => {
    const idx = SRC.indexOf('if (plantId && !projectId) {');
    expect(idx, 'plant_id-only arm not found — the list route would fall through to the unfiltered feed').toBeGreaterThan(-1);
    return SRC.slice(idx);
  };

  it('has a dedicated arm for plant_id without project_id', () => {
    expect(SRC).toMatch(/if \(plantId && !projectId\) \{/);
  });

  // ORDERING IS THE WHOLE BUG. An arm that sits BELOW the ladder is dead code — the ladder's
  // final `: await sql` catch-all consumes the request first and returns the feed.
  it('the arm precedes the branch ladder (below it, the catch-all wins and the bug is back)', () => {
    const armIdx = SRC.indexOf('if (plantId && !projectId) {');
    const ladderIdx = SRC.indexOf('const rows = (projectId && plantId)');
    expect(armIdx).toBeGreaterThan(-1);
    expect(ladderIdx).toBeGreaterThan(-1);
    expect(armIdx).toBeLessThan(ladderIdx);
  });

  it('filters on e.plant_id and returns from inside the arm (never falls through)', () => {
    const arm = armFrom();
    const filterIdx = arm.indexOf('WHERE e.plant_id = ${plantId}');
    expect(filterIdx, 'plant_id predicate missing from the plant_id-only arm').toBeGreaterThan(-1);
    const returnIdx = arm.indexOf('return resp(200, plantRows);');
    expect(returnIdx).toBeGreaterThan(filterIdx);
    // The predicate precedes the cap, same invariant as HS-2 above.
    expect(arm.slice(filterIdx, returnIdx)).toMatch(/LIMIT \$\{limit\}/);
  });

  it('authorizes through the PLANTING, not the container (there is no project to join)', () => {
    const arm = armFrom();
    const gateIdx = arm.indexOf('loadOwnedPlantingRef(sql, plantId, householdIds)');
    expect(gateIdx, 'ownership gate missing — the arm would serve any household\'s planting').toBeGreaterThan(-1);
    // The gate must run BEFORE the query, and deny with a 404 rather than falling onward.
    expect(gateIdx).toBeLessThan(arm.indexOf('WHERE e.plant_id = ${plantId}'));
    expect(arm.slice(gateIdx, gateIdx + 200)).toMatch(/return resp\(404/);
  });

  // A project-less planting's events carry project_id NULL. The INNER join the other two branches
  // use drops all of them, which turns "shows the whole garden" into "shows nothing" — quieter,
  // equally wrong, and much harder to notice.
  it('joins the container LEFT so project_id-NULL rows survive', () => {
    const arm = armFrom();
    const joinIdx = arm.indexOf('LEFT JOIN public.container pp ON pp.id = e.project_id');
    expect(joinIdx, 'inner join would drop every event of a project-less planting').toBeGreaterThan(-1);
    expect(joinIdx).toBeLessThan(arm.indexOf('return resp(200, plantRows);'));
  });

  it('still household-scoped on rows that DO have a container', () => {
    const arm = armFrom();
    const block = arm.slice(0, arm.indexOf('return resp(200, plantRows);'));
    expect(block).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(block).toMatch(/AND e\.deleted_at IS NULL/);
  });
});
