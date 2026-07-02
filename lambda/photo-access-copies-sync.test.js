import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// V4-PHOTOCDN-001 P1: each Lambda is zipped from its own dir, so photo-access.js is copied per-dir
// and imported as ./photo-access.js. These copies MUST stay byte-identical to the canonical
// lambda/photo-access.js — a drift silently diverges the ON-cutover signing behavior across surfaces.
const here = dirname(fileURLToPath(import.meta.url));
const DIRS = ['photos', 'plants', 'projects', 'locations', 'inventory-items'];

describe('photo-access.js per-Lambda copies stay in sync with canonical', () => {
  const canonical = readFileSync(join(here, 'photo-access.js'), 'utf8');
  for (const d of DIRS) {
    it(`${d}/photo-access.js === canonical lambda/photo-access.js`, () => {
      const copy = readFileSync(join(here, d, 'photo-access.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }
});
