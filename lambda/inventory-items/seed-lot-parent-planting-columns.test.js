// V5-SEEDMULTIPARENT-001 — column contract for public.seed_lot_parent_planting, as lambda/inventory-items
// names it (L-081 Phase 1, keyed form).
//
// WHY THIS FILE EXISTS. This directory is the table's first writer and reader: seed-lot-parents.js
// carries the parents read, the link INSERT and the set-replace transaction, and index.js's
// /source-kind route asks whether a lot has any. The schema audit's Phase 4 census counts every
// relation a non-test .js here names in FROM/JOIN, and a relation with no declared columns is audited
// by nothing — the shape that let a seed-detail SELECT name a column garden_node does not have and
// 500 every packet page in prod (BUG-SEEDDETAIL500-001). The fix is coverage, never a bump of
// scripts/schema-audit-join-baseline.json (47, "may fall, never rise").
//
// ITS OWN FILE, KEYED FORM, AND THE NAME ENDS IN `columns.test.js` — all three load-bearing, for the
// reasons seed-stage-columns.test.js and cultivar-columns.test.js give: parse_test_file returns on a
// keyed AUDIT_COLUMNS literal first (a block dropped into an existing contract would silently replace
// that file's coverage), Phase 4 credits a contract only to the handler's own directory, and the
// discovery glob is `*columns.test.js`. lambda/plants names this table too and needs its own file.
//
// EVERY COLUMN ANY STATEMENT HERE NAMES — SELECT, WHERE, INSERT, SET, ORDER BY, RETURNING — not only
// the projected ones. The audit checks a column only if a contract lists it, so one named in a WHERE
// and left out here would pass the prod gate and 500 at runtime if staging and prod ever disagreed.
// The sweep below reads the SQL and holds the list to it in BOTH directions.
//
// THE TABLE DOES NOT EXIST YET when this is written (its migration is a sibling lane's), so nothing
// below was verified against information_schema; the column names are R1-CONTRACT section 1's,
// verbatim. Until the DDL reaches prod the audit answers exit 2 on this relation (Phase 1's
// empty-relation guard) and the promote gate refuses — which is the ordering guard working.
//
// Static source inspection, like every contract in this directory.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — the sibling contracts' decomment step, in
// cultivar-columns.test.js's form (it also strips a bare `--` separator line).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler module in THIS directory — the set Phase 4 groups together. Read from disk, so a
// module added here that names the table is covered the day it lands.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

const TABLE = 'seed_lot_parent_planting';

// L-081 KEYED contract. All eight columns of the table, because between them the statements here
// name every one: the link's two FKs and its role on every read; created_by in the INSERT;
// updated_at and deleted_at in the soft-delete; created_at and id as the member cache's
// "earliest live row" order.
const AUDIT_COLUMNS = {
  seed_lot_parent_planting: [
    'id',
    'inventory_item_id',
    'plant_id',
    'role',
    'created_by',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
};

const CONTRACT = AUDIT_COLUMNS.seed_lot_parent_planting;

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(/sql`([^`]*)`/g)]
    .map((m) => m[1])
    .filter((s) => new RegExp(`\\b${TABLE}\\b`).test(s))
    .map((sql) => ({ file: f, sql }));
});

// Every place a statement BINDS the table to a name: FROM / JOIN (a read or a count) and UPDATE (the
// soft-delete's target). The alias is mandatory here — see the 'no unaliased' test — because a bare
// column name in a statement that also scans inventory_items cannot be attributed to either.
const BINDING = new RegExp(String.raw`\b(FROM|JOIN|UPDATE)\s+public\.${TABLE}\s+([a-z_][a-z0-9_]*)`, 'gi');
const bindingsOf = (s) => [...s.matchAll(BINDING)].map((m) => ({ verb: m[1].toUpperCase(), alias: m[2] }));
const NOT_AN_ALIAS = new Set(['where', 'set', 'on', 'left', 'join', 'cross', 'order', 'group', 'as']);

// alias.column references, for the aliases this statement binds to the table.
const aliasColumns = (s) => bindingsOf(s).flatMap(({ alias }) =>
  [...s.matchAll(new RegExp(String.raw`\b${alias}\.([a-z_][a-z0-9_]*)\b`, 'gi'))].map((m) => m[1]));
// The INSERT's parenthesised column list — the form the auditor's Phase 2 parses.
const insertColumns = (s) => [...s.matchAll(
  new RegExp(String.raw`INSERT\s+INTO\s+public\.${TABLE}\s*\(([^)]*)\)\s*(?:VALUES|SELECT)\b`, 'gi'),
)].flatMap((m) => m[1].split(',').map((c) => c.trim()).filter(Boolean));
// The assignments of an UPDATE whose TARGET is the table. SET names are bare by SQL's own rule (a
// target column cannot be alias-qualified), so they are read here and not by aliasColumns.
const setColumns = (s) => [...s.matchAll(
  new RegExp(String.raw`UPDATE\s+public\.${TABLE}\s+[a-z_][a-z0-9_]*\s+SET\b([\s\S]*?)\bFROM\b`, 'gi'),
)].flatMap((m) => [...m[1].matchAll(/([a-z_][a-z0-9_]*)\s*=/gi)].map((mm) => mm[1]));

describe('V5-SEEDMULTIPARENT-001 — lambda/inventory-items seed_lot_parent_planting column contract', () => {
  it('finds the statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toContain('seed-lot-parents.js');
    // Exact, not a floor: a new statement against this table should be reviewed against the contract
    // rather than inherit it. Six today — in seed-lot-parents.js the parents read, the link INSERT
    // and three of the set-replace statements (facts, soft-delete, cache); in index.js the
    // /source-kind route's "does this lot have any" test. Update the number in the commit that adds one.
    expect(STATEMENTS.map((s) => s.file).sort()).toEqual([
      'index.js',
      'seed-lot-parents.js', 'seed-lot-parents.js', 'seed-lot-parents.js', 'seed-lot-parents.js', 'seed-lot-parents.js',
    ]);
  });

  it('names the table schema-qualified and aliased, everywhere', () => {
    // An unaliased or unqualified reference would slip past every sweep below — the count of
    // references and the count the sweeps can see must be the same number.
    for (const { file, sql } of STATEMENTS) {
      const mentions = (sql.match(new RegExp(`\\b${TABLE}\\b`, 'g')) ?? []).length;
      const inserts = (sql.match(new RegExp(String.raw`INSERT\s+INTO\s+public\.${TABLE}\s*\(`, 'gi')) ?? []).length;
      const bound = bindingsOf(sql);
      expect(bound.length + inserts, `${file}: a reference the sweeps cannot attribute`).toBe(mentions);
      for (const { alias } of bound) expect(NOT_AN_ALIAS.has(alias.toLowerCase()), `${file}: unaliased`).toBe(false);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set(STATEMENTS.flatMap(({ sql }) => [
      ...aliasColumns(sql), ...insertColumns(sql), ...setColumns(sql),
    ]))].sort();
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. An extra column is not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing reads makes the audit assert something the code never does.
    expect(referenced).toEqual([...CONTRACT].sort());
  });

  it('never reaches for a column the table was deliberately built without', () => {
    // R1-CONTRACT section 1: no ordinal, no is_primary (no parent is primary and there is no order),
    // and the lot/planting FKs are inventory_item_id / plant_id — not the names their targets use
    // elsewhere in this handler.
    const ABSENT = ['ordinal', 'is_primary', 'source_plant_id', 'source_inventory_item_id', 'user_id', 'name'];
    for (const col of ABSENT) expect(CONTRACT).not.toContain(col);
  });

  it('every read and count filters role = seed_parent on a LIVE link row', () => {
    // Release 1 reads 'seed_parent' ONLY. 'pollen_parent' is in the table's CHECK for deliberate
    // crosses later; a statement that forgot the role filter would start counting pollen parents as
    // seed parents the day one is written, with no test here failing. deleted_at IS NULL because a
    // removed parent is a soft-deleted row, and it must stop being a parent everywhere at once.
    let checked = 0;
    for (const { file, sql } of STATEMENTS) {
      for (const { alias } of bindingsOf(sql)) {
        expect(sql, `${file}: ${alias} is read without the role filter`)
          .toMatch(new RegExp(String.raw`\b${alias}\.role = 'seed_parent'`));
        expect(sql, `${file}: ${alias} is read without the live-row filter`)
          .toMatch(new RegExp(String.raw`\b${alias}\.deleted_at IS NULL`));
        checked++;
      }
    }
    // Ten bindings today — the read, the INSERT's two subqueries, the facts count, the soft-delete's
    // target and its count, the cache's three, and index.js's one. Not a vacuous loop.
    expect(checked).toBeGreaterThanOrEqual(10);
    for (const { file, sql } of STATEMENTS) expect(sql, file).not.toMatch(/pollen_parent/);
  });

  it('every INSERT names the role explicitly, as seed_parent', () => {
    // The column has no default, on purpose: every writer says which kind of parent it is recording.
    const inserts = STATEMENTS.filter(({ sql }) => insertColumns(sql).length > 0);
    expect(inserts).toHaveLength(1);
    for (const { sql } of inserts) {
      expect(insertColumns(sql)).toEqual(['inventory_item_id', 'plant_id', 'role', 'created_by']);
      // Column order and the SELECT list line up: lot, planting, role, the caller.
      expect(sql.replace(/\s+/g, ' ')).toMatch(/SELECT i\.id, u\.plant_id, 'seed_parent', \$\{userId\}::text FROM/);
    }
  });

  it('every statement reaches the link rows through a LIVE lot the household owns', () => {
    // A link row is NOT soft-deleted with its lot — it follows it — so "live link row" alone would
    // read the parents of a deleted lot. And the scope is the LOT's owner: the link's own created_by
    // records who added the planting and is never a predicate here.
    for (const { file, sql } of STATEMENTS) {
      expect(sql, `${file}: no live-lot predicate`).toMatch(/\bi\.deleted_at IS NULL/);
      expect(sql, `${file}: not household-scoped through the lot`).toMatch(/\bi\.created_by = ANY\(\$\{householdIds\}\)/);
      for (const { alias } of bindingsOf(sql)) {
        expect(sql, `${file}: scoped through the link row's created_by`)
          .not.toMatch(new RegExp(String.raw`\b${alias}\.created_by\b`));
      }
    }
  });

  it('every inventory_items column seed-lot-parents.js names is pinned by select-columns.test.js', () => {
    // The helper is the second module here to read and write inventory_items outside index.js
    // (delete-guard.js is the first, and makes the same check). select-columns.test.js is this
    // directory's contract for that table; a column the helper started naming that it does not pin
    // would be audited by nothing.
    const helper = decomment(readFileSync(resolve(__dirname, 'seed-lot-parents.js'), 'utf8'));
    const helperSql = (helper.match(/sql`[^`]*`/g) ?? []).join('\n');
    const contract = readFileSync(resolve(__dirname, 'select-columns.test.js'), 'utf8');
    const list = contract.match(/const INVENTORY_ITEMS_COLUMNS = \[([\s\S]*?)\];/);
    expect(list, 'select-columns.test.js no longer declares INVENTORY_ITEMS_COLUMNS').not.toBeNull();
    const pinned = new Set([...decomment(list[1]).matchAll(/'(\w+)'/g)].map((m) => m[1]));
    // The lot is aliased `i` in every statement; the cache UPDATE's two SET targets are bare.
    const read = [...new Set([...helperSql.matchAll(/\bi\.(\w+)/g)].map((m) => m[1]))].sort();
    expect(read).toEqual(['category', 'created_by', 'deleted_at', 'id', 'source_kind', 'source_plant_id']);
    expect(helperSql).toMatch(/UPDATE public\.inventory_items i\s+SET source_plant_id = CASE/);
    expect(helperSql).toMatch(/END,\s+updated_at = NOW\(\)/);
    expect([...read, 'updated_at'].filter((c) => !pinned.has(c))).toEqual([]);
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The auditor's own two regexes, run over this file. The terminating `};` is mandatory — without
    // it _AUDIT_COLUMNS_DECL ignores the block with no warning and Phase 4 counts this relation as
    // uncovered, which is the ratchet going from 47 to 48.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(self).not.toMatch(/const\s+AUDIT_TABLES\s*=/);
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl, 'AUDIT_COLUMNS literal not found by the auditor pattern').not.toBeNull();
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual([TABLE]);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(CONTRACT);
  });
});
