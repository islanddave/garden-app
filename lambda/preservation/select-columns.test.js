// OPS-L081COLS-001 — static SELECT-column contract for preservation.
//
// WHY THIS FILE EXISTS: scripts/dev-main-schema-audit.py Phase 1 audits SELECT columns against prod's
// information_schema by reading lambda/**/select-columns.test.js. A Lambda with no such file is
// audited for NOTHING in Phase 1 and the job still reports green — the vacuous-gate problem this
// ledger row records ("worse than an absent one because it gets cited as evidence").
//
// preservation_log is the pantry system of record and is EXEMPT from archive-hiding by Dave's 2026-08-14
// ruling, so its rows deliberately outlive the plantings they came from — a dropped provenance column
// loses the jar's label permanently.
//
// The column list below is EVIDENCE-DERIVED, not hand-guessed: it is the intersection of preservation_log's
// live prod columns with the identifiers actually appearing inside this handler's sql`` templates
// (comments stripped first). Every entry was verified present in prod by running the audit.
//
// Static source inspection rather than import: lambda/preservation/index.js loads @neondatabase/serverless
// and @clerk/backend at module scope, so it cannot be imported under `npm ci` in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — without this, deleting live code and
// leaving `// was: source_label` behind would still satisfy the assertions below.
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
const AUDIT_TABLES = ['preservation_log'];

const PRESERVATION_COLUMNS = [
  'id',
  'user_id',
  'crop_type_slug',
  'variety_id',
  'plant_id',
  'harvest_log_id',
  'preserved_at',
  // V4-PUTUPSESSION-001 slice 1. LISTED HERE ONLY BECAUSE IT NOW APPEARS IN A sql`` TEMPLATE (the
  // INSERT column list and the COALESCE-preserving UPDATE) — the assertion below rejects a name the
  // handler does not actually reference. Note the ordering consequence: this array is audited
  // against the LIVE PROD information_schema by schema-audit.yml, so it reports a genuine FAIL until
  // migrations/v4-putupsession-001 is applied to prod. That is the L-081 guard doing its job, and it
  // is why the DDL goes in before the promote.
  'preserved_at_approx',
  'method',
  'method_other_text',
  'quantity_value',
  'quantity_unit',
  'package_count',
  'storage_location_id',
  'use_by_target',
  'remaining_count',
  'consumed_at',
  'notes',
  'photo_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'source_kind',
  'source_label',
];

describe('preservation SELECT-column contract (L-081 Phase 1)', () => {
  it('declares exactly one audit table, so the auditor cross-product stays honest', () => {
    expect(AUDIT_TABLES).toEqual(['preservation_log']);
  });

  it('every audited column is genuinely referenced in this handler\'s SQL', () => {
    // Stops this file becoming a fiction: an array naming columns the SQL no longer touches would
    // keep passing the prod audit while auditing nothing real.
    const missing = PRESERVATION_COLUMNS.filter((c) => !new RegExp(`\\b${c}\\b`).test(SQL));
    expect(missing).toEqual([]);
  });

  it('pins a non-trivial contract — an emptied array must fail, not silently pass', () => {
    expect(PRESERVATION_COLUMNS.length).toBeGreaterThanOrEqual(21);
  });

  it('queries preservation_log', () => {
    expect(SQL).toMatch(/\bpreservation_log\b/);
  });
});
