// V5-PUTUPLOGRETIRE-001 R2a (B1) — the four pantry_item columns migrations/v5-pantryitemamount-001 adds
// (the amount as logged, and where it came from), as a keyed column contract for the schema audit.
//
// WHY A SEPARATE FILE AND NOT FOUR MORE NAMES IN pantry-columns.test.js: that file pins its pantry_item list
// EQUAL to v5-pantry-001's CREATE TABLE in both directions, so the four cannot go there without loosening
// its pin. Two files naming one relation are a set union per directory (kitchen-columns.test.js says so),
// and a keyed block is always its own file: parse_test_file returns on the keyed form first
// (scripts/dev-main-schema-audit.py), so dropped into another contract it would destroy that file's coverage.
//
// READ THIS BEFORE YOU TRUST A RED AUDIT: prod has none of these four until the DDL's own sitting, so a
// dispatched schema audit is RED on exactly these four pantry_item columns, and nothing else, until then.
// That red is the proof the audit covers them. No waiver is ever added for it (it would switch off the one
// thing that stops a promote of code naming columns prod lacks).
//
// The schema authority is v5-pantryitemamount-001/0a-additive-ddl.sql, parsed below. The vocabularies in
// its CHECKs are a FOURTH database copy of the kitchen units and a fourth of the source words; this file
// binds each to the list the route validates against, so a word added to one and not the other reds here.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KITCHEN_UNITS } from './kitchenBatch.js';
import { JAR_UNITS } from './jarRules.js';
import { VALID_SOURCE_KINDS } from './provenance.js';
import { handlePantryRoute, ITEM_CONSTRAINT_MESSAGES } from './pantryRoutes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dirname, '../../migrations/v5-pantryitemamount-001');

// A column NAMED IN A COMMENT is not a column reference.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();
const TEMPLATES = HANDLERS.flatMap((f) => [...decomment(readFileSync(resolve(__dirname, f), 'utf8'))
  .matchAll(/sql`([\s\S]*?)`/g)].map((m) => ({ file: f, sql: m[1] })));
const ITEM_SQL = TEMPLATES.filter((t) => t.file === 'pantryRoutes.js' && /\bpantry_item\b(?!_)/.test(t.sql));

const DDL = decomment(readFileSync(resolve(MIGRATION, '0a-additive-ddl.sql'), 'utf8'));
const GATES = readFileSync(resolve(MIGRATION, 'gates.yml'), 'utf8');

// L-081 KEYED contract — the columns the handlers name, per relation.
const AUDIT_COLUMNS = {
  pantry_item: ['quantity_value', 'quantity_unit', 'source_kind', 'source_label'],
};

// ── the migration, parsed ───────────────────────────────────────────────────────────────────────
const TYPE = String.raw`(uuid|text|date|timestamptz|integer|numeric|boolean|smallint)(\[\])?`;
function addedColumns(text, table) {
  return text.split(';')
    .filter((stmt) => new RegExp(String.raw`ALTER TABLE public\.${table}\b`).test(stmt))
    .flatMap((stmt) => [...stmt.matchAll(
      new RegExp(String.raw`ADD COLUMN (?:IF NOT EXISTS )?([a-z_]+)\s+${TYPE}`, 'g'))].map((m) => m[1]));
}
// The CHECKs 0a adds, by name, each with its own definition text (up to the next DROP or the statement end).
function addedChecks(text) {
  return [...text.matchAll(/ADD CONSTRAINT (chk_[a-z_]+)\s+CHECK \(([\s\S]*?)\)(?=,\s*DROP CONSTRAINT|;)/g)]
    .map((m) => ({ name: m[1], def: m[2] }));
}
const quoted = (s) => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]);
const checkDef = (name) => addedChecks(DDL).find((c) => c.name === name)?.def ?? '';
// A gate's SQL in gates.yml, from its name to the next gate.
const gateSql = (name) => {
  const at = GATES.indexOf(`- name: ${name}\n`);
  if (at < 0) return '';
  const next = GATES.indexOf('\n  - name: ', at + 1);
  return GATES.slice(at, next < 0 ? undefined : next);
};

describe('pantry item amount column contract — v5-pantryitemamount-001 is the authority', () => {
  it('the migration adds exactly these four to pantry_item (an empty parse fails here)', () => {
    // Mutation: write the 0a's ALTER TABLE without `public.`, or rename a column there.
    expect(addedColumns(DDL, 'pantry_item')).toEqual(['quantity_value', 'quantity_unit', 'source_kind', 'source_label']);
  });

  it('pins the contract to the DDL both directions', () => {
    expect([...addedColumns(DDL, 'pantry_item')].sort()).toEqual([...AUDIT_COLUMNS.pantry_item].sort());
  });

  it('the amount is numeric(10,2) and all four are nullable with no default', () => {
    const alter = DDL.split(';').find((s) => /ADD COLUMN IF NOT EXISTS quantity_value/.test(s));
    expect(alter).toMatch(/quantity_value numeric\(10,2\),/);
    expect(alter).toMatch(/quantity_unit\s+text,/);
    expect(alter).toMatch(/source_kind\s+text,/);
    expect(alter).toMatch(/source_label\s+text\s*$/);
    expect(alter).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it('adds no count, no remaining, no trigger, no FK and no index: the amount is as logged, never stock', () => {
    const body = DDL.slice(0, DDL.indexOf('INSERT INTO public.schema_version'));
    expect(body).not.toMatch(/\b(package_count|remaining_count|remaining_amount|delta_at|count_left|grams)\b/);
    expect(body).not.toMatch(/CREATE (OR REPLACE )?(TRIGGER|FUNCTION|INDEX|UNIQUE INDEX)|FOREIGN KEY|REFERENCES/);
  });
});

describe('the CHECK vocabularies are the lists the route validates against', () => {
  it('names nine CHECKs, each on pantry_item under the chk_pantry_item_ prefix', () => {
    expect(addedChecks(DDL).map((c) => c.name)).toEqual([
      'chk_pantry_item_quantity_pairing', 'chk_pantry_item_quantity_value', 'chk_pantry_item_quantity_unit',
      'chk_pantry_item_source_kind', 'chk_pantry_item_source_label_nonblank', 'chk_pantry_item_source_label_len',
      'chk_pantry_item_source_label_kind', 'chk_pantry_item_source_other', 'chk_pantry_item_source_plant',
    ]);
  });

  it('chk_pantry_item_quantity_unit carries exactly KITCHEN_UNITS, the 25, and none of the jar plurals', () => {
    // Mutation: add 'lbs' to the 0a's list, or drop 'pinch' from it.
    const units = quoted(checkDef('chk_pantry_item_quantity_unit'));
    expect(units).toHaveLength(25);
    expect([...units].sort()).toEqual([...KITCHEN_UNITS].sort());
    const plurals = JAR_UNITS.filter((u) => !KITCHEN_UNITS.includes(u));
    expect(plurals).toHaveLength(10);
    expect(units.filter((u) => plurals.includes(u))).toEqual([]);
  });

  it('chk_pantry_item_source_kind carries exactly VALID_SOURCE_KINDS, the eight', () => {
    const kinds = quoted(checkDef('chk_pantry_item_source_kind'));
    expect(kinds).toHaveLength(8);
    expect([...kinds].sort()).toEqual([...VALID_SOURCE_KINDS].sort());
  });

  it('the gates walk the same two lists (a word lost from the 0a is named by a gate, and the gate knows every word)', () => {
    expect(quoted(gateSql('post_item_unit_check_carries_the_kitchen_units').split('WHERE EXISTS')[0]).sort())
      .toEqual([...KITCHEN_UNITS].sort());
    expect(quoted(gateSql('post_item_unit_check_admits_no_legacy_plural').split('WHERE EXISTS')[0]).sort())
      .toEqual(JAR_UNITS.filter((u) => !KITCHEN_UNITS.includes(u)).sort());
  });

  it('the amount CHECK refuses NaN as well as zero and below (numeric NaN sorts above every number)', () => {
    expect(checkDef('chk_pantry_item_quantity_value').replace(/\s+/g, ' '))
      .toBe("quantity_value IS NULL OR (quantity_value > 0 AND quantity_value <> 'NaN')");
  });

  it('the pairing, the two name rules and name-needs-a-source are the text the route\'s validators mirror', () => {
    // The gates compare five source CHECKs with the put-up's and walk the unit list; the PAIRING, the VALUE
    // and NAME-NEEDS-A-SOURCE definitions are read by no gate (measured: a loosened one passes `post`). Their
    // text is pinned here and above, so a loosened 0a reds in CI.
    const def = (name) => checkDef(name).replace(/\s+/g, ' ');
    expect(def('chk_pantry_item_quantity_pairing')).toBe('(quantity_value IS NULL) = (quantity_unit IS NULL)');
    expect(def('chk_pantry_item_source_label_kind')).toBe('source_label IS NULL OR source_kind IS NOT NULL');
    expect(def('chk_pantry_item_source_label_nonblank')).toBe("source_label IS NULL OR btrim(source_label) <> ''");
    expect(def('chk_pantry_item_source_label_len')).toBe('source_label IS NULL OR char_length(source_label) <= 120');
  });

  it('Other-needs-a-name is the NULL-safe form, and the planting rule has no `IS NOT NULL) OR` arm', () => {
    expect(checkDef('chk_pantry_item_source_other').replace(/\s+/g, ' '))
      .toBe("source_kind IS DISTINCT FROM 'other' OR COALESCE(btrim(source_label), '') <> ''");
    expect(checkDef('chk_pantry_item_source_plant').replace(/\s+/g, ' '))
      .toBe("source_kind IS NULL OR source_kind = 'own_garden' OR plant_id IS NULL");
  });
});

describe('every CHECK the 0a adds answers in words through the route', () => {
  const PLACE = '99999999-aaaa-4bbb-8ccc-000000000002';
  const ITEM = '99999999-aaaa-4bbb-8ccc-000000000001';
  const KEY = '11111111-1111-4222-8333-444444444444';
  const failing = (constraint) => {
    const queue = [[{ id: PLACE, label: 'Pantry shelf', kind: 'pantry' }], Object.assign(new Error('23514'), { code: '23514', constraint })];
    return () => {
      const next = queue.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
  };
  const NAMES = addedChecks(DDL).map((c) => c.name);

  it('found the nine in the file, so the loop below is not vacuous', () => {
    expect(NAMES).toHaveLength(9);
  });

  it.each(NAMES)('%s: a 23514 on the create is a 400 in words, never a raw constraint name', async (name) => {
    const res = await handlePantryRoute({
      sql: failing(name), rawPath: '/api/pantry/items', method: 'POST', userId: 'user_dave', householdIds: ['user_dave'],
      rawBody: JSON.stringify({ idempotency_key: KEY, name: 'Rice', storage_location_id: PLACE }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ITEM_CONSTRAINT_MESSAGES[name]);
    expect(res.body.error).not.toMatch(/chk_|constraint/i);
  });

  it.each(NAMES)('%s: a 23514 on the PATCH is a 400 in words', async (name) => {
    const queue = [Object.assign(new Error('23514'), { code: '23514', constraint: name })];
    const res = await handlePantryRoute({
      sql: () => Promise.reject(queue.shift()), rawPath: `/api/pantry/items/${ITEM}`, method: 'PATCH',
      userId: 'user_dave', householdIds: ['user_dave'], rawBody: JSON.stringify({ notes: 'x' }),
    });
    expect(res).toEqual({ status: 400, body: { error: ITEM_CONSTRAINT_MESSAGES[name] } });
  });
});

describe('the contract matches the SQL that is actually issued', () => {
  it('found the item statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toEqual(expect.arrayContaining(['pantryRoutes.js', 'pantryItems.js']));
    // the list's items arm, the create, the replay, the PATCH, the soft delete
    expect(ITEM_SQL.length).toBeGreaterThanOrEqual(5);
  });

  it('binds the declared relation', () => {
    for (const rel of Object.keys(AUDIT_COLUMNS)) {
      expect(ITEM_SQL.map((t) => t.sql).join('\n'), rel).toMatch(new RegExp(String.raw`(?:FROM|JOIN|INTO|UPDATE)\s+${rel}\b(?!_)`));
    }
  });

  it('the create INSERT lists the four in a plain parenthesised column list (what the prod schema gate reads)', () => {
    const create = ITEM_SQL.find((t) => /INSERT INTO pantry_item \(/.test(t.sql)).sql;
    const list = create.slice(create.indexOf('INSERT INTO pantry_item (') + 'INSERT INTO pantry_item ('.length);
    const columns = list.slice(0, list.indexOf(')')).split(',').map((s) => s.trim());
    expect(columns).toEqual(expect.arrayContaining(AUDIT_COLUMNS.pantry_item));
    expect(columns.every((c) => /^[a-z_]+$/.test(c)), columns.join(' | ')).toBe(true);
  });

  it('every statement that returns an item row names all four: the create, the replay, the PATCH, the list', () => {
    const returning = ITEM_SQL.filter((t) => /RETURNING id, user_id, name/.test(t.sql));
    expect(returning).toHaveLength(2);   // the create and the PATCH
    for (const { sql } of returning) {
      const list = sql.slice(sql.indexOf('RETURNING id, user_id, name'));
      for (const c of AUDIT_COLUMNS.pantry_item) expect(list.slice(0, list.indexOf(')')), c).toMatch(new RegExp(String.raw`\b${c}\b`));
    }
    const selects = ITEM_SQL.filter((t) => /SELECT i\.id, i\.user_id, i\.name/.test(t.sql));
    expect(selects).toHaveLength(2);     // the list's items arm and the replay
    for (const { sql } of selects) {
      const list = sql.slice(0, sql.indexOf('FROM pantry_item i'));
      for (const c of AUDIT_COLUMNS.pantry_item) expect(list, c).toMatch(new RegExp(String.raw`\bi\.${c}\b`));
    }
  });

  it('the PATCH writes each of the four behind a presence flag, household-scoped', () => {
    const patch = ITEM_SQL.find((t) => /UPDATE pantry_item SET\s+name/.test(t.sql)).sql;
    for (const c of AUDIT_COLUMNS.pantry_item) {
      expect(patch, c).toMatch(new RegExp(String.raw`\b${c}\s+= CASE WHEN \$\{p\.[a-z_]+\}::boolean THEN \$\{[a-z_.]+\}::(numeric|text) ELSE ${c} END`));
    }
    expect(patch).toMatch(/user_id = ANY\(\$\{householdIds\}\)/);
  });

  // The batch builder, the line routes and the line search read pantry_item through their own aliases, and
  // batchbuilder-columns.test.js pins those reads to its own list: none of the four is on it.

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
