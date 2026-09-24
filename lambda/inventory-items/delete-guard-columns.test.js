// BUG-INVREFSTRAND-001 — column contract for the two relations the pre-delete check reads
// (L-081 Phase 1, keyed form).
//
// WHY THIS FILE EXISTS. delete-guard.js is the first code in this Lambda to read public.plants and
// public.event_log (every planting read before it goes through the garden_node view). The schema
// audit's Phase 4 census counts, per Lambda directory, every relation a non-test .js names in a sql``
// template, and a relation with no declared columns is audited by nothing — the shape that let a
// seed-detail SELECT name a column garden_node does not have and 500 every packet page in prod
// (BUG-SEEDDETAIL500-001). The fix is coverage, never a bump of scripts/schema-audit-join-baseline.json.
//
// ITS OWN FILE, KEYED FORM, AND THE NAME ENDS IN `columns.test.js` — all three load-bearing:
// parse_test_file returns on a keyed `AUDIT_COLUMNS` literal first (so a block dropped into an existing
// contract would silently replace that file's coverage), Phase 4 groups by the file's directory, and
// the discovery glob is `*columns.test.js`. See seed-stage-columns.test.js for the same reasoning.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — the sibling contracts' decomment step.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'delete-guard.js'), 'utf8'));
const SQL = (SRC.match(/sql`[\s\S]*?`/g) ?? []).join('\n');

// Keyed contract: per-relation, no cross-product. Only the columns the preflight NAMES.
const AUDIT_COLUMNS = {
  plants: ['source_inventory_item_id', 'deleted_at', 'archived_at'],
  event_log: ['treatment_product_id', 'deleted_at'],
};

describe('delete-guard SELECT-column contract (L-081 Phase 1, keyed form)', () => {
  it('uses the KEYED form, one key per relation the preflight reads besides inventory_items', () => {
    expect(SRC).not.toMatch(/const\s+AUDIT_TABLES\s*=/);
    expect(Object.keys(AUDIT_COLUMNS).sort()).toEqual(['event_log', 'plants']);
    const read = [...SQL.matchAll(/FROM public\.(\w+)/g)].map((m) => m[1]).filter((t) => t !== 'inventory_items');
    expect([...new Set(read)].sort()).toEqual(Object.keys(AUDIT_COLUMNS).sort());
  });

  it('every audited column is genuinely named against its own relation in the preflight', () => {
    // Stops this file becoming a fiction: a column the SQL no longer touches would keep passing the
    // prod audit while auditing nothing real. Aliases: plants p, event_log e.
    const alias = { plants: 'p', event_log: 'e' };
    for (const [table, cols] of Object.entries(AUDIT_COLUMNS)) {
      expect(SQL, `the preflight no longer reads ${table}`).toMatch(new RegExp(`FROM public\\.${table} ${alias[table]}\\b`));
      const missing = cols.filter((c) => !new RegExp(`\\b${alias[table]}\\.${c}\\b`).test(SQL));
      expect(missing, `${table}`).toEqual([]);
    }
  });

  it('pins a non-trivial contract — an emptied array must fail, not silently pass', () => {
    expect(AUDIT_COLUMNS.plants.length).toBeGreaterThanOrEqual(3);
    expect(AUDIT_COLUMNS.event_log.length).toBeGreaterThanOrEqual(2);
  });
});
