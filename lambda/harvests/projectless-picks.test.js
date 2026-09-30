// BUG-HARVESTSNOPROJECTPICKS-001 — the Harvests page must count picks logged on events with no project.
//
// event_log.project_id has been nullable since care-rekey-001, and a pick on a project-less planting
// is a plant-only event. The three read models (entries, aggregates, weight totals) INNER-joined
// plant_projects, so those picks vanished from the Log and from every total: 6 of 1,761
// grow-year-2026 picks on prod 2026-09-29, found because Season stats (stat_pick, which falls back
// to the event's created_by) counted all 1,761 and Harvests did not.
//
// Static, like archive-hide.test.js beside it: index.js imports its runtime deps at module load and
// cannot be imported under `npm ci`. Every assertion is a COUNT of three, because a fix in two of the
// three queries is the shape that makes a total disagree with the rows under it. The real-DB proof
// is tests/integration/harvests.int.test.js ("project-less picks").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const count = (re) => (SRC.match(re) || []).length;

describe('harvests Lambda — project-less picks are in the read models', () => {
  it('all three read models LEFT JOIN plant_projects', () => {
    expect(count(/LEFT JOIN plant_projects pj ON pj\.id = e\.project_id/g)).toBe(3);
  });

  it('no read model inner-joins plant_projects any more', () => {
    expect(SRC).not.toMatch(/(^|\n)\s*JOIN plant_projects pj ON pj\.id = e\.project_id/);
  });

  it('all three scope with the two-arm predicate: the project owner, else the logger when there is no project', () => {
    expect(count(
      /AND \(pj\.created_by = ANY\(\$\{householdIds\}\)\s*OR \(e\.project_id IS NULL AND e\.created_by = ANY\(\$\{householdIds\}\)\)\)/g,
    )).toBe(3);
  });

  // The fallback arm is gated on `e.project_id IS NULL`. A bare COALESCE(pj.created_by, e.created_by)
  // would also adopt an event whose project_id points at a missing row; the gate keeps that closed.
  it('no bare pj.created_by scope and no ungated created_by fallback is left behind', () => {
    expect(count(/AND pj\.created_by = ANY\(\$\{householdIds\}\)\s*\n/g)).toBe(0);
    expect(SRC).not.toMatch(/COALESCE\(pj\.created_by, e\.created_by\)/);
  });
});
