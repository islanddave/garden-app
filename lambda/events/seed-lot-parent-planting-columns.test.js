// OPS-SCHEMAAUDITJOIN-001 — the public.seed_lot_parent_planting columns lambda/events names.
//
// seed_lot_parent_planting holds the parent plantings of a saved-seed lot, one live row per
// (lot, planting, role) (schema_version 5.0.0-seedmultiparent-001). ONE statement in this directory
// names it: seedLotRewards.js, which asks whether a seed_saved event's planting is a LIVE
// seed_parent of the lot its metadata names, before that event's rewards are keyed on the jar
// (V5-SEEDMULTIPARENT-001 release 2a). It is a read, aliased `sl`, inside an EXISTS.
//
// WITHOUT THIS FILE the Phase 4 ratchet (scripts/schema-audit-join-baseline.json, uncovered_relations
// = 47, may fall and never rise) counts 48: a handler here queries a relation nothing in
// lambda/events declared. scripts/test_schema_audit_join_ratchet.py recomputes that DB-free in
// build-and-test. The correct edit is always a contract, never a raised baseline.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN AN EXISTING ONE: parse_test_file returns on the keyed
// AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector, so a keyed block dropped
// into select-columns.test.js would SILENTLY DESTROY that file's own coverage. Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in this
// file's own source text. lambda/plants and lambda/inventory-items declare the same relation for
// their own statements and credit nothing here.
//
// Static source inspection. That the statement RUNS, and what it matches, is tests/integration's job;
// seed-saved-lot-xp.test.js drives the handler over a recording mock and proves what is BOUND.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text` (scripts/dev-main-schema-audit.py, _decomment_js).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather than
// hardcoded, so a handler added here that touches the table is held to this contract the day it lands.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract: EVERY column of the table that any statement in lambda/events names. Four of
// the table's eight: this directory asks one yes/no question of a link and reads nothing off it.
const AUDIT_COLUMNS = {
  seed_lot_parent_planting: ['deleted_at', 'inventory_item_id', 'plant_id', 'role'],
};

const TABLE = 'seed_lot_parent_planting';
const CONTRACT_COLUMNS = AUDIT_COLUMNS[TABLE];

// Only SQL inside a tagged sql`` template counts. `IS [NOT] DISTINCT FROM x.col` carries the literal
// token FROM, so it is scrubbed before scanning, as the auditor does.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// FROM, JOIN and UPDATE bind the table. The alias group is OPTIONAL: an unaliased binding captures
// the next keyword, which NOT_AN_ALIAS rejects, and the unaliased count below must stay zero.
const bindings = (s) => [...s.matchAll(
  /\b(?:FROM|JOIN|UPDATE)\s+(?:public\.)?seed_lot_parent_planting\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?/gi,
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

const columnsOf = (s) => [...new Set(aliasesOf(s).flatMap((a) => [...s.matchAll(
  new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
)].map((m) => m[1].toLowerCase())))];

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1].replace(DISTINCT_FROM, ' '))
    .filter((s) => bindings(s).length > 0)
    .map((sql) => ({ file: f, sql }));
});

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/events seed_lot_parent_planting column contract', () => {
  it('finds the one seed_lot_parent_planting statement, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toContain('seedLotRewards.js');
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(STATEMENTS).toHaveLength(1);
    expect(STATEMENTS[0].file).toBe('seedLotRewards.js');
    expect(aliasesOf(STATEMENTS[0].sql)).toEqual(['sl']);
  });

  it('has no unaliased statement and no UPDATE on the table', () => {
    // An unaliased statement's bare identifiers are invisible to columnsOf(), and the tightness
    // assertion below would still pass. Nothing here needs one; if that changes, pin it by hand as
    // lambda/plants/seed-lot-parent-planting-columns.test.js does.
    expect(STATEMENTS.reduce((n, s) => n + unaliasedIn(s.sql), 0)).toBe(0);
    for (const { file, sql } of STATEMENTS) {
      expect(sql, file).not.toMatch(/\bUPDATE\s+(?:public\.)?seed_lot_parent_planting\b/i);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set(STATEMENTS.flatMap((s) => columnsOf(s.sql)))].sort();
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. Extra columns are not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing names makes the audit assert something the code never does.
    expect(referenced).toEqual([...CONTRACT_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // seed_lot_id is what a seed_saved event calls the lot in its METADATA, two lines below this
    // table's arm in the same statement; the column here is inventory_item_id. source_plant_id is
    // the inventory_items cache column. user_id / source_id are xp_events', in the third arm.
    const NOT_ON_TABLE = ['seed_lot_id', 'source_plant_id', 'user_id', 'source_id', 'event_type', 'metadata'];
    for (const col of NOT_ON_TABLE) {
      expect(CONTRACT_COLUMNS).not.toContain(col);
      for (const { file, sql } of STATEMENTS) {
        expect(sql, `${file}: sl.${col} is not a ${TABLE} column`)
          .not.toMatch(new RegExp(String.raw`\bsl\.${col}\b`, 'i'));
      }
    }
  });

  it('reads LIVE seed_parent links only, by lot and planting', () => {
    // The whole predicate. A retired link (deleted_at set) must not key a reward on the jar, and
    // 'pollen_parent' exists in the CHECK and nowhere in releases 1-3.
    expect(STATEMENTS[0].sql).toMatch(
      /FROM public\.seed_lot_parent_planting sl\s+WHERE sl\.inventory_item_id = \$\{lotId\}::uuid\s+AND sl\.plant_id = \$\{plantId\}::uuid\s+AND sl\.role = 'seed_parent'\s+AND sl\.deleted_at IS NULL/,
    );
  });

  it('never writes a link from this directory, and never names the second role', () => {
    // Links are written by lambda/inventory-items, under the lot's ownership predicate.
    for (const f of HANDLERS) {
      const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
      expect(src, f).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?seed_lot_parent_planting\b/i);
      expect(src, f).not.toMatch(/DELETE\s+FROM\s+(?:public\.)?seed_lot_parent_planting\b/i);
      expect(src, f).not.toMatch(/pollen_parent/);
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with
    // NO warning and Phase 4 just keeps counting this relation as uncovered. A misspelled KEY is
    // worse — Phase 1 audits a relation that does not exist. Replicate the auditor's own two regexes
    // against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual([TABLE]);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(CONTRACT_COLUMNS);
  });
});
