import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// V4-SEEDORIGIN-001. Modelled directly on household-copies-sync.test.js, for the same reason:
// each Lambda is zipped from its own directory, so a `../preservation/provenance.js` import 502s
// the deployed handler. Copies are the fix; drift is the cost, and this file is the guard.
//
// WHY IT MATTERS MORE HERE THAN FOR household.js. provenance.js is a shared VOCABULARY, and this
// schema has already fragmented a provenance vocabulary once — plants.source_type, v4-source-freetext,
// 2026-07-07 — which is recorded in the canonical module's own header. VALID_SOURCE_KINDS now has
// four synchronised homes:
//   1. lambda/preservation/provenance.js        (canonical)
//   2. lambda/inventory-items/provenance.js     (this copy — guarded here)
//   3. chk_inventory_source_kind + chk_preservation_log_source_kind  (DB, guarded by migration gates)
//   4. PUTUP_SOURCE_OPTIONS in src/lib/dropdownRegistry.js (guarded by preservationProvenance.test.js)
// Each leg has a gate. This is the one that was missing when the copy was made.
const here = dirname(fileURLToPath(import.meta.url));

const CANONICAL = 'preservation';
const DIRS = ['inventory-items'];

describe('provenance.js per-Lambda copies stay in sync with canonical', () => {
  const canonical = readFileSync(join(here, CANONICAL, 'provenance.js'), 'utf8');

  for (const d of DIRS) {
    it(`${d}/provenance.js === canonical ${CANONICAL}/provenance.js`, () => {
      const copy = readFileSync(join(here, d, 'provenance.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }

  it('DIRS enumerates EVERY dir that ships a provenance.js copy', () => {
    // The list above is hand-maintained; an unlisted copy is invisible to the byte-equality checks
    // and can drift to a stale vocabulary in prod. Derive the truth from disk instead — this is the
    // assertion household-copies-sync.test.js gained only AFTER daily-plan-read drifted unguarded.
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((d) => d !== CANONICAL && existsSync(join(here, d, 'provenance.js')))
      .sort();
    expect(onDisk).toEqual([...DIRS].sort());
  });

  it('the copy actually exports the vocabulary the handler imports', () => {
    // Byte-equality alone would still pass if BOTH files were emptied. This pins the payload, so an
    // emptied or renamed export reds rather than silently agreeing.
    const copy = readFileSync(join(here, 'inventory-items', 'provenance.js'), 'utf8');
    expect(copy).toMatch(/export const VALID_SOURCE_KINDS/);
    for (const v of ['own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other']) {
      expect(copy).toContain(`'${v}'`);
    }
  });
});
