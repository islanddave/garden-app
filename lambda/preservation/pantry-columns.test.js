// OPS-SCHEMAAUDITJOIN-001 / Put-Up release 2 (B′) — the pantry_item columns lambda/preservation reads and
// writes, and the one column release 2 adds to kitchen_batch_input (V4 §5.6 "a *-columns.test.js contract").
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN kitchen-columns.test.js / select-columns.test.js: parse_test_file
// returns on the keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py), so a keyed block dropped into another contract file SILENTLY
// DESTROYS that file's own coverage. Always a new file. The keyed form binds columns to ONE relation each,
// and two files naming kitchen_batch_input are a set union per directory (kitchen-columns.test.js says so).
//
// WITHOUT THIS FILE the Phase 4 ratchet (scripts/schema-audit-join-baseline.json, may fall and never rise)
// would count pantry_item as a new uncovered relation for this directory and refuse the promote.
//
// READ THIS BEFORE YOU TRUST A GREEN AUDIT: pantry_item does not exist in prod until migrations/
// v5-pantry-001 is applied in B′'s sitting, so a dispatched schema audit stops at Phase 4(a) on it until
// then — the same state the kitchen tables and pantry_use were in before their DDL.
//
// The schema authority is v5-pantry-001/0a-additive-ddl.sql, parsed below. Static source inspection rather
// than import for the SQL: these handlers sit beside index.js, which loads neon/clerk at module scope.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();
const TEMPLATES = HANDLERS.flatMap((f) => [...decomment(readFileSync(resolve(__dirname, f), 'utf8'))
  .matchAll(/sql`([\s\S]*?)`/g)].map((m) => ({ file: f, sql: m[1] })));
const SQL = TEMPLATES.map((t) => t.sql).join('\n');

const DDL = decomment(readFileSync(resolve(__dirname, '../../migrations/v5-pantry-001/0a-additive-ddl.sql'), 'utf8'));

// L-081 KEYED contract — the columns the handlers name, per relation.
const AUDIT_COLUMNS = {
  pantry_item: [
    'acquired_at', 'acquired_precision', 'created_at', 'crop_type_slug', 'deleted_at', 'id', 'idempotency_key',
    'name', 'notes', 'plant_id', 'storage_location_id', 'updated_at', 'use_by_target', 'used_up_at', 'user_id',
  ],
  kitchen_batch_input: ['pantry_item_id'],
};

// ── the migration, parsed ───────────────────────────────────────────────────────────────────────
const TYPE = String.raw`(uuid|text|date|timestamptz|integer|numeric|boolean|smallint)(\[\])?`;
function createTableColumns(text, table) {
  const at = text.search(new RegExp(String.raw`CREATE TABLE (IF NOT EXISTS )?public\.${table} \(`));
  if (at < 0) return null;
  const block = text.slice(at, text.indexOf('\n);', at));
  return [...block.matchAll(new RegExp(String.raw`^ {2}([a-z_]+)\s+${TYPE}\b`, 'gm'))].map((m) => m[1]);
}
function addedColumns(text, table) {
  return text.split(';')
    .filter((stmt) => new RegExp(String.raw`ALTER TABLE public\.${table}\b`).test(stmt))
    .flatMap((stmt) => [...stmt.matchAll(
      new RegExp(String.raw`ADD COLUMN (?:IF NOT EXISTS )?([a-z_]+)\s+${TYPE}`, 'g'))].map((m) => m[1]));
}

describe('pantry column contract — v5-pantry-001 is the authority', () => {
  it('parses the migration, so the assertions below are against something real', () => {
    expect(createTableColumns(DDL, 'pantry_item')).toHaveLength(15);
    expect(addedColumns(DDL, 'kitchen_batch_input')).toEqual(['pantry_item_id']);
  });

  it('pins pantry_item to the DDL both directions (the handlers name every column the table has)', () => {
    // Mutation: rename `used_up_at` in the 0a, or add a column there without adding it here.
    expect([...createTableColumns(DDL, 'pantry_item')].sort()).toEqual([...AUDIT_COLUMNS.pantry_item].sort());
  });

  it('adds nothing F created (06 §1.3: no pantry_use, no delta_at, no remaining_amount)', () => {
    expect(DDL).not.toMatch(/CREATE TABLE[^;]*pantry_use/);
    expect(DDL).not.toMatch(/ADD COLUMN[^;,]*\b(delta_at|remaining_amount)\b/);
    expect(addedColumns(DDL, 'preservation_log')).toEqual([]);
    expect(addedColumns(DDL, 'pantry_use')).toEqual([]);
  });
});

describe('the contract matches the SQL that is actually issued', () => {
  it('found the Pantry handlers, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toEqual(expect.arrayContaining(['pantryRoutes.js', 'pantryItems.js', 'lineRoutes.js']));
    expect(TEMPLATES.filter((t) => /\bpantry_item\b(?!_)/.test(t.sql)).length).toBeGreaterThanOrEqual(6);
  });

  it('binds every declared relation', () => {
    for (const rel of Object.keys(AUDIT_COLUMNS)) {
      expect(SQL, rel).toMatch(new RegExp(String.raw`(?:FROM|JOIN|INTO|UPDATE)\s+${rel}\b(?!_)`));
    }
  });

  it('references every column it declares', () => {
    const pantrySql = TEMPLATES.filter((t) => /\bpantry_item\b(?!_)/.test(t.sql)).map((t) => t.sql).join('\n');
    const missing = AUDIT_COLUMNS.pantry_item.filter((c) => !new RegExp(String.raw`\b${c}\b`).test(pantrySql));
    expect(missing).toEqual([]);
    expect(SQL).toMatch(/\bi\.pantry_item_id\b/);   // readLines returns it
    expect(SQL).toMatch(/created_by, pantry_item_id\s*\)/);   // the keyed line INSERT writes it
  });

  it('every pantry_item write is household-scoped or owner-stamped, and never ON CONFLICT on the item', () => {
    const writes = TEMPLATES.filter((t) => /(?:UPDATE|INSERT INTO)\s+pantry_item\b(?!_)/.test(t.sql));
    expect(writes.length).toBeGreaterThanOrEqual(3);   // create, PATCH, soft delete (and merge.js lives in plants)
    for (const { sql } of writes) {
      if (/UPDATE\s+pantry_item\b/.test(sql)) expect(sql).toMatch(/user_id = ANY\(\$\{householdIds\}\)/);
      const ins = sql.indexOf('INSERT INTO pantry_item');
      if (ins >= 0) expect(sql.slice(ins)).not.toMatch(/ON CONFLICT/);
    }
    // Soft deletes only (V4 §5.2): no statement deletes a pantry item.
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+pantry_item\b/);
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(Object.keys(AUDIT_COLUMNS));
    for (const [, key, body] of pairs) {
      const cols = [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
      expect(cols, key).toEqual(AUDIT_COLUMNS[key]);
    }
  });
});
