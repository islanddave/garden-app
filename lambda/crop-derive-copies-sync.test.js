import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
});
