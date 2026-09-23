// V5-VARIETYFACTSEDIT-001 — validate.js's breeding and provenance vocabularies ARE the migration CHECKs.
//
// validateBody refuses a breeding_system / breeding_source / scoville_source value outside
// VALID_BREEDING_SYSTEM and VALID_FACT_SOURCE before the database sees it. The two sides can drift apart
// silently in either direction: a CHECK widened by a later migration makes the Lambda 400 a value the
// database accepts, and a value added to validate.js alone reaches the UPDATE and comes back to the
// editor's banner as a raw 23514. Until this file only the comment above those lists held them together
// (regression-impact review of 658c71e). The DDL is where the vocabulary is DEFINED, so it is read here,
// not copied — the approach src/__tests__/breedingNoticeCoverage.test.jsx takes for the F1 notice.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBody, VALID_BREEDING_SYSTEM, VALID_FACT_SOURCE } from './validate.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const CHECKS = [
  { name: 'chk_plant_varieties_breeding_system', file: 'v5-varietyhybridflag-001/0a-additive-ddl.sql', column: 'breeding_system', list: VALID_BREEDING_SYSTEM },
  { name: 'chk_plant_varieties_breeding_source', file: 'v5-varietyhybridflag-001/0a-additive-ddl.sql', column: 'breeding_source', list: VALID_FACT_SOURCE },
  { name: 'chk_plant_varieties_scoville_source', file: 'v5-scovillesource-001/0a-additive-ddl.sql', column: 'scoville_source', list: VALID_FACT_SOURCE },
];

// SQL line comments are stripped before anything is parsed. Load-bearing, as in breedingNoticeCoverage:
// the breeding_system ARRAY carries a `--` comment that quotes 'open_pollinated', and parsed raw that
// prose would donate a value — and keep donating it after the real literal was deleted.
const decomment = (sql) => sql.replace(/--[^\n]*/g, '');
const addConstraint = (name) => new RegExp(`ADD\\s+CONSTRAINT\\s+${name}\\b([^;]*);`, 'i');

function sqlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) return sqlFiles(p);
    return e.name.endsWith('.sql') ? [p] : [];
  });
}
const MIGRATION_SQL = sqlFiles(MIGRATIONS).map((p) => [relative(MIGRATIONS, p), decomment(readFileSync(p, 'utf8'))]);
const sqlOf = (file) => MIGRATION_SQL.find(([rel]) => rel === file)?.[1] ?? '';

// The values of ONE constraint, read from its own statement (ADD CONSTRAINT up to the semicolon), so a
// CHECK that stopped using `<column> = ANY (ARRAY[...])` fails here instead of borrowing the list of
// whichever constraint follows it.
function ddlValues({ name, file, column }) {
  const stmt = sqlOf(file).match(addConstraint(name));
  if (!stmt) return null;
  const arr = stmt[1].match(new RegExp(`\\b${column}\\s*=\\s*ANY\\s*\\(\\s*ARRAY\\s*\\[([^\\]]*)\\]`, 'i'));
  return arr ? [...arr[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]) : null;
}

// Every migration that ADDs the constraint. A second one is how this vocabulary would really drift (a
// later migration dropping and re-creating the CHECK wider), and it must turn this file red rather than
// leave it comparing validate.js with a definition that is no longer the live one.
const definers = (name) => MIGRATION_SQL.filter(([, sql]) => addConstraint(name).test(sql)).map(([rel]) => rel);

// What validateBody ACTUALLY enforces for one column, read off its own refusal ("<column> must be one of:
// a, b, c"), so a column quietly switched to a different list is caught too, not just the export.
function enforced(column) {
  const refusal = validateBody({ [column]: '__not_a_value__' }, { requireName: false });
  expect(refusal, `${column}: validateBody no longer refuses an unknown value`).toMatch(new RegExp(`^${column} must be one of: `));
  return refusal.slice(refusal.indexOf(': ') + 2).split(', ');
}

describe('validate.js accepts exactly the values the migration CHECKs admit', () => {
  it.each(CHECKS)('$name parses out of $file as a plausible list, not an empty one', (c) => {
    const values = ddlValues(c);
    expect(values, `could not read ${c.column} = ANY (ARRAY[...]) out of ${c.name}`).toBeTruthy();
    expect(values.length).toBeGreaterThanOrEqual(4);
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(CHECKS)('$name is defined by exactly one migration', (c) => {
    expect(definers(c.name), `a second migration defines ${c.name}: point this test at the live definition and re-check validate.js`)
      .toEqual([c.file]);
  });

  it.each(CHECKS)('$column: every value $name admits is accepted, and nothing else', (c) => {
    const ddl = ddlValues(c);
    for (const [label, accepted] of [['the exported list', c.list], ['validateBody', enforced(c.column)]]) {
      expect(ddl.filter((v) => !accepted.includes(v)), `${c.name} admits these, ${label} refuses them`).toEqual([]);
      expect(accepted.filter((v) => !ddl.includes(v)), `${label} accepts these, ${c.name} refuses them`).toEqual([]);
    }
  });
});
