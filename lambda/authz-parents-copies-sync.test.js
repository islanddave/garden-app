import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Mirrors household-copies-sync.test.js. Each Lambda is zipped from its own dir, so
// authz-parents.js is copied per-dir and imported as ./authz-parents.js. These copies MUST stay
// byte-identical to the canonical lambda/authz-parents.js — a drifted copy means one endpoint
// silently enforces a WEAKER ownership predicate than its siblings, which is the exact failure
// class the file exists to close.
//
// DIRS is asserted against the filesystem (not just iterated) so a newly added copy cannot go
// unguarded — that is how daily-plan-read drifted for household.js.
const here = dirname(fileURLToPath(import.meta.url));
// 'events' joined on 2026-08-04: the events lane gated POST /api/events on the same three parents
// (project_id, plant_id AND location_id) using inline copies of these predicates, guarded by its own
// comment-stripped comparison in lambda/events/events-authz.test.js. Dropping the canonical file
// into that dir is step 1 of retiring those inline copies; step 3 — swapping them for an import in
// lambda/events/index.js — is the events lane's edit, not this one's.
// 'projects', 'varieties' and 'evidence-ingest' joined on 2026-08-10 (BUG-AUTHZFKENUM-001), each
// because it gained a body-settable parent FK that needs the canonical predicate: projects PUT
// parent_project_id, varieties POST source_proj_rescope_project_id (both loadOwnedProject), and
// evidence-ingest garden_node_id + the planting-typed arm of entity_id (loadOwnedPlantingRef).
const DIRS = ['events', 'evidence-ingest', 'photos', 'plants', 'projects', 'varieties'];

describe('authz-parents.js per-Lambda copies stay in sync with canonical', () => {
  const canonical = readFileSync(join(here, 'authz-parents.js'), 'utf8');
  for (const d of DIRS) {
    it(`${d}/authz-parents.js === canonical lambda/authz-parents.js`, () => {
      const copy = readFileSync(join(here, d, 'authz-parents.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }

  it('DIRS enumerates EVERY dir that ships an authz-parents.js copy', () => {
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(d => existsSync(join(here, d, 'authz-parents.js')))
      .sort();
    expect(onDisk).toEqual([...DIRS].sort());
  });
});
