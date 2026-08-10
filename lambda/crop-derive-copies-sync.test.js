import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// crop-derive.js is the shared V4-TAGSUB derive engine. Each Lambda is zipped from its own dir, so a ../
// import is NOT packaged — the engine is copied byte-identically into the dirs that need it. These copies
// MUST stay identical (same constraint + fix as household-copies-sync.test.js). lambda/tags is canonical.
const here = dirname(fileURLToPath(import.meta.url));
const DIRS = ['tags', 'varieties'];

describe('crop-derive.js per-Lambda copies stay byte-identical', () => {
  const canonical = readFileSync(join(here, 'tags', 'crop-derive.js'), 'utf8');
  for (const d of DIRS) {
    it(`${d}/crop-derive.js === lambda/tags/crop-derive.js (canonical)`, () => {
      const copy = readFileSync(join(here, d, 'crop-derive.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }

  // Coverage floor. DIRS above was hand-maintained with no tie to the filesystem, so it failed
  // OPEN: a dir that starts shipping a copy produces no test at all, and the drift is invisible in
  // a green suite. That is exactly how daily-plan-read drifted for household.js
  // (V4-AUTHZSWEEP-001, 2026-07-31). Turns red on the mutation `printf ... > lambda/plants/crop-derive.js`
  // — a drifted copy in a dir nobody remembered to list, which the byte-equality loop above passes through.
  it('DIRS enumerates EVERY dir that ships a crop-derive.js copy', () => {
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(d => existsSync(join(here, d, 'crop-derive.js')))
      .sort();
    expect(onDisk).toEqual([...DIRS].sort());
  });
});
