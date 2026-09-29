// OPS-SCHEMAAUDITJOIN-001 / Put-Up train §6a — the columns lambda/plants/merge.js reads on the four
// planting-merge surfaces the train added: kitchen_batch_input, preservation_source, ready_impression,
// watch_exclusion.
//
// WITHOUT THIS FILE the promote's prod schema gate refuses the train. merge.js queries these four
// relations and no contract in lambda/plants declared them, so the Phase 4 ratchet
// (scripts/schema-audit-join-baseline.json, uncovered_relations = 47, may fall and never rise) counted
// 51. Measured offline with the auditor's own parse_test_file / parse_sql_relations and its exact file
// filter: 24 lambdas / 249 relation refs / 51 uncovered without this file, 47 with it. The failure
// could not show before the sitting: until the prod DDL lands, Phase 4(a) returns early on a relation
// prod does not have yet and never reaches the ratchet. scripts/test_schema_audit_join_ratchet.py now
// recomputes the count DB-free in build-and-test, so the next one reds the PR instead. The correct edit
// is always a contract, never a raised baseline.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the keyed
// AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:162-171), so dropping a keyed block into an existing contract file
// SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHY ALL FOUR IN ONE FILE: the keyed form binds columns to ONE relation each and does not
// cross-product, so the four can share a file without asserting each other's columns. Phase 4 credits a
// contract only to the handler's OWN directory, and only when the AUDIT_COLUMNS literal is in this file's
// own source text — which is why it lives here rather than beside lambda/preservation's contract, which
// already declares kitchen_batch_input for that directory and credits nothing to this one.
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. Same decomment as the sibling contracts
// (scripts/dev-main-schema-audit.py:295-308).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk, so a handler
// added here that reads one of these relations is held to this contract the day it lands.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract, the columns as merge.js's own SQL names them. All present in the migration DDL:
// kitchen_batch_input.id (v5-inflightbatch-001/0a) and .plant_id (v5-putupmake-001/0a, 1b, which ships
// in the same promote as F); preservation_source (v5-putupmultisource-001/0a); ready_impression
// (v4-readytrayimpression-001/0a); watch_exclusion (v4-watchexcluded-001/0a). The early pre-promote
// review verified every one in live prod information_schema except kitchen_batch_input.plant_id, which
// lands with 1b's DDL before the gate runs.
const AUDIT_COLUMNS = {
  kitchen_batch_input: ['id', 'plant_id'],
  preservation_source: ['id', 'plant_id'],
  ready_impression: ['id', 'plant_id', 'user_id', 'shown_on', 'region'],
  watch_exclusion: ['id', 'plant_id', 'user_id', 'evaluated_on', 'reason'],
};

const TABLES = Object.keys(AUDIT_COLUMNS);

// Extraction mirrors scripts/dev-main-schema-audit.py:272-320 so this guard sees the statements Phase 4
// credits. Only SQL inside a tagged sql`` template counts. `IS [NOT] DISTINCT FROM x.col` carries the
// literal token FROM, so it is scrubbed before scanning (merge.js's findings DELETE has one).
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// The alias group is OPTIONAL: the snapshot reads' unaliased `FROM <table> WHERE ...` captures the next
// keyword, which NOT_AN_ALIAS rejects and UNALIASED_ARMS then accounts for by hand. UPDATE <table> is
// not a FROM/JOIN binding (the repoint UPDATEs), the same as the auditor's own relation parse.
const bindings = (table, s) => [...s.matchAll(new RegExp(
  String.raw`\b(?:FROM|JOIN)\s+(?:public\.)?${table}\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?`, 'gi',
))].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (table, s) => [...new Set(bindings(table, s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (table, s) => bindings(table, s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

// Scoped to statements that BIND the table, so an `x.col` belonging to some other query in the same file
// can never be read as this table's.
const columnsOf = (table, s) => [...new Set(aliasesOf(table, s).flatMap((a) => [...s.matchAll(
  new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
)].map((m) => m[1].toLowerCase())))];

const TEMPLATES = HANDLERS.flatMap((file) => {
  const src = decomment(readFileSync(resolve(__dirname, file), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)].map((m) => ({ file, sql: m[1].replace(DISTINCT_FROM, ' ') }));
});
const statementsOf = (table) => TEMPLATES.filter(({ sql }) => bindings(table, sql).length > 0);

// Reads that name the table with NO alias: merge.js's step-6 snapshot of every row about to move, which a
// restore replays. Each is PINNED to its literal SQL with its columns listed by hand — edit the query and
// the pin stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const snapshotPin = (table) => new RegExp(
  String.raw`SELECT\s+id,\s*plant_id\s+AS\s+old_value\s+FROM\s+${table}\s+WHERE\s+plant_id\s*=\s*ANY\(\$\{loserIds\}\)`,
);
const UNALIASED_ARMS = TABLES.map((table) => ({
  table, file: 'merge.js', pin: snapshotPin(table), columns: ['id', 'plant_id'],
}));

// Exact, not a floor: a new statement against one of these relations should be reviewed against the
// contract rather than inherit it. Update this in the same commit that adds one. The two telemetry
// surfaces also carry the conflict-prune DELETE, aliased l (the loser row), w (the winner's) and o (a
// lower-id loser's).
const EXPECTED = {
  kitchen_batch_input: { statements: 1, aliases: [] },
  preservation_source: { statements: 1, aliases: [] },
  ready_impression: { statements: 2, aliases: ['l', 'o', 'w'] },
  watch_exclusion: { statements: 2, aliases: ['l', 'o', 'w'] },
};

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants merge-surface column contract', () => {
  it('finds the statements for every declared relation, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toContain('merge.js');
    expect(Object.keys(EXPECTED)).toEqual(TABLES);
    for (const table of TABLES) {
      const stmts = statementsOf(table);
      expect(stmts, table).toHaveLength(EXPECTED[table].statements);
      expect([...new Set(stmts.map((s) => s.file))], table).toEqual(['merge.js']);
      expect([...new Set(stmts.flatMap((s) => aliasesOf(table, s.sql)))].sort(), table)
        .toEqual(EXPECTED[table].aliases);
    }
  });

  it('accounts for every unaliased read of each relation', () => {
    // An unaliased read added without a pin would slip past columnsOf() entirely and the tightness
    // assertion below would still pass — this count is what closes that hole.
    for (const table of TABLES) {
      const arms = UNALIASED_ARMS.filter((a) => a.table === table);
      const bare = statementsOf(table).reduce((n, s) => n + unaliasedIn(table, s.sql), 0);
      expect(bare, table).toBe(arms.length);
      for (const arm of arms) {
        const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
        expect(arm.pin.test(src), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
      }
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    for (const table of TABLES) {
      const referenced = [...new Set([
        ...statementsOf(table).flatMap((s) => columnsOf(table, s.sql)),
        ...UNALIASED_ARMS.filter((a) => a.table === table).flatMap((a) => a.columns),
      ])].sort();
      // Both directions. The contract is what Phase 1 audits against prod, so a column nothing reads
      // makes the audit assert something the code never does.
      expect(referenced, table).toEqual([...AUDIT_COLUMNS[table]].sort());
    }
  });

  it('never reaches for a column that belongs to another table', () => {
    // Each is absent from its table's DDL and is a live confusion in merge.js, where these statements sit
    // beside near-identical ones for other surfaces. The two telemetry DELETEs are copies of each other
    // and of watch_impression's: shown_on/region are the impression key, evaluated_on/reason the
    // exclusion key, and neither telemetry table has a deleted_at to filter on. kitchen_batch_input's
    // owner column is created_by, preservation_source's is user_id. source_plant_id is the
    // inventory_items name on the repoint line between them.
    const NOT_ON_TABLE = {
      kitchen_batch_input: ['user_id', 'source_plant_id'],
      preservation_source: ['created_by', 'source_plant_id'],
      ready_impression: ['evaluated_on', 'reason', 'deleted_at'],
      watch_exclusion: ['shown_on', 'region', 'deleted_at'],
    };
    expect(Object.keys(NOT_ON_TABLE)).toEqual(TABLES);
    for (const table of TABLES) {
      for (const col of NOT_ON_TABLE[table]) {
        expect(AUDIT_COLUMNS[table], `${col} is not a ${table} column`).not.toContain(col);
        for (const { file, sql } of statementsOf(table)) {
          for (const a of aliasesOf(table, sql)) {
            expect(sql, `${file}: ${a}.${col} is not a ${table} column`)
              .not.toMatch(new RegExp(String.raw`\b${a}\.${col}\b`, 'i'));
          }
        }
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with NO
    // warning, and Phase 4 keeps counting all four relations as uncovered. A misspelled KEY is worse —
    // Phase 1 audits a relation that does not exist. Replicate the auditor's own two regexes
    // (dev-main-schema-audit.py:124-127) against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(TABLES);
    for (const [, table, body] of pairs) {
      const cols = [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
      expect(cols, table).toEqual(AUDIT_COLUMNS[table]);
    }
  });
});
