import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

  // Coverage floor. DIRS above was hand-maintained with no tie to the filesystem, so it failed
  // OPEN: a dir that starts shipping a copy produces no test at all, and the ON-cutover signing
  // drift this file exists to catch stays invisible in a green suite — the same silent-drift shape
  // that hit household.js/daily-plan-read (V4-AUTHZSWEEP-001, 2026-07-31). Turns red on the mutation
  // `printf ... > lambda/tags/photo-access.js` — a drifted copy in an unlisted dir.
  it('DIRS enumerates EVERY dir that ships a photo-access.js copy', () => {
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(d => existsSync(join(here, d, 'photo-access.js')))
      .sort();
    expect(onDisk).toEqual([...DIRS].sort());
  });
});
