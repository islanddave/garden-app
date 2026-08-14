// OPS-L081COLS-001 — static SELECT-column contract for favorites.
//
// WHY THIS FILE EXISTS: scripts/dev-main-schema-audit.py Phase 1 audits SELECT columns against prod's
// information_schema by reading lambda/**/select-columns.test.js. A Lambda with no such file is
// audited for NOTHING in Phase 1 and the job still reports green — the vacuous-gate problem this
// ledger row records ("worse than an absent one because it gets cited as evidence").
//
// favorites is the app's ONLY reachable hard delete (Soft-Delete-Only Rule carve-out 2), so it has no
// deleted_at to fall back on: if a column here diverges in prod the row is simply gone, with no
// soft-deleted copy to recover from. Small surface, high consequence.
//
// The column list below is EVIDENCE-DERIVED, not hand-guessed: it is the intersection of favorites's
// live prod columns with the identifiers actually appearing inside this handler's sql`` templates
// (comments stripped first). Every entry was verified present in prod by running the audit.
//
// Static source inspection rather than import: lambda/favorites/index.js loads @neondatabase/serverless
// and @clerk/backend at module scope, so it cannot be imported under `npm ci` in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — without this, deleting live code and
// leaving `// was: created_at` behind would still satisfy the assertions below.
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
const AUDIT_TABLES = ['favorites'];

const FAVORITES_COLUMNS = [
  'id',
  'user_id',
  'entity_type',
  'entity_id',
  'created_at',
];

describe('favorites SELECT-column contract (L-081 Phase 1)', () => {
  it('declares exactly one audit table, so the auditor cross-product stays honest', () => {
    expect(AUDIT_TABLES).toEqual(['favorites']);
  });

  it('every audited column is genuinely referenced in this handler\'s SQL', () => {
    // Stops this file becoming a fiction: an array naming columns the SQL no longer touches would
    // keep passing the prod audit while auditing nothing real.
    const missing = FAVORITES_COLUMNS.filter((c) => !new RegExp(`\\b${c}\\b`).test(SQL));
    expect(missing).toEqual([]);
  });

  it('pins a non-trivial contract — an emptied array must fail, not silently pass', () => {
    expect(FAVORITES_COLUMNS.length).toBeGreaterThanOrEqual(3);
  });

  it('queries favorites', () => {
    expect(SQL).toMatch(/\bfavorites\b/);
  });
});
