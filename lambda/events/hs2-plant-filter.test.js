// HS-2 (V002 §4 / Lane C — V3-NAV-001): the events LIST endpoint must support a server-side
// &plant_id= filter so a planting's event log is scoped on the DB side BEFORE the LIMIT 200 cap.
// Client-side filtering over a 200-row window would silently drop a busy planting's older events
// → false "no events". Static-source (L-072), DB-free — mirrors household-mode.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

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
