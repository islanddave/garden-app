import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Each Lambda is zipped from its own dir, so household.js is copied per-dir and imported
// as ./household.js. These copies MUST stay byte-identical to the canonical lambda/household.js.
// (Caught 2026-05-20: ../household.js import 502'd the deployed handlers — copies are the fix.)
const here = dirname(fileURLToPath(import.meta.url));
// 'daily-plan-read' was missing from this list while shipping a copy of household.js — it drifted
// silently (V4-AUTHZSWEEP-001, 2026-07-31). The enumeration below is now asserted to match the
// filesystem, so the next added copy cannot go unguarded the same way.
// 'evidence-ingest' joined on 2026-08-10 (BUG-AUTHZFKENUM-001): it writes evidence.garden_node_id
// and evidence.entity_id straight from the request body and had NO household scoping at all, so it
// needed householdScope + warnRejectedFk for the first time.
const DIRS = ['projects', 'plants', 'events', 'inventory-items', 'photos', 'dashboard', 'locations', 'critter', 'findings', 'tags', 'storage-location', 'preservation', 'harvests', 'facebook-share', 'members', 'daily-plan-read', 'varieties', 'evidence-ingest'];

describe('household.js per-Lambda copies stay in sync with canonical', () => {
  const canonical = readFileSync(join(here, 'household.js'), 'utf8');
  for (const d of DIRS) {
    it(`${d}/household.js === canonical lambda/household.js`, () => {
      const copy = readFileSync(join(here, d, 'household.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }

  it('DIRS enumerates EVERY dir that ships a household.js copy', () => {
    // The list above is hand-maintained; an unlisted copy is invisible to the byte-equality checks
    // and can drift to a stale authz predicate in prod. Derive the truth from disk instead.
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(d => existsSync(join(here, d, 'household.js')))
      .sort();
    expect(onDisk).toEqual([...DIRS].sort());
  });
});
