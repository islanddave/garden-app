// OPS-L081COLS-001 — static SELECT-column contract for facebook-share.
//
// WHY THIS FILE EXISTS: scripts/dev-main-schema-audit.py Phase 1 audits SELECT columns against prod's
// information_schema by reading lambda/**/select-columns.test.js. A Lambda with no such file is
// audited for NOTHING in Phase 1 while the job still reports green — the vacuous-gate problem this
// ledger row exists for ("worse than an absent one because it gets cited as evidence").
//
// share_log is the outbound-share audit trail; it is append-only, so a lost column is unrecoverable history.
//
// The list below is EVIDENCE-DERIVED: the intersection of share_log's live prod columns with the
// identifiers actually appearing in this Lambda's SQL, comments stripped first. Verified present in
// prod by running the audit, not by inspection.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

// The whole Lambda, not just index.js — several Lambdas here keep their SQL in sibling modules, and
// an index.js-only reader would audit nothing for those while looking thorough.
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(full);
  }
  return out;
}

// Both query dialects. sql`` tagged templates AND node-postgres .query() — daily-plan uses the
// latter exclusively, so an extractor that knew only the former read it as having no SQL at all.
function sqlOf(src) {
  const s = decomment(src);
  return [
    ...(s.match(/sql`[\s\S]*?`/g) ?? []),
    // One pattern per quote style: a single character class would let a backtick template that
    // contains an apostrophe terminate at that apostrophe, silently truncating the SQL.
    ...(s.match(/\.query\(\s*`[^`]*`/g) ?? []),
    ...(s.match(/\.query\(\s*'[^']*'/g) ?? []),
    ...(s.match(/\.query\(\s*"[^"]*"/g) ?? []),
  ].join('\n');
}

const SQL = walk(__dirname).map((f) => sqlOf(readFileSync(f, 'utf8'))).join('\n');

// L-081 declared contract (Phase 1): the prod relation every `*_COLUMNS` array here must exist in.
// ONE table, deliberately — the auditor cross-products every array against every declared table.
const AUDIT_TABLES = ['share_log'];

const AUDITED_COLUMNS = [
  'id',
  'post_group_id',
  'photo_id',
  'target',
  'client_request_id',
  'fb_page_id',
  'fb_media_id',
  'fb_post_id',
  'status',
  'caption',
  'requested_by',
  'error',
  'created_at',
  'updated_at',
  // Added with BUG-FBPERMALINK-001. It was omitted here for an honest reason — before that fix the
  // identifier appeared in the Instagram SQL only, and this array is the intersection of prod's
  // columns with the SQL this Lambda actually issues. Both targets write it now, so it belongs.
  'permalink',
];

describe('facebook-share SELECT-column contract (L-081 Phase 1)', () => {
  it('declares exactly one audit table, so the auditor cross-product stays honest', () => {
    expect(AUDIT_TABLES).toEqual(['share_log']);
  });

  it('finds SQL to audit — an empty read would make every assertion below vacuous', () => {
    expect(SQL.length).toBeGreaterThan(50);
  });

  it('every audited column is genuinely referenced in this Lambda\'s SQL', () => {
    const missing = AUDITED_COLUMNS.filter((c) => !new RegExp(`\\b${c}\\b`).test(SQL));
    expect(missing).toEqual([]);
  });

  it('pins a non-trivial contract', () => {
    expect(AUDITED_COLUMNS.length).toBeGreaterThanOrEqual(12);
  });
});
