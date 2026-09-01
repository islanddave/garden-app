// V4-SEEDSAVEFLOW-001 — SELECT-column contract for seed_lot_stage_log (L-081 Phase 1).
//
// WHY A SEPARATE FILE. inventory-items/select-columns.test.js declares
// `AUDIT_TABLES = ['inventory_items']`, and under that form the auditor cross-products EVERY column
// array in the file against EVERY declared table. Adding seed_lot_stage_log's columns there would
// therefore assert that `stage`, `entered_at` and `note` exist on inventory_items — they do not, and
// the audit would go red for a correct handler. That cross-product is the documented structural
// reason every file in this repo declared exactly one table, and therefore why joined relations went
// unaudited (see the auditor's Phase 4 census).
//
// USES THE KEYED FORM, which exists for exactly this. `AUDIT_COLUMNS = { table: [...] }` binds each
// array to ONE named relation with no cross-product (added 2026-08-28, BUG-SEEDDETAIL500-001 class).
//
// THE FILENAME IS LOad-BEARING. The auditor's discovery glob is `*columns.test.js` — it was
// `select-columns.test.js` until 2026-08-28, and that narrower pattern made
// garden-node-columns.test.js invisible on the very day it was written, so the guard guarded
// nothing. `seed-stage-columns.test.js` matches the current glob; renaming it to anything not
// ending in `columns.test.js` silently un-audits this relation.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — same decomment step the sibling contract
// uses, and for the same reason: deleting live code and leaving `// was: entered_at` behind must not
// keep satisfying these assertions.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const SQL = (SRC.match(/sql`[\s\S]*?`/g) ?? []).join('\n');

// Keyed contract: per-relation, no cross-product.
const AUDIT_COLUMNS = {
  seed_lot_stage_log: [
    'id',
    'inventory_item_id',
    'stage',
    'entered_at',
    'note',
    'created_by',
    'created_at',
  ],
};

describe('seed_lot_stage_log SELECT-column contract (L-081 Phase 1, keyed form)', () => {
  it('uses the KEYED form, not AUDIT_TABLES — the cross-product would be wrong here', () => {
    // Guards the choice itself. If someone converts this file to AUDIT_TABLES to "match the
    // sibling", the auditor starts demanding these columns exist on inventory_items.
    expect(SRC).not.toMatch(/const\s+AUDIT_TABLES\s*=/);
    expect(Object.keys(AUDIT_COLUMNS)).toEqual(['seed_lot_stage_log']);
  });

  it('every audited column is genuinely referenced in this handler\'s SQL', () => {
    // Stops this file becoming a fiction: an array naming columns the SQL no longer touches would
    // keep passing the prod audit while auditing nothing real.
    const missing = AUDIT_COLUMNS.seed_lot_stage_log.filter(
      (c) => !new RegExp(`\\b${c}\\b`).test(SQL),
    );
    expect(missing).toEqual([]);
  });

  it('pins a non-trivial contract — an emptied array must fail, not silently pass', () => {
    expect(AUDIT_COLUMNS.seed_lot_stage_log.length).toBeGreaterThanOrEqual(7);
  });

  it('the handler actually queries seed_lot_stage_log', () => {
    expect(SQL).toMatch(/\bseed_lot_stage_log\b/);
  });

  it('the stage write and the lot update are ONE statement, not two', () => {
    // The atomicity property in structural form. A stage entry without the matching seed_stage on
    // the lot shows history the list view contradicts; the reverse moves the lot with no record of
    // when. Splitting the CTE into two awaited statements would reintroduce exactly that window,
    // and nothing else in the suite would notice.
    expect(SQL).toMatch(/WITH upd AS \(\s*UPDATE public\.inventory_items/);
    expect(SQL).toMatch(/INSERT INTO public\.seed_lot_stage_log[\s\S]*?FROM upd/);
  });
});
