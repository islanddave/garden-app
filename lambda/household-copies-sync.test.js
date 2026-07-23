import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Each Lambda is zipped from its own dir, so household.js is copied per-dir and imported
// as ./household.js. These copies MUST stay byte-identical to the canonical lambda/household.js.
// (Caught 2026-05-20: ../household.js import 502'd the deployed handlers — copies are the fix.)
const here = dirname(fileURLToPath(import.meta.url));
const DIRS = ['projects', 'plants', 'events', 'inventory-items', 'photos', 'dashboard', 'locations', 'critter', 'findings', 'tags', 'storage-location', 'preservation', 'harvests'];

describe('household.js per-Lambda copies stay in sync with canonical', () => {
  const canonical = readFileSync(join(here, 'household.js'), 'utf8');
  for (const d of DIRS) {
    it(`${d}/household.js === canonical lambda/household.js`, () => {
      const copy = readFileSync(join(here, d, 'household.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }
});
