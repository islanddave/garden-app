import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VALID_SOURCE_KINDS as CANONICAL } from './preservation/provenance.js';
import { VALID_SOURCE_KINDS as INVENTORY_COPY } from './inventory-items/source-kinds.js';

// V4-SEEDORIGIN-001. Sibling of household-copies-sync.test.js, same root cause: each Lambda is
// zipped from its own directory, so a cross-directory import 502s the deployed handler. Copies are
// the fix; drift is the cost; this is the guard.
//
// GUARDED BY VALUE, NOT BY BYTES — and that is a deliberate difference from the household.js
// precedent. household.js is copied whole because the whole module is used. provenance.js is not:
// lambda/inventory-items uses only the vocabulary, and a whole-file copy dragged
// preservation_log's `plant_id` and `harvest_log_id` into this Lambda's FK surface, which
// lambda/authz-write-fk.test.js correctly flagged as two body-settable FKs with no ownership
// decision. The narrow copy blinds no guard. See lambda/inventory-items/source-kinds.js for the
// full reasoning.
//
// A value check is also strictly stronger on the thing that matters: byte-equality passes if BOTH
// files are emptied, deep equality does not.
//
// WHY IT MATTERS MORE HERE THAN FOR household.js: this is a shared VOCABULARY, and this schema has
// already fragmented a provenance vocabulary once (plants.source_type, v4-source-freetext,
// 2026-07-07), recorded in the canonical module's own header.
const here = dirname(fileURLToPath(import.meta.url));

const CANONICAL_DIR = 'preservation';
// Every directory that ships its own copy of the vocabulary, and the array it exports.
const COPIES = [['inventory-items', INVENTORY_COPY]];

describe('VALID_SOURCE_KINDS copies stay in sync with canonical', () => {
  it('canonical exports the eight shipped kinds, in order', () => {
    // Pins the payload itself. Without this, every equality check below is satisfied by two
    // identically-wrong arrays — including two empty ones.
    expect(CANONICAL).toEqual([
      'own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other',
    ]);
  });

  for (const [dir, copy] of COPIES) {
    it(`${dir}/source-kinds.js === canonical ${CANONICAL_DIR}/provenance.js`, () => {
      expect(copy).toEqual(CANONICAL);
    });
  }

  it('the DB CHECK membership in the migration matches the JS vocabulary', () => {
    // The third leg of the sync. The migration's post_vocabulary_exact gate asserts the LIVE
    // constraint matches this list; this asserts the migration FILE does, so a drift is caught in
    // CI before anyone applies it anywhere.
    const ddl = readFileSync(
      join(here, '..', 'migrations', 'v4-seedorigin-001', '0a-additive-ddl.sql'), 'utf8');
    const m = ddl.match(/CHECK \(source_kind IS NULL OR source_kind = ANY \(ARRAY\[([\s\S]*?)\]\)\)/);
    expect(m, 'membership CHECK not found in v4-seedorigin-001/0a-additive-ddl.sql').toBeTruthy();
    const inSql = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(inSql).toEqual(CANONICAL);
  });

  it('COPIES enumerates EVERY dir that ships a vocabulary copy', () => {
    // Hand-maintained lists rot. household-copies-sync.test.js gained this assertion only AFTER
    // daily-plan-read shipped an unguarded copy and drifted (V4-AUTHZSWEEP-001). Derive from disk.
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((d) => d !== CANONICAL_DIR && existsSync(join(here, d, 'source-kinds.js')))
      .sort();
    expect(onDisk).toEqual(COPIES.map(([d]) => d).sort());
  });
});
