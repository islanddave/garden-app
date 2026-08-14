// OPS-L081COLS-001 — static SELECT-column contract for photos.
//
// WHY THIS FILE EXISTS: scripts/dev-main-schema-audit.py Phase 1 audits SELECT columns against prod's
// information_schema by reading lambda/**/select-columns.test.js. A Lambda with no such file is
// audited for NOTHING in Phase 1 and the job still reports green — the vacuous-gate problem this
// ledger row records ("worse than an absent one because it gets cited as evidence").
//
// photos carries the 7-clause photos_must_have_parent CHECK, and BUG-PHOTOPARENT-001 recurred TWICE
// because a parent column was missed — inventory_item_id first, then space_id. Every parent FK is
// pinned below for exactly that reason.
//
// The column list below is EVIDENCE-DERIVED, not hand-guessed: it is the intersection of photos's
// live prod columns with the identifiers actually appearing inside this handler's sql`` templates
// (comments stripped first). Every entry was verified present in prod by running the audit.
//
// Static source inspection rather than import: lambda/photos/index.js loads @neondatabase/serverless
// and @clerk/backend at module scope, so it cannot be imported under `npm ci` in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — without this, deleting live code and
// leaving `// was: space_id` behind would still satisfy the assertions below.
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
const AUDIT_TABLES = ['photos'];

const PHOTOS_COLUMNS = [
  'id',
  'project_id',
  'event_id',
  'storage_path',
  'caption',
  'taken_at',
  'is_public',
  'uploaded_by',
  'created_at',
  'updated_at',
  'location_id',
  'plant_id',
  'deleted_at',
  'created_by',
  'inventory_item_id',
  'content_hash',
  'file_size_bytes',
  'mime_type',
  'original_filename',
  'gps_lat',
  'gps_lon',
  'intake_status',
  'space_id',
];

describe('photos SELECT-column contract (L-081 Phase 1)', () => {
  it('declares exactly one audit table, so the auditor cross-product stays honest', () => {
    expect(AUDIT_TABLES).toEqual(['photos']);
  });

  it('every audited column is genuinely referenced in this handler\'s SQL', () => {
    // Stops this file becoming a fiction: an array naming columns the SQL no longer touches would
    // keep passing the prod audit while auditing nothing real.
    const missing = PHOTOS_COLUMNS.filter((c) => !new RegExp(`\\b${c}\\b`).test(SQL));
    expect(missing).toEqual([]);
  });

  it('pins a non-trivial contract — an emptied array must fail, not silently pass', () => {
    expect(PHOTOS_COLUMNS.length).toBeGreaterThanOrEqual(21);
  });

  it('queries photos', () => {
    expect(SQL).toMatch(/\bphotos\b/);
  });
});
