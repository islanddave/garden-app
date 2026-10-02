// Put-Up R2a (contract 3) — the preservation_log and pantry_item columns lambda/storage-location reads.
//
// The two place refusals (index.js: a re-kind while the place holds dated put-ups, a delete while it
// holds anything) make this Lambda read preservation_log and pantry_item for the first time. The prod
// schema gate's Phase 4 counts every relation a Lambda directory touches with no column contract in
// that SAME directory, and refuses the promote when the count rises above
// scripts/schema-audit-join-baseline.json. That count had zero slack when this was written, so a new
// `FROM preservation_log` with no contract here stops the ship after the ship phrase is given.
//
// WHY A SEPARATE FILE: parse_test_file returns on the keyed AUDIT_COLUMNS form FIRST and never reaches
// the AUDIT_TABLES collector, so a keyed block dropped into select-columns.test.js would silently
// destroy that file's own coverage; and household-columns.test.js is held byte-identical across 19
// directories (lambda/household-columns-sync.test.js). Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's own directory
// (it groups by Path(handler).parent), and only when the AUDIT_COLUMNS literal is in this file's own
// source text. lambda/preservation's contracts for the same two relations buy this Lambda nothing.
//
// Static source inspection, like its siblings: the contract is asserted against the SQL text.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a bare `--`
// separator line too (scripts/dev-main-schema-audit.py _decomment_js).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory: the same set Phase 4 groups together.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract: every column the two refusals' SQL names, per relation. Each is a column the
// Pantry list already reads on prod through lambda/preservation (pantryRoutes.js listPantry), whose own
// contracts the schema gate checks: preservation_log's are v4-putup-001's and Put-Up 1b's
// (use_by_basis), pantry_item's are v5-pantry-001's.
const AUDIT_COLUMNS = {
  preservation_log: [
    'consumed_at', 'deleted_at', 'package_count', 'remaining_count', 'storage_location_id', 'use_by_basis',
    'use_by_target', 'user_id'
  ],
  pantry_item: ['deleted_at', 'storage_location_id', 'used_up_at', 'user_id'],
};

// Extraction mirrors scripts/dev-main-schema-audit.py parse_sql_relations, so this guard sees the
// statements Phase 4 credits. Only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;
const RELATION = /\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)(?!\s*\.)/gi;
const CTE_DECL = /(?:\bWITH\s+(?:RECURSIVE\s+)?|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi;

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)].map((m) => ({ file: f, sql: m[1].replace(DISTINCT_FROM, ' ') }));
});

// The relations a statement touches, as the auditor reads them: FROM / JOIN names, less its own CTEs.
const relationsOf = (sql) => {
  const ctes = new Set([...sql.matchAll(CTE_DECL)].map((m) => m[1].toLowerCase()));
  return [...new Set([...sql.matchAll(RELATION)].map((m) => m[1].toLowerCase()))].filter((r) => !ctes.has(r)).sort();
};

// Each relation is read under ONE alias, written out at every binding, so `alias.column` is the whole
// of what the SQL names on it. A bare (unaliased) read would slip past columnsOf: counted below.
const ALIAS = { preservation_log: 'p', pantry_item: 'pit' };
const bindingsOf = (sql, table) => [...sql.matchAll(new RegExp(String.raw`\b(?:FROM|JOIN)\s+(?:public\.)?${table}\b\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?`, 'gi'))]
  .map((m) => (m[1] ?? '').toLowerCase());
const columnsOf = (table) => [...new Set(STATEMENTS
  .filter((s) => bindingsOf(s.sql, table).length > 0)
  .flatMap((s) => [...s.sql.matchAll(new RegExp(String.raw`\b${ALIAS[table]}\.([a-z_][a-z0-9_]*)\b`, 'gi'))].map((m) => m[1].toLowerCase())))].sort();

describe('Put-Up R2a — lambda/storage-location preservation_log / pantry_item column contract', () => {
  it('finds the statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toContain('index.js');
    // The PUT's re-kind count and the DELETE's in-use count read preservation_log; the DELETE's also
    // reads pantry_item. Exact, not a floor: a new statement against either table is reviewed against
    // this contract rather than inheriting it.
    expect(STATEMENTS.filter((s) => bindingsOf(s.sql, 'preservation_log').length > 0)).toHaveLength(2);
    expect(STATEMENTS.filter((s) => bindingsOf(s.sql, 'pantry_item').length > 0)).toHaveLength(1);
  });

  it('binds each relation under its one alias, never bare and never schema-qualified', () => {
    for (const table of Object.keys(AUDIT_COLUMNS)) {
      const bound = STATEMENTS.flatMap((s) => bindingsOf(s.sql, table));
      expect(bound.length, table).toBeGreaterThan(0);
      expect([...new Set(bound)], table).toEqual([ALIAS[table]]);
    }
    for (const { file, sql } of STATEMENTS) expect(sql, file).not.toMatch(/\bpublic\./i);
  });

  it('reads through its aliases exactly the declared columns: none absent from the contract, none declared and unused', () => {
    // Both directions. The contract is what Phase 1 audits against prod, so a column nothing reads
    // makes the audit assert something the code never does.
    for (const [table, declared] of Object.entries(AUDIT_COLUMNS)) {
      expect(columnsOf(table), table).toEqual([...declared].sort());
    }
  });

  it('this directory touches no relation that lacks a contract in it (the Phase 4 coverage arm)', () => {
    // The auditor's own arithmetic for one directory: touched, less what its *columns.test.js files
    // declare. The gap must be empty, or the prod schema gate's count rises above its baseline.
    const touched = [...new Set(STATEMENTS.flatMap((s) => relationsOf(s.sql)))].sort();
    const declared = new Set(readdirSync(__dirname)
      .filter((f) => f.endsWith('columns.test.js'))
      .flatMap((f) => {
        const src = readFileSync(resolve(__dirname, f), 'utf8');
        const keyed = src.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
        if (keyed) return [...keyed[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
        const tables = src.match(/const\s+AUDIT_TABLES\s*=\s*\[([\s\S]*?)\]/);
        return tables ? [...tables[1].matchAll(/['"](\w+)['"]/g)].map((m) => m[1]) : [];
      }));
    expect(touched).toEqual(expect.arrayContaining(['pantry_item', 'preservation_log', 'storage_location']));
    expect(touched.filter((r) => !declared.has(r))).toEqual([]);
  });

  it('names only columns the Pantry list already reads from the same two relations', () => {
    // lambda/preservation's listPantry is live on prod and reads every one of these through its own
    // aliases (p for put-ups, i for items). A column here that it does not read is one nobody has
    // proved exists.
    const pantry = decomment(readFileSync(resolve(__dirname, '../preservation/pantryRoutes.js'), 'utf8'));
    for (const c of AUDIT_COLUMNS.preservation_log) expect(pantry, `preservation_log.${c}`).toMatch(new RegExp(String.raw`\bp\.${c}\b`));
    for (const c of AUDIT_COLUMNS.pantry_item) expect(pantry, `pantry_item.${c}`).toMatch(new RegExp(String.raw`\bi\.${c}\b`));
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with no
    // warning, and Phase 4 keeps counting both relations as uncovered. Plain string literals only.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(Object.keys(AUDIT_COLUMNS));
    for (const [, table, body] of pairs) {
      const cols = [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
      expect(cols).toEqual(AUDIT_COLUMNS[table]);
    }
  });
});
