// Put-Up release 4 — the relations recipeRoutes.js (and kitchenRoutes.js's recipe hunks) read and write.
//
// A NEW FILE, never a block in kitchen-columns.test.js: scripts/dev-main-schema-audit.py reads the keyed
// AUDIT_COLUMNS form per file and credits a contract to the handler's OWN directory as a set union, so naming
// kitchen_batch / v_kitchen_batch_current again here costs nothing and leaves that file's pins untouched
// (other B′ lanes edit it concurrently).
//
// WITHOUT THIS FILE the Phase 4 ratchet (scripts/schema-audit-join-baseline.json, uncovered_relations may fall and
// never rise) would take three new uncovered relations (recipe, recipe_ingredient, recipe_type) and fail.
//
// READ THIS BEFORE YOU TRUST A GREEN AUDIT: the three recipe relations and kitchen_batch.recipe_id DO NOT EXIST in
// prod until migrations/v5-recipes-001 is applied, so `L-081 Schema Audit (dev)` fails at Phase 4(a) from the
// moment this lands on dev until B′'s sitting applies it — the guard doing its job; the DDL goes in before the
// promote, exactly as for the kitchen relations.
//
// Static source inspection rather than import: these handlers sit beside index.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');
const sqlOf = (f) => [...decomment(readFileSync(resolve(__dirname, f), 'utf8')).matchAll(/sql`([\s\S]*?)`/g)]
  .map((m) => m[1]).join('\n');
const RECIPE_SQL = sqlOf('recipeRoutes.js');
const KITCHEN_SQL = sqlOf('kitchenRoutes.js');
const SQL = `${RECIPE_SQL}\n${KITCHEN_SQL}`;
const DDL = decomment(readFileSync(resolve(__dirname, '../../migrations/v5-recipes-001/0a-additive-ddl.sql'), 'utf8'));

// L-081 KEYED contract — what the handlers NAME.
const AUDIT_COLUMNS = {
  recipe: [
    'bottle_cooked', 'bottle_label', 'bottle_size', 'bottle_unit', 'created_at', 'deleted_at', 'id',
    'idempotency_key', 'keeps_n', 'keeps_storage_kind', 'keeps_unit', 'kind', 'link_url', 'made_g', 'made_text',
    'mash_in_g', 'name', 'no_salt', 'notes', 'recipe_type_id', 'updated_at', 'user_id', 'vessel_count',
    'vessel_label', 'vessel_size', 'vessel_unit',
  ],
  recipe_ingredient: [
    'amount_text', 'at_the_end', 'base_from', 'base_g', 'brand', 'deleted_at', 'form', 'id', 'name', 'note',
    'ordinal', 'qty', 'qty_unit', 'recipe_id', 'role', 'salt_base', 'salt_method', 'salt_pct', 'shu_rating_high',
    'shu_rating_low',
  ],
  recipe_type: ['created_at', 'deleted_at', 'id', 'label', 'sort_order', 'user_id'],
  kitchen_batch: ['id', 'recipe_id', 'recipe_ref'],
  v_kitchen_batch_current: [
    'brine_note', 'closed_at', 'current_stage_kind', 'deleted_at', 'first_recorded_at', 'id', 'kind', 'label',
    'no_salt', 'notes', 'outcome', 'output_count', 'recipe_id', 'recipe_ref', 'start_precision', 'started_at',
    'suspended_at', 'user_id', 'vessel_count', 'vessel_label', 'vessel_size', 'vessel_unit',
  ],
  kitchen_batch_input: [
    'added_at', 'base_from', 'base_g', 'batch_id', 'brand', 'deleted_at', 'form', 'id', 'label', 'note', 'ordinal',
    'put_up_stage_id', 'qty', 'qty_unit', 'role', 'salt_base', 'salt_method', 'salt_pct', 'shu_rating_high',
    'shu_rating_low', 'source_label',
  ],
  kitchen_stage_log: ['amount', 'amount_unit', 'batch_id', 'created_at', 'entered_at', 'id', 'mash_in_g', 'note', 'stage_kind', 'voids_id'],
  preservation_log: [
    'batch_id', 'container_label', 'cooked', 'created_at', 'deleted_at', 'id', 'package_count', 'put_up_stage_id',
    'quantity_unit', 'quantity_value',
  ],
};

function createTableColumns(table) {
  const at = DDL.search(new RegExp(String.raw`CREATE TABLE IF NOT EXISTS public\.${table} \(`));
  if (at < 0) return null;
  const block = DDL.slice(at, DDL.indexOf('\n);', at));
  return [...block.matchAll(/^ {2}([a-z_]+)\s+(uuid|text|timestamptz|integer|numeric|boolean|smallint)\b/gm)].map((m) => m[1]);
}

describe('recipe column contract — v5-recipes-001 is the authority', () => {
  it('parses the migration, so the assertions below are against something real', () => {
    expect(createTableColumns('recipe')).toHaveLength(26);
    expect(createTableColumns('recipe_ingredient')).toHaveLength(21);
    expect(createTableColumns('recipe_type')).toHaveLength(7);
  });

  it('declares no column the migration does not create (a 42703 in prod otherwise)', () => {
    for (const table of ['recipe', 'recipe_ingredient', 'recipe_type']) {
      const real = new Set(createTableColumns(table));
      expect(AUDIT_COLUMNS[table].filter((c) => !real.has(c)), table).toEqual([]);
    }
    expect(DDL).toMatch(/ALTER TABLE public\.kitchen_batch\s+ADD COLUMN IF NOT EXISTS recipe_id uuid/);
    expect(DDL).toMatch(/b\.recipe_ref,\s+b\.recipe_id\s+FROM public\.kitchen_batch b/);
  });

  it('no pH column is created or declared, ever (V4 "pH")', () => {
    for (const table of ['recipe', 'recipe_ingredient', 'recipe_type']) {
      expect(createTableColumns(table).filter((c) => /(^|_)ph(_|$)|tested/.test(c)), table).toEqual([]);
    }
    expect(Object.values(AUDIT_COLUMNS).flat().filter((c) => /(^|_)ph(_|$)|tested/.test(c))).toEqual([]);
  });
});

describe('the contract matches the SQL that is actually issued', () => {
  it('found the SQL', () => {
    expect(RECIPE_SQL.length).toBeGreaterThan(2000);
  });

  it('binds every declared relation', () => {
    for (const rel of Object.keys(AUDIT_COLUMNS)) {
      expect(SQL, rel).toMatch(new RegExp(String.raw`(?:FROM|JOIN|INTO|UPDATE)\s+${rel}\b`));
    }
  });

  it('references every column it declares', () => {
    for (const [table, cols] of Object.entries(AUDIT_COLUMNS)) {
      const missing = cols.filter((c) => !new RegExp(String.raw`\b${c}\b`).test(SQL));
      expect(missing, table).toEqual([]);
    }
  });

  it('every recipe column recipeRoutes.js names is declared (the ratchet for a later edit)', () => {
    const all = new Set([...createTableColumns('recipe'), ...createTableColumns('recipe_ingredient'), ...createTableColumns('recipe_type')]);
    const declared = new Set([...AUDIT_COLUMNS.recipe, ...AUDIT_COLUMNS.recipe_ingredient, ...AUDIT_COLUMNS.recipe_type]);
    const named = [...all].filter((c) => new RegExp(String.raw`\b(?:r|i|t|d)\.${c}\b`).test(RECIPE_SQL));
    expect(named.filter((c) => !declared.has(c))).toEqual([]);
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
