// OPS-SCHEMAAUDITJOIN-001 / V5-INFLIGHTBATCH-001 — the relations kitchenRoutes.js reads and writes.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the keyed
// AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into an existing contract file
// SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHY ALL FIVE IN ONE FILE: the keyed form binds columns to ONE relation each and does not
// cross-product, so several relations can share a file without asserting each other's columns. Phase 4
// credits a contract to the handler's OWN directory and only when the AUDIT_COLUMNS literal is in this
// file's own source text — that is why it lives here rather than beside a sibling Lambda.
//
// WITHOUT THIS FILE the Phase 4 ratchet (scripts/schema-audit-join-baseline.json, uncovered_relations
// = 48, may fall and never rise) would take five new uncovered relations at once and fail. The correct
// edit is always a contract, never a raised baseline.
//
// READ THIS BEFORE YOU TRUST A GREEN AUDIT: the four kitchen relations DO NOT EXIST in prod until
// migrations/v5-inflightbatch-001 is applied, so `L-081 Schema Audit (dev)` fails at Phase 4(a)
// ("a relation queried by a handler does not exist in prod") from the moment this lands until Dave
// applies it. That is the guard doing its job and it is exactly why the DDL goes in before the
// promote — the same state select-columns.test.js recorded for preserved_at_approx.
//
// Static source inspection rather than import: these handlers sit beside index.js, which loads
// @neondatabase/serverless and @clerk/backend at module scope.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk so a handler
// added here is covered the day it lands rather than the day someone remembers a list.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

const SQL = HANDLERS
  .map((f) => decomment(readFileSync(resolve(__dirname, f), 'utf8')))
  .flatMap((src) => [...src.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]))
  .join('\n');

const DDL_PATH = resolve(__dirname, '../../migrations/v5-inflightbatch-001/0a-additive-ddl.sql');
const DDL = readFileSync(DDL_PATH, 'utf8');

// L-081 KEYED contract. The three tables and the view come from
// migrations/v5-inflightbatch-001/0a-additive-ddl.sql, which is the schema authority; event_log is the
// pre-existing relation the predicate bulk-add reaches through (verified present on live prod Neon —
// it is the same relation lambda/event-log-columns.test.js contracts at the fleet root).
//
// THE COLUMN LISTS ARE WHAT THE HANDLER NAMES, not what the table has. kitchen_batch's
// first_recorded_at / created_at / updated_at are deliberately absent: the handler never writes them
// (the DEFAULT and the set_updated_at trigger own them) and never names them in a predicate, and a
// contract that declared a column nothing references makes Phase 1 assert something the code does not
// do. v_kitchen_batch_current is the exception and is pinned to the migration instead — see below.
const AUDIT_COLUMNS = {
  kitchen_batch: [
    'brine_note', 'closed_at', 'cover_photo_id', 'deleted_at', 'expected_days_max',
    'expected_days_min', 'id', 'kind', 'kind_other', 'label', 'notes', 'outcome', 'outcome_note',
    'start_anchor_id', 'start_anchor_kind', 'start_precision', 'started_at', 'suspended_at', 'user_id',
  ],
  kitchen_batch_input: [
    'added_at', 'batch_id', 'created_at', 'created_by', 'harvest_log_id', 'id', 'input_kind',
    'is_byproduct', 'label', 'note', 'qty', 'qty_unit',
  ],
  kitchen_stage_log: [
    'amount', 'amount_unit', 'batch_id', 'created_at', 'created_by', 'cue_observed', 'entered_at',
    'id', 'label', 'note', 'photo_id', 'stage_kind', 'storage_location_id',
  ],
  v_kitchen_batch_current: [
    'brine_note', 'closed_at', 'cover_photo_id', 'created_at', 'current_stage_entered_at',
    'current_stage_kind', 'current_stage_label', 'current_storage_location_id', 'deleted_at',
    'expected_days_max', 'expected_days_min', 'first_recorded_at', 'id', 'input_count', 'kind',
    'kind_other', 'label', 'notes', 'outcome', 'outcome_note', 'output_count', 'start_anchor_id',
    'start_anchor_kind', 'start_precision', 'started_at', 'suspended_at', 'updated_at', 'user_id',
  ],
  event_log: ['deleted_at', 'event_date', 'id', 'plant_id'],
  // V5-KBBATCHCLOSE. preservation_log was ALREADY a declared relation for this directory, through
  // select-columns.test.js's AUDIT_TABLES form — so the outputs read and the two link/unlink writes
  // in kitchenRoutes.js do not move uncovered_relations (it stands at 48; the correct edit is always
  // a contract, never a raised baseline). This keyed entry is here anyway because that other file
  // scans index.js's SQL only: without it, the columns kitchenRoutes.js names on this table are
  // declared NOWHERE and a 42703 in the outputs projection would reach prod green. The two
  // declarations are a set union per directory, so naming the table twice costs nothing.
  //
  // use_by_target is ABSENT, and that is the projection's own ruling rather than an oversight — see
  // the outputs query's comment. A contract that named it would push a later editor towards adding
  // it back.
  preservation_log: [
    'batch_id', 'consumed_at', 'created_at', 'crop_type_slug', 'deleted_at', 'harvest_log_id', 'id',
    'method', 'method_other_text', 'notes', 'package_count', 'photo_id', 'plant_id', 'preserved_at',
    'preserved_at_approx', 'quantity_unit', 'quantity_value', 'remaining_count',
    'storage_location_id', 'updated_at', 'user_id', 'variety_id',
  ],
};

// ── the migration, parsed ────────────────────────────────────────────────────────────────────────
// Column names of a CREATE TABLE block: two-space indent, then a name, then a known type. CONSTRAINT
// lines share the indent but their second token is never a type, so they fall out on their own.
function ddlTableColumns(table) {
  const at = DDL.indexOf(`CREATE TABLE public.${table} (`);
  expect(at, `no CREATE TABLE for ${table}`).toBeGreaterThan(-1);
  const block = DDL.slice(at, DDL.indexOf('\n);', at));
  return [...block.matchAll(/^ {2}([a-z_]+)\s+(uuid|text|timestamptz|integer|numeric|boolean)\b/gm)]
    .map((m) => m[1]);
}

// The view is `SELECT b.*` plus six derived aliases, so its projection IS kitchen_batch's columns plus
// those six. Derived rather than restated: that is what makes the AUDIT_COLUMNS entry above a parity
// assertion against the schema authority instead of a second hand-list to drift.
function ddlViewColumns() {
  const at = DDL.indexOf('CREATE VIEW public.v_kitchen_batch_current AS');
  expect(at).toBeGreaterThan(-1);
  const block = DDL.slice(at, DDL.indexOf('\n\n', at));
  expect(block).toContain('SELECT b.*');
  const derived = [...block.matchAll(/\bAS ([a-z_]+)/g)].map((m) => m[1]);
  return [...ddlTableColumns('kitchen_batch'), ...derived];
}

describe('V5-INFLIGHTBATCH-001 column contract — the migration is the authority', () => {
  it('parses the migration, so every assertion below is against something real', () => {
    // A broken parser would make this whole file vacuous by comparing two empty lists.
    expect(ddlTableColumns('kitchen_batch')).toHaveLength(22);
    expect(ddlTableColumns('kitchen_batch_input')).toHaveLength(12);
    expect(ddlTableColumns('kitchen_stage_log')).toHaveLength(13);
    expect(ddlViewColumns()).toHaveLength(28);
  });

  it('declares no column the migration does not create', () => {
    // The failure this catches is a 42703 in prod: a column name that is right in the handler's head
    // and wrong in the DDL passes every unit test in this repo, because none of them speak to a
    // database. Mutation: rename `brine_note` to `brine` in AUDIT_COLUMNS.
    for (const table of ['kitchen_batch', 'kitchen_batch_input', 'kitchen_stage_log']) {
      const real = new Set(ddlTableColumns(table));
      const phantom = AUDIT_COLUMNS[table].filter((c) => !real.has(c));
      expect(phantom, `${table} declares columns the migration does not create`).toEqual([]);
    }
  });

  it('pins the view projection to the migration, both directions', () => {
    // The list route is `SELECT *` from this view and the contract promises the client every one of
    // its columns, so this is the only place that shape can be asserted. Mutation: add a column to
    // kitchen_batch in the DDL without re-deriving here — or drop `output_count` from the list above.
    expect([...AUDIT_COLUMNS.v_kitchen_batch_current].sort()).toEqual([...ddlViewColumns()].sort());
  });

  it('keeps the six derived columns the contract names to the client', () => {
    for (const c of ['current_stage_kind', 'current_stage_label', 'current_stage_entered_at',
      'current_storage_location_id', 'input_count', 'output_count']) {
      expect(AUDIT_COLUMNS.v_kitchen_batch_current, c).toContain(c);
    }
  });

  it('never lets a client-writable column list reach first_recorded_at', () => {
    // "First recorded Sep 3" is the honest floor the card leads with when the start is unknown. The
    // handler must never name it in a write, and the reason it is absent from kitchen_batch's list is
    // that it is absent from every statement — not an oversight.
    expect(AUDIT_COLUMNS.kitchen_batch).not.toContain('first_recorded_at');
    expect(SQL).not.toMatch(/\bfirst_recorded_at\s*=/);
  });
});

describe('the contract matches the SQL that is actually issued', () => {
  it('found the handlers and their SQL, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toContain('kitchenRoutes.js');
    expect(SQL.length).toBeGreaterThan(2000);
  });

  it('binds every declared relation', () => {
    for (const rel of Object.keys(AUDIT_COLUMNS)) {
      expect(SQL, rel).toMatch(new RegExp(String.raw`(?:FROM|JOIN|INTO|UPDATE)\s+${rel}\b`));
    }
  });

  it('references every column it declares, for the three relations named column by column', () => {
    // The direction that keeps a contract honest: an array naming columns the SQL no longer touches
    // keeps passing the prod audit while auditing nothing real.
    for (const table of ['kitchen_batch', 'kitchen_batch_input', 'kitchen_stage_log', 'event_log',
      'preservation_log']) {
      const missing = AUDIT_COLUMNS[table].filter((c) => !new RegExp(String.raw`\b${c}\b`).test(SQL));
      expect(missing, `${table} declares columns no statement references`).toEqual([]);
    }
  });

  // The other direction for the one relation whose contract carries a RULING. use_by_target lives on
  // the read surfaces the pantry owns and must not reach the batch surface: composed with a recorded
  // outcome it becomes a shelf-stability endorsement this app does not make. The positive control is
  // the two columns that ARE declared — without it this is an absence over an empty list. The
  // statement-level half is asserted in kitchenRoutes.test.js, against the outputs query itself.
  // Mutation: add 'use_by_target' to the preservation_log contract.
  it('keeps the shelf-life columns off the batch-surface contract', () => {
    expect(AUDIT_COLUMNS.preservation_log).toContain('method');
    expect(AUDIT_COLUMNS.preservation_log).toContain('preserved_at');
    expect(AUDIT_COLUMNS.preservation_log).not.toContain('use_by_target');
    expect(AUDIT_COLUMNS.preservation_log).not.toContain('use_by_status');
  });

  it('reads the view with SELECT *, which is what makes its 28-column contract true', () => {
    // Mutation: narrow the list route to an explicit column list. The client would then silently lose
    // whichever columns the list omitted, and this contract would be asserting a shape nothing serves.
    expect(SQL).toMatch(/SELECT \* FROM v_kitchen_batch_current/);
  });

  it('names the view columns it filters and orders on', () => {
    for (const c of ['user_id', 'deleted_at', 'closed_at', 'started_at', 'first_recorded_at']) {
      expect(SQL, c).toMatch(new RegExp(String.raw`\b${c}\b`));
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with
    // NO warning and NO skip count, and Phase 4 keeps counting these relations as uncovered. A
    // misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and schema-audit.yml
    // maps exit 2 to a ::warning and exit 0, so one typo silences all four phases behind a green
    // check. Replicate the auditor's own two regexes against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual([
      'kitchen_batch', 'kitchen_batch_input', 'kitchen_stage_log', 'v_kitchen_batch_current',
      'event_log', 'preservation_log',
    ]);
    for (const [, key, body] of pairs) {
      const cols = [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
      expect(cols, key).toEqual(AUDIT_COLUMNS[key]);
    }
  });
});
