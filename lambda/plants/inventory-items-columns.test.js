// OPS-SCHEMAAUDITJOIN-001 — the public.inventory_items columns lambda/plants reads.
//
// Two statements, and they are not the same shape:
//   1. household.js loadOwnedInventoryItem — the write-FK ownership walk for
//      plants.source_inventory_item_id (packet -> plant). UNALIASED, so its columns are pinned and
//      hand-listed below.
//   2. index.js GET /api/plants/:id/seed-lots (V4-SEEDREVERSE-001) — the reverse read,
//      plant -> packet, aliased `i`.
//
// WHY THIS FILE EXISTS BESIDE household-columns.test.js, WHICH ALSO DECLARES inventory_items:
// that one is scoped to household.js's own source and contracts the four columns the ownership walk
// touches. It is copied byte-identical into nineteen directories
// (lambda/household-columns-sync.test.js), so it CANNOT grow the five columns this directory's
// seed-lots read adds without editing eighteen out-of-scope Lambdas. Phase 1 audits every declared
// (relation, columns) pair independently, so two contracts on one relation is additive coverage
// rather than a conflict — and this is the one that scans the whole directory, so a future
// inventory_items read anywhere in lambda/plants lands here.
//
// RATCHET: this relation was ALREADY in this directory's Phase-4 declared set via the
// household-columns.test.js copy, and already in its touched set via household.js, so the seed-lots
// read adds NO uncovered relation. scripts/schema-audit-join-baseline.json stays at 48 — measured,
// not assumed (Phase 4 is set arithmetic per directory, dev-main-schema-audit.py:477-485). This
// file is what stops the five NEW columns being audited by nothing, which is the separate and
// realer hazard: Phase 4 counts relations, not columns.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into an existing contract
// file SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex. A shared
// contract module is invisible to it.
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text`; the `--\s.*$` form that most files in this repo carry does
// not, and a surviving `--` hides the CTE declaration that follows it
// (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather
// than hardcoded, so a handler added here that reads inventory_items is covered the day it lands
// instead of the day someone remembers to extend a list.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract. Every column below verified present on public.inventory_items in live prod
// Neon on 2026-09-02 (40 columns), read through the garden_ro read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  inventory_items: [
    'created_at', 'created_by', 'deleted_at', 'id', 'name',
    'quantity_on_hand', 'seed_stage', 'source_plant_id', 'variety_id',
  ],
};

const INVENTORY_ITEMS_COLUMNS = AUDIT_COLUMNS.inventory_items;

// Extraction mirrors scripts/dev-main-schema-audit.py:238-286 so this guard sees the same
// statements Phase 4 credits. Only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation — that is where the auditor's `l` phantom
// came from (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// Regex literals are re-created on every evaluation, so each call gets a fresh lastIndex. The alias
// group is OPTIONAL: household.js's unaliased `FROM inventory_items WHERE ...` captures the next
// keyword, which NOT_AN_ALIAS rejects and UNALIASED_ARMS then accounts for by hand.
const bindings = (s) => [...s.matchAll(
  /\b(?:FROM|JOIN)\s+(?:public\.)?inventory_items\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?/gi,
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

// Scoped to statements that BIND inventory_items, so an `x.col` belonging to some other query in
// the same file can never be read as this table's.
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

// Reads that name inventory_items with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'household.js',
    // loadOwnedInventoryItem. Same four columns household-columns.test.js declares for this
    // relation, derived here independently from this file's own reading of the statement.
    pin: /SELECT\s+id,\s*name\s+FROM\s+inventory_items\s+WHERE\s+id\s*=\s*\$\{itemId\}\s+AND\s+created_by\s*=\s*ANY\(\$\{householdIds\}\)\s+AND\s+deleted_at\s+IS\s+NULL/,
    columns: ['id', 'name', 'created_by', 'deleted_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants inventory_items column contract', () => {
  it('finds the inventory_items statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(STATEMENTS).toHaveLength(2);
    expect([...new Set(STATEMENTS.map((s) => s.file))].sort())
      .toEqual(['household.js', 'index.js']);
    expect([...new Set(STATEMENTS.flatMap((s) => aliasesOf(s.sql)))].sort())
      .toEqual(['i']);
  });

  it('still issues the seed-lots read this contract exists for', () => {
    // The direction the exactly-2 count above cannot catch: delete the seed-lots SELECT and the
    // count drops, but a REPLACEMENT read that stops answering the reverse question would keep it
    // at 2. The predicate is the feature — source_plant_id is what makes this the reverse of
    // V4-SEEDLINK-001 rather than just another inventory list.
    const stmt = STATEMENTS.find((s) => s.file === 'index.js');
    expect(stmt, 'lambda/plants/index.js no longer reads inventory_items').toBeDefined();
    expect(stmt.sql).toMatch(/\bi\.source_plant_id\s*=\s*\$\{plantId\}/);
    // Household scope on the lots themselves, not only on the parent planting. Two households can
    // hold plantings under one container; dropping this would return another member's packets
    // through a planting the caller can legitimately see.
    expect(stmt.sql).toMatch(/\bi\.created_by\s*=\s*ANY\(\$\{householdIds\}\)/);
    expect(stmt.sql).toMatch(/\bi\.deleted_at\s+IS\s+NULL/);
  });

  it('accounts for every unaliased inventory_items read', () => {
    // An unaliased read added without a pin here would slip past columnsOf() entirely and the
    // tightness assertion below would still pass — this count is what closes that hole.
    const bare = STATEMENTS.reduce((n, s) => n + unaliasedIn(s.sql), 0);
    expect(bare).toBe(UNALIASED_ARMS.length);
    for (const arm of UNALIASED_ARMS) {
      const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
      expect(arm.pin.test(src), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set([
      ...STATEMENTS.flatMap((s) => columnsOf(s.sql)),
      ...UNALIASED_ARMS.flatMap((a) => a.columns),
    ])].sort();
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. Extra columns are not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing reads makes the audit assert something the code never does.
    expect(referenced).toEqual([...INVENTORY_ITEMS_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on inventory_items (live prod, 2026-09-02) and every one of them is a
    // live confusion in this repo. `display_name` is what public.cultivar renames name to, and this
    // read JOINs that view two lines away — the exact BUG-SEEDDETAIL500-001 shape. `plant_id` is
    // the FK name on event_log/photos; here the provenance column is `source_plant_id`.
    // `stage` is the column on seed_lot_stage_log AND the wire key the POST /seed-stage body uses;
    // on this table it is `seed_stage`. `archived_at` exists on garden_node and container but not
    // here — the sow-archive columns are `sow_archived_at` / `sow_archived_season`.
    // `remaining_count` belongs to preservation_log; the quantity axis here is `quantity_on_hand`.
    const NOT_ON_TABLE = ['display_name', 'plant_id', 'stage', 'archived_at', 'remaining_count'];
    for (const col of NOT_ON_TABLE) {
      expect(INVENTORY_ITEMS_COLUMNS).not.toContain(col);
      for (const { file, sql } of STATEMENTS) {
        for (const a of aliasesOf(sql)) {
          expect(sql, `${file}: ${a}.${col} is not an inventory_items column`)
            .not.toMatch(new RegExp(String.raw`\b${a}\.${col}\b`, 'i'));
        }
      }
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not an inventory_items column`).not.toContain(col);
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block
    // with NO warning and NO skip count, and Phase 4 just keeps counting this relation as
    // uncovered. A misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and
    // schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(['inventory_items']);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(INVENTORY_ITEMS_COLUMNS);
  });
});
