// OPS-L081COLS-001 — static SELECT-column contract for the locations read model.
//
// WHY THIS FILE EXISTS: `scripts/dev-main-schema-audit.py` Phase 1 audits SELECT columns against
// prod's information_schema by reading `lambda/**/select-columns.test.js`. A Lambda with no such
// file is audited for NOTHING in Phase 1 and the job still reports green — the vacuous-gate problem
// recorded in OPS-L081COLS-001 ("worse than an absent one because it gets cited as evidence").
// lambda/locations was one of 22 unenrolled Lambdas; this enrols it and lowers that count to 21.
//
// locations is a deliberate first pick: it is one of the three entrypoints
// BUG-LAMBDASYNTAX-001 silently truncated, so it has already demonstrated once that this Lambda can
// ship structurally broken without a test noticing.
//
// Static source inspection, not import: lambda/locations/index.js loads @neondatabase/serverless and
// @clerk/backend at module scope, so it cannot be imported under `npm ci` in CI without the
// handler's runtime deps — same constraint and same solution as the sibling files.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — without this, deleting a live column and
// leaving `// was: sort_order` behind would still satisfy the assertions below.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// L-081 declared contract (dev-main-schema-audit.py Phase 1): the prod relation every `*_COLUMNS`
// array in this file must exist in. ONE table, deliberately — the auditor cross-products every
// collected array against every declared table, so adding `photos` here would demand that
// `type_label` exist on photos. Photo columns are therefore named *_FIELDS below, which the
// collector's `_COLUMNS` pattern ignores; they stay live as vitest assertions without entering the
// audit contract.
const AUDIT_TABLES = ['locations'];

// The GET list projection (SELECT ... FROM locations).
//
// V4-COVEREDNOTMODELLED-001 added `covered`. NOTE FOR WHOEVER APPLIES THAT MIGRATION: this array IS
// the L-081 audit contract, and dev-main-schema-audit.py Phase 1 checks every entry against PROD's
// information_schema — so this line asserts that locations.covered EXISTS ON PROD. It does not yet
// (verified 2026-08-20). That is deliberate rather than an oversight: the audit going red is the
// intended signal if this code somehow reaches prod ahead of migrations/v4-loccovered-001, and it is
// one more reason the apply must precede the promote rather than follow it.
const LIST_COLUMNS = [
  'id', 'name', 'slug', 'level', 'type_label', 'parent_id', 'sort_order',
  'description', 'is_active', 'covered', 'created_at',
];

// Predicate + ownership columns. Unselected but load-bearing: if `deleted_at` vanished from prod,
// every locations route would 500 on the WHERE clause while the projection above stayed valid, so
// auditing only the SELECT list would miss it.
const PREDICATE_COLUMNS = ['deleted_at', 'created_by'];

// Write-path columns the handler sets or returns.
const WRITE_COLUMNS = ['featured_photo_id'];

// NOT part of the audit contract — a different relation (see AUDIT_TABLES).
const PHOTO_FIELDS = ['view_url', 'storage_key'];

describe('locations SELECT-column contract (L-081 Phase 1)', () => {
  it('declares exactly one audit table, so the auditor cross-product stays honest', () => {
    expect(AUDIT_TABLES).toEqual(['locations']);
  });

  it('every audited column is actually referenced in the handler source', () => {
    // The assertion that stops this file becoming a fiction: an array listing columns the code no
    // longer reads would keep passing the prod audit while auditing nothing real.
    const missing = [...LIST_COLUMNS, ...PREDICATE_COLUMNS, ...WRITE_COLUMNS]
      .filter((c) => !new RegExp(`\\b${c}\\b`).test(SRC));
    expect(missing).toEqual([]);
  });

  it('pins the GET list projection', () => {
    const m = /SELECT id, name, slug, level, type_label, parent_id, sort_order,\s*\n\s*description, is_active, covered, created_at\s*\n\s*FROM locations\b/.exec(SRC);
    expect(m).not.toBeNull();
  });

  it('scopes every read to the household AND to live rows', () => {
    // Both halves matter: dropping created_by leaks another household's locations, dropping
    // deleted_at resurrects soft-deleted ones. Pinned together because they travel together.
    expect(SRC).toMatch(/FROM locations\s*\n\s*WHERE deleted_at IS NULL AND created_by = ANY\(/);
  });

  it('keeps the with-path read behind the same live+ownership gate', () => {
    expect(SRC).toMatch(/FROM locations_with_path\s*\n\s*WHERE deleted_at IS NULL/);
    expect(SRC).toMatch(/id IN \(SELECT id FROM locations WHERE deleted_at IS NULL AND created_by = ANY\(/);
  });

  it('does not fold photo columns into the locations audit contract', () => {
    for (const f of PHOTO_FIELDS) expect(LIST_COLUMNS).not.toContain(f);
  });
});
