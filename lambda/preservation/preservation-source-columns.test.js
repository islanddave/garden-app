// V5-PUTUPMULTISOURCE-001 / L-081 — the relation sourceRoutes.js reads and writes.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN kitchen-columns.test.js: parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into an existing contract
// file SILENTLY DESTROYS that file's own coverage. kitchen-columns.test.js's header states the rule
// in one line — "Always a new file" — and this is that new file.
//
// WHY IT EXISTS AT ALL. L-081: a new relation is its own contract, shipped in the same change as the
// query. Without this file the Phase 4 ratchet (scripts/schema-audit-join-baseline.json,
// uncovered_relations — may fall and never rise) takes preservation_source as a new uncovered
// relation and fails. The correct edit is always a contract, never a raised baseline.
//
// READ THIS BEFORE YOU TRUST A GREEN AUDIT: preservation_source DOES NOT EXIST in prod until
// migrations/v5-putupmultisource-001 is applied, so `L-081 Schema Audit (dev)` fails at Phase 4(a)
// ("a relation queried by a handler does not exist in prod") from the moment this lands until Dave
// applies it. That is the guard doing its job and it is exactly why the DDL goes in before the
// promote — the same state kitchen-columns.test.js recorded for the four kitchen relations.
//
// BOTH RELATIONS ARE DECLARED HERE, and preservation_log is declared twice across this directory on
// purpose. Declarations are a set union per directory, so naming it again costs nothing — and
// without it the six parent columns THIS handler writes (the ordinal-0 cache) are declared nowhere:
// kitchen-columns.test.js's preservation_log entry does not carry source_kind or source_label, and
// select-columns.test.js's AUDIT_TABLES form scans index.js's SQL only. A 42703 on the cache write
// would reach prod green.
//
// Static source inspection rather than import: these handlers sit beside index.js, which loads
// @neondatabase/serverless and @clerk/backend at module scope.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. Without this the header above — which names
// source_kind and source_label while explaining why they must be declared — would itself satisfy the
// assertion that the SQL references them.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

const HANDLER = 'sourceRoutes.js';
const SRC = decomment(readFileSync(resolve(__dirname, HANDLER), 'utf8'));
// ONE ENTRY PER TAGGED TEMPLATE, kept as a list as well as a join. The statements this handler issues
// contain NO semicolons — the driver supplies them — so splitting the joined text on ';' yields one
// giant pseudo-statement and every per-statement assertion below silently degrades to a whole-file
// assertion. That is not hypothetical: the first draft of this file did exactly that and its
// household-scope check passed while examining a single blob.
const SQL_BLOCKS = [...SRC.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]);
const SQL = SQL_BLOCKS.join('\n');

const DDL_PATH = resolve(__dirname, '../../migrations/v5-putupmultisource-001/0a-additive-ddl.sql');
const DDL = readFileSync(DDL_PATH, 'utf8');

// L-081 KEYED contract. preservation_source comes from the migration, which is the schema authority;
// preservation_log is pre-existing and its entry lists ONLY the columns this handler names.
const AUDIT_COLUMNS = {
  preservation_source: [
    'created_at', 'crop_type_slug', 'deleted_at', 'display_label', 'harvest_log_id', 'id', 'note',
    'ordinal', 'plant_id', 'preservation_log_id', 'provenance_grade', 'quantity_unit',
    'quantity_value', 'source_kind', 'source_label', 'updated_at', 'user_id', 'variety_id',
  ],
  // THE CACHE WRITE. These six plus the three the ownership loader and the scoping predicates need.
  preservation_log: [
    'crop_type_slug', 'deleted_at', 'harvest_log_id', 'id', 'plant_id', 'source_kind',
    'source_label', 'updated_at', 'user_id', 'variety_id',
  ],
};

// ── the migration, parsed ───────────────────────────────────────────────────────────────────────
// Column names of the CREATE TABLE block: two-space indent, a name, then a known type. CONSTRAINT
// lines share the indent but their second token is never a type, so they fall out on their own.
// `smallint` and `numeric` are in the type list because this table uses both and a type the regex
// does not know is a column the parity assertion below silently stops covering.
function ddlColumns() {
  const at = DDL.indexOf('CREATE TABLE IF NOT EXISTS public.preservation_source (');
  expect(at, 'no CREATE TABLE for preservation_source').toBeGreaterThan(-1);
  const block = DDL.slice(at, DDL.indexOf('\n);', at));
  return [...block.matchAll(
    /^ {2}([a-z_]+)\s+(uuid|text|timestamptz|integer|numeric|boolean|smallint)\b/gm,
  )].map((m) => m[1]);
}

describe('the preservation_source contract matches the migration', () => {
  it('found the DDL and the handler, so nothing below is vacuous', () => {
    expect(DDL.length).toBeGreaterThan(2000);
    expect(SQL.length).toBeGreaterThan(500);
    expect(ddlColumns().length).toBeGreaterThan(10);
  });

  it('declares every column the CREATE TABLE creates, and no column it does not', () => {
    // Both directions. A contract that omits a column lets a 42703 through; one that names a column
    // the table does not have makes the prod audit assert a shape that cannot exist.
    expect([...AUDIT_COLUMNS.preservation_source].sort())
      .toEqual([...ddlColumns()].sort());
  });

  it('declares the keystone columns by name', () => {
    // Mutation: drop either from the array. display_label NOT NULL is the identity rule that retires
    // the 23514 deferral; provenance_grade stored-not-derived is what keeps "he knew, and the
    // planting is gone" distinguishable. A contract that stopped naming them would let a migration
    // that dropped them pass the audit.
    expect(AUDIT_COLUMNS.preservation_source).toContain('display_label');
    expect(AUDIT_COLUMNS.preservation_source).toContain('provenance_grade');
  });
});

describe('the contract matches the SQL that is actually issued', () => {
  it('binds every declared relation', () => {
    for (const rel of Object.keys(AUDIT_COLUMNS)) {
      expect(SQL, rel).toMatch(new RegExp(String.raw`(?:FROM|JOIN|INTO|UPDATE)\s+${rel}\b`));
    }
  });

  it('references every column it declares', () => {
    // The direction that keeps a contract honest: an array naming columns the SQL no longer touches
    // keeps passing the prod audit while auditing nothing real.
    for (const table of Object.keys(AUDIT_COLUMNS)) {
      const missing = AUDIT_COLUMNS[table]
        .filter((c) => !new RegExp(String.raw`\b${c}\b`).test(SQL));
      expect(missing, `${table} declares columns no statement references`).toEqual([]);
    }
  });

  it('writes the four cache columns unconditionally, not through COALESCE', () => {
    // THE INVARIANT THE WHOLE MIGRATION RESTS ON (0a header D1), asserted against the statement.
    // A COALESCE on plant_id would retain a pointer from a previous edit whose source row is now
    // soft-deleted — the "false-provenance generator" shape v4-putupprov-001 rejects a DEFAULT for.
    // Mutation: wrap any of these four in COALESCE and this reds.
    for (const c of ['source_kind', 'source_label', 'plant_id', 'harvest_log_id']) {
      expect(SQL, c).toMatch(new RegExp(String.raw`${c} = \$\{[^}]+\}::`));
      expect(SQL, `${c} must not be COALESCE-preserved`)
        .not.toMatch(new RegExp(String.raw`${c} = COALESCE`));
    }
    // The positive control for the assertion above: two columns that ARE deliberately COALESCEd, so
    // "not COALESCE" is a real distinction here rather than an absence over an empty set.
    expect(SQL).toMatch(/crop_type_slug = COALESCE/);
    expect(SQL).toMatch(/variety_id = COALESCE/);
  });

  it('casts every nullable bound parameter', () => {
    // Neon cannot infer a type for a null bound parameter and answers `could not determine data type
    // of parameter` — a 500, not a 400. Bought-ingredient rows omit four of these at once, so an
    // uncast parameter fails on the COMMON path. Mutation: strip a ::uuid from the INSERT.
    // The INSERT's OWN block, not a slice of the joined text — a slice would run on into the next
    // statement and count its casts as this one's.
    const insert = SQL_BLOCKS.find((b) => /INSERT INTO preservation_source/.test(b));
    expect(insert, 'no INSERT block found').toBeTruthy();
    for (const cast of ['::uuid', '::text', '::smallint', '::numeric']) {
      expect(insert, cast).toContain(cast);
    }
    // Every interpolation inside the VALUES list carries a cast — counted rather than spot-checked.
    const values = insert.slice(insert.indexOf('VALUES'));
    const holes = [...values.matchAll(/\$\{[^}]+\}(::[a-z]+)?/g)];
    expect(holes.length, 'VALUES list did not parse').toBeGreaterThan(10);
    expect(holes.filter((h) => !h[1]).length, 'uncast bound parameter in the INSERT').toBe(0);
  });

  it('scopes every statement to the household', () => {
    // Mutation: change any predicate to `= ${userId}`. Ownership is a household fact in this app and
    // a single-owner predicate would hide Jen's rows from Dave and vice versa.
    const statements = SQL_BLOCKS.filter((s) => /\b(SELECT|UPDATE|INSERT)\b/.test(s));
    expect(statements.length, 'per-statement split collapsed').toBeGreaterThan(3);
    for (const s of statements) {
      if (/INSERT INTO preservation_source/.test(s)) continue; // scoped by the loaded parent row
      expect(s, 'statement missing household scope').toMatch(/user_id = ANY\(/);
    }
    expect(SQL).not.toMatch(/user_id = \$\{userId\}/);
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The parser reads THIS FILE'S OWN SOURCE TEXT for the literal. A contract computed at runtime
    // would satisfy every assertion above and be invisible to the audit.
    const self = readFileSync(resolve(__dirname, 'preservation-source-columns.test.js'), 'utf8');
    expect(self).toMatch(/const AUDIT_COLUMNS = \{/);
    expect(self).toMatch(/preservation_source: \[/);
  });
});
