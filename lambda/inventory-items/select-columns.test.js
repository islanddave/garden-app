// OPS-L081COLS-001 — static SELECT-column contract for inventory-items.
//
// WHY THIS FILE EXISTS: scripts/dev-main-schema-audit.py Phase 1 audits SELECT columns against prod's
// information_schema by reading lambda/**/select-columns.test.js. A Lambda with no such file is
// audited for NOTHING in Phase 1 and the job still reports green — the vacuous-gate problem this
// ledger row records ("worse than an absent one because it gets cited as evidence").
//
// inventory-items was one of the three entrypoints BUG-LAMBDASYNTAX-001 silently truncated, and it
// carries the widest column surface of any small Lambda (33 of 36 prod columns referenced in SQL) —
// the most places for an L-081 staging/prod divergence to hide.
//
// The column list below is EVIDENCE-DERIVED, not hand-guessed: it is the intersection of inventory_items's
// live prod columns with the identifiers actually appearing inside this handler's sql`` templates
// (comments stripped first). Every entry was verified present in prod by running the audit.
//
// Static source inspection rather than import: lambda/inventory-items/index.js loads @neondatabase/serverless
// and @clerk/backend at module scope, so it cannot be imported under `npm ci` in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — without this, deleting live code and
// leaving `// was: sow_archived_at` behind would still satisfy the assertions below.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
// Only the SQL. The audit's contract is about COLUMNS, and a bare identifier elsewhere in the file
// is a JavaScript variable, not a column reference — `name`, `type`, `status` and `source` all occur
// as both in this codebase.
const SQL = (SRC.match(/sql`[\s\S]*?`/g) ?? []).join('\n');

// L-081 declared contract (Phase 1): the prod relation every `*_COLUMNS` array here must exist in.
// ONE table, deliberately — the auditor cross-products every collected array against every declared
// table, so a second relation here would demand this table's columns exist on it too.
const AUDIT_TABLES = ['inventory_items'];

const INVENTORY_ITEMS_COLUMNS = [
  'id',
  'user_id',
  'type',
  'name',
  'category',
  'location_id',
  'location_text',
  'source',
  'source_url',
  'purchase_date',
  'unit_cost',
  'unit',
  'quantity_purchased',
  'notes',
  'tags',
  'status',
  'deleted_at',
  'quantity_on_hand',
  'reorder_threshold',
  'reorder_quantity',
  'quantity',
  'condition',
  'brand',
  'model',
  'created_at',
  'updated_at',
  'image_url',
  'featured_image_id',
  'created_by',
  'variety_id',
  'featured_photo_id',
  'sow_archived_season',
  'sow_archived_at',
];

describe('inventory-items SELECT-column contract (L-081 Phase 1)', () => {
  it('declares exactly one audit table, so the auditor cross-product stays honest', () => {
    expect(AUDIT_TABLES).toEqual(['inventory_items']);
  });

  it('every audited column is genuinely referenced in this handler\'s SQL', () => {
    // Stops this file becoming a fiction: an array naming columns the SQL no longer touches would
    // keep passing the prod audit while auditing nothing real.
    const missing = INVENTORY_ITEMS_COLUMNS.filter((c) => !new RegExp(`\\b${c}\\b`).test(SQL));
    expect(missing).toEqual([]);
  });

  it('pins a non-trivial contract — an emptied array must fail, not silently pass', () => {
    expect(INVENTORY_ITEMS_COLUMNS.length).toBeGreaterThanOrEqual(31);
  });

  it('queries inventory_items', () => {
    expect(SQL).toMatch(/\binventory_items\b/);
  });
});
