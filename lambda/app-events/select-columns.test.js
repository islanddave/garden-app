// new-file: app-events now ships household.js (SEC-13a gate), whose SELECTs end its NO_SQL_READS exemption
// L-081 Phase 1 SELECT-column contract for app-events (OPS-L081COLS-001), enrolled by
// lambda/select-columns-enrollment.test.js. Its only reads are the household.js loaders' (locations shown here; the
// four loader relations are keyed in household-columns.test.js beside it). Trap: ONE table, because the auditor
// cross-products every *_COLUMNS array against every declared table.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(full);
  }
  return out;
}

function sqlOf(src) {
  const s = decomment(src);
  return [
    ...(s.match(/sql`[\s\S]*?`/g) ?? []),
    ...(s.match(/\.query\(\s*`[^`]*`/g) ?? []),
    ...(s.match(/\.query\(\s*'[^']*'/g) ?? []),
    ...(s.match(/\.query\(\s*"[^"]*"/g) ?? []),
  ].join('\n');
}

const SQL = walk(__dirname).map((f) => sqlOf(readFileSync(f, 'utf8'))).join('\n');

const AUDIT_TABLES = ['locations'];

const AUDITED_COLUMNS = [
  'id',
  'name',
  'created_by',
  'deleted_at',
];

describe('app-events SELECT-column contract (L-081 Phase 1)', () => {
  it('declares exactly one audit table, so the auditor cross-product stays honest', () => {
    expect(AUDIT_TABLES).toEqual(['locations']);
  });

  it('finds SQL to audit — an empty read would make every assertion below vacuous', () => {
    expect(SQL.length).toBeGreaterThan(50);
    expect(SQL).toMatch(/FROM locations/);
  });

  it('every audited column is genuinely referenced in this Lambda\'s SQL', () => {
    const missing = AUDITED_COLUMNS.filter((c) => !new RegExp(`\\b${c}\\b`).test(SQL));
    expect(missing).toEqual([]);
  });

  it('pins a non-trivial contract', () => {
    expect(AUDITED_COLUMNS.length).toBeGreaterThanOrEqual(3);
  });
});
