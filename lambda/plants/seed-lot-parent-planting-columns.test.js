// OPS-SCHEMAAUDITJOIN-001 — the public.seed_lot_parent_planting columns lambda/plants names.
//
// seed_lot_parent_planting holds the parent plantings of a saved-seed lot, one live row per
// (lot, planting, role), beside inventory_items.source_plant_id, which survives as a member cache
// naming one of them (schema_version 5.0.0-seedmultiparent-001). Five statements in this directory
// name it, and they are not the same shape:
//   1. index.js GET /api/plants/:id/seed-lots — the reverse read. Binds the table twice: `sl` in the
//      EXISTS that is one of the two arms deciding which lots are listed (the other is the cache
//      column on inventory_items), `ol` in the aggregate that names a lot's OTHER parents.
//   2. merge.js snapshot read — every link row on a loser, before the cutover. UNALIASED.
//   3. merge.js snapshot read of the rows the collision prune will retire — `l`, `w`, `o`.
//   4. merge.js collision prune — an UPDATE aliased `l`, with the same `w` and `o` arms.
//   5. merge.js repoint — an UNALIASED UPDATE.
//
// WITHOUT THIS FILE the Phase 4 ratchet (scripts/schema-audit-join-baseline.json, uncovered_relations
// = 47, may fall and never rise) counts 48: both handlers query a relation nothing in lambda/plants
// declared. scripts/test_schema_audit_join_ratchet.py recomputes that DB-free in build-and-test. The
// correct edit is always a contract, never a raised baseline.
//
// WHY THIS FILE SCANS `UPDATE` AS WELL AS FROM/JOIN, which the sibling contracts do not: the auditor's
// relation parse is FROM|JOIN only (scripts/dev-main-schema-audit.py, _SQL_RELATION), so a statement
// that reaches a table through UPDATE alone is invisible to Phase 4, and its Phase 3 soft-delete
// check wants `UPDATE <table> SET` with no alias between them, which statement 4 does not have. Two
// of the five statements here are UPDATEs, and they are the two that write. Every column they name
// is in the contract below, and Phase 1 audits that against prod whatever Phase 3 and 4 can see.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN merge-surfaces-columns.test.js: that file holds each of its
// relations to merge.js alone, and index.js reads this one too. And parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector, so a keyed block
// dropped into select-columns.test.js would SILENTLY DESTROY that file's own coverage. Always a new
// file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in this
// file's own source text. lambda/inventory-items declares the same relation for its own statements
// and credits nothing to this directory.
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite. So nothing here proves a
// statement RUNS; that is tests/integration's job (seed-lots-reverse, plant-merge-surfaces).
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

// L-081 KEYED contract: EVERY column of the table that any statement in lambda/plants names, in a
// SELECT list, a predicate or a SET. Six of the table's eight; created_by and created_at are named by
// nothing here (this directory never inserts a link, and reads scope through the LOT's owner).
// NOT YET ON PROD when this was written: the table arrives with the 5.0.0-seedmultiparent-001 DDL,
// which must be applied to staging and prod before this reaches dev. Until then
// dev-main-schema-audit.py reports the relation missing from prod, which is the ordering guard
// working.
const AUDIT_COLUMNS = {
  seed_lot_parent_planting: ['deleted_at', 'id', 'inventory_item_id', 'plant_id', 'role', 'updated_at'],
};

const TABLE = 'seed_lot_parent_planting';
const CONTRACT_COLUMNS = AUDIT_COLUMNS[TABLE];

// Only SQL inside a tagged sql`` template counts. `IS [NOT] DISTINCT FROM x.col` carries the literal
// token FROM, so it is scrubbed before scanning, as the auditor does.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// FROM, JOIN **and UPDATE** bind the table (see the header). The alias group is OPTIONAL: an unaliased
// `FROM <table> WHERE` or `UPDATE <table> SET` captures the next keyword, which NOT_AN_ALIAS rejects
// and UNALIASED_ARMS then accounts for by hand.
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

// Scoped to statements that BIND the table, so an `l.col` belonging to one of merge.js's other
// prunes — every one of them aliases its loser row `l` — can never be read as this table's.
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

// Statements that name the table with NO alias. Nothing can attribute their bare identifiers
// automatically, so each is PINNED to its literal SQL with its columns listed by hand. Edit the
// statement and the pin stops matching and this file reds, which is the only way the hand-listed
// columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'merge.js',
    // Step 6: every link row on a loser, with the planting it pointed at, before anything moves.
    pin: /SELECT\s+id,\s*plant_id\s+AS\s+old_value\s+FROM\s+seed_lot_parent_planting\s+WHERE\s+plant_id\s*=\s*ANY\(\$\{loserIds\}\)/,
    columns: ['id', 'plant_id'],
  },
  {
    file: 'merge.js',
    // Step 7: the repoint. Every row on a loser, so no deleted_at here; updated_at because no
    // trigger keeps it on this table.
    pin: /UPDATE\s+seed_lot_parent_planting\s+SET\s+plant_id\s*=\s*\$\{winnerId\},\s*updated_at\s*=\s*now\(\)\s+WHERE\s+plant_id\s*=\s*ANY\(\$\{loserIds\}\)/,
    columns: ['plant_id', 'updated_at'],
    update: true,
  },
];

// The SET targets of an ALIASED UPDATE. Postgres takes no alias on a SET target, so these are bare
// identifiers inside a statement whose every other column is `l.`-qualified, and columnsOf() cannot
// see them. Pinned the same way.
const SET_ARMS = [
  {
    file: 'merge.js',
    // Step 7: the collision prune. A soft delete, so it names the two columns a soft delete writes.
    pin: /UPDATE\s+seed_lot_parent_planting\s+l\s+SET\s+deleted_at\s*=\s*now\(\),\s*updated_at\s*=\s*now\(\)\s+WHERE\s+l\.plant_id\s*=\s*ANY\(\$\{loserIds\}\)\s+AND\s+l\.deleted_at\s+IS\s+NULL/,
    columns: ['deleted_at', 'updated_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants seed_lot_parent_planting column contract', () => {
  it('finds the seed_lot_parent_planting statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    // 1 in index.js (the seed-lots read) + 4 in merge.js (two snapshot reads, the prune, the repoint).
    expect(STATEMENTS).toHaveLength(5);
    expect(STATEMENTS.map((s) => s.file).sort())
      .toEqual(['index.js', 'merge.js', 'merge.js', 'merge.js', 'merge.js']);
    // ol / sl are the reverse read's two bindings; l / o / w are the merge's loser row, a lower-id
    // loser's and the winner's, the aliases every prune in merge.js uses.
    expect([...new Set(STATEMENTS.flatMap((s) => aliasesOf(s.sql)))].sort())
      .toEqual(['l', 'o', 'ol', 'sl', 'w']);
  });

  it('accounts for every unaliased statement on the table', () => {
    // An unaliased statement added without a pin here would slip past columnsOf() entirely and the
    // tightness assertion below would still pass — this count is what closes that hole.
    const bare = STATEMENTS.reduce((n, s) => n + unaliasedIn(s.sql), 0);
    expect(bare).toBe(UNALIASED_ARMS.length);
    for (const arm of [...UNALIASED_ARMS, ...SET_ARMS]) {
      const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
      expect(arm.pin.test(src), `arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('accounts for every UPDATE of the table, whose SET targets no alias scan can see', () => {
    // The hole the header describes, closed by count: an UPDATE added here with a bare SET target
    // nobody pinned would name a column this contract never lists, and every other assertion in this
    // file would still pass.
    const updates = STATEMENTS.reduce(
      (n, s) => n + (s.sql.match(/\bUPDATE\s+(?:public\.)?seed_lot_parent_planting\b/gi) || []).length, 0);
    expect(updates).toBe(UNALIASED_ARMS.filter((a) => a.update).length + SET_ARMS.length);
    expect(updates).toBe(2);
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set([
      ...STATEMENTS.flatMap((s) => columnsOf(s.sql)),
      ...UNALIASED_ARMS.flatMap((a) => a.columns),
      ...SET_ARMS.flatMap((a) => a.columns),
    ])].sort();
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. Extra columns are not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing names makes the audit assert something the code never does.
    expect(referenced).toEqual([...CONTRACT_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these is on seed_lot_parent_planting, and each is a live confusion where these
    // statements sit. source_plant_id is the inventory_items name, on the repoint line directly above
    // this table's in merge.js. The prune is a copy of ready_impression's with the key changed:
    // user_id / shown_on / region are THAT key, and the owner column here is created_by. seed_lot_id
    // is what a seed_saved event calls the lot in its metadata; the column is inventory_item_id.
    // parent_plant_id is plants' own lineage column. ordinal and is_primary were in the first draft
    // of this table and were dropped: no parent is primary, and the read order is name then id.
    const NOT_ON_TABLE = [
      'source_plant_id', 'user_id', 'shown_on', 'region', 'seed_lot_id', 'parent_plant_id',
      'ordinal', 'is_primary',
    ];
    for (const col of NOT_ON_TABLE) {
      expect(CONTRACT_COLUMNS).not.toContain(col);
      for (const { file, sql } of STATEMENTS) {
        for (const a of aliasesOf(sql)) {
          expect(sql, `${file}: ${a}.${col} is not a ${TABLE} column`)
            .not.toMatch(new RegExp(String.raw`\b${a}\.${col}\b`, 'i'));
        }
      }
      for (const arm of [...UNALIASED_ARMS, ...SET_ARMS]) {
        expect(arm.columns, `${arm.file}: ${col} is not a ${TABLE} column`).not.toContain(col);
      }
    }
  });

  it('never inserts a link from this directory, and never names the second role', () => {
    // Links are written by lambda/inventory-items, under the lot's ownership predicate, with a role
    // and a created_by on every row. An INSERT here would need both, and an ownership decision
    // recorded in lambda/authz-write-fk.test.js. Release 1 reads and writes 'seed_parent' only:
    // 'pollen_parent' exists in the CHECK and nowhere else.
    for (const f of HANDLERS) {
      const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
      expect(src, f).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?seed_lot_parent_planting\b/i);
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
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual([TABLE]);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(CONTRACT_COLUMNS);
  });
});

// The reverse read's own rules. They live here rather than in inventory-items-columns.test.js because
// every one of them is about how the LINK is read; that file keeps the lot's columns and the lot's
// household scope.
describe('GET /api/plants/:id/seed-lots — read through the parent links', () => {
  const stmt = STATEMENTS.find((s) => s.file === 'index.js');
  const sql = stmt?.sql ?? '';
  const flat = sql.replace(/\s+/g, ' ');

  it('is the one statement in index.js on the table', () => {
    expect(STATEMENTS.filter((s) => s.file === 'index.js')).toHaveLength(1);
    expect(sql).toMatch(/FROM\s+public\.inventory_items\s+i\b/);
  });

  it('lists a lot on a LIVE seed_parent link to this planting, whichever parent the cache names', () => {
    // The link arm. Read through inventory_items.source_plant_id alone, a lot with two parents is
    // listed under the one the cache happens to name and is "no seed saved" on the other.
    expect(flat).toMatch(
      /EXISTS \(SELECT 1 FROM public\.seed_lot_parent_planting sl WHERE sl\.inventory_item_id = i\.id AND sl\.plant_id = \$\{plantId\} AND sl\.role = 'seed_parent' AND sl\.deleted_at IS NULL\)/,
    );
  });

  it('ALSO lists a lot whose source_plant_id names this planting, link row or no link row', () => {
    // The column arm. By invariant the cache names a member of the set, so while that holds this arm
    // repeats what the link arm found. Where it does not hold yet — a lot written by an older
    // inventory-items Lambda before the reconcile, the per-function deploy matrix, a revert — the
    // column is the only record of the parent, and a link-only read answers "no seed saved".
    expect(flat).toMatch(/ OR i\.source_plant_id = \$\{plantId\}\)/);
    expect(sql.match(/\bi\.source_plant_id\b/g)).toHaveLength(1);
  });

  it('holds both arms in ONE parenthesised OR, beneath the household and live-lot filters', () => {
    // AND binds tighter than OR. Drop the parentheses and the statement reads
    // (household AND live AND link) OR column: any household's lot, deleted or not, whose column
    // names this planting. Pinned whole, from WHERE to ORDER BY, so nothing can be slipped between.
    expect(flat).toMatch(
      /WHERE i\.created_by = ANY\(\$\{householdIds\}\) AND i\.deleted_at IS NULL AND \(EXISTS \(SELECT 1 FROM public\.seed_lot_parent_planting sl WHERE sl\.inventory_item_id = i\.id AND sl\.plant_id = \$\{plantId\} AND sl\.role = 'seed_parent' AND sl\.deleted_at IS NULL\) OR i\.source_plant_id = \$\{plantId\}\) ORDER BY i\.created_at DESC, i\.id DESC\s*$/,
    );
    // The only OR in the statement: not one inside the link arm, and not one widening other_parents.
    expect(sql.match(/\bOR\b/g)).toHaveLength(1);
  });

  it('returns a lot that matches both arms ONCE', () => {
    // Which is every lot once the invariant holds. The arms are two tests on one row of
    // inventory_items, not two result sets: a UNION ALL lists such a lot twice, and so does joining
    // the links into the outer FROM for a lot with more than one.
    expect(sql).not.toMatch(/\bUNION\b/i);
    expect(sql.match(/\bFROM\s+public\.inventory_items\b/gi)).toHaveLength(1);
    expect(sql.match(/\bWHERE\s+i\.created_by\b/gi)).toHaveLength(1);
    expect(sql).not.toMatch(/\bJOIN\s+(?:LATERAL\s+)?(?:public\.)?seed_lot_parent_planting\b/i);
  });

  it('keeps the lot live and in the household — the link does not say either', () => {
    // A link row is NOT retired when its lot is soft-deleted (it follows the lot), so the lot's own
    // deleted_at is the only thing keeping a deleted lot out of this list.
    expect(sql).toMatch(/\bi\.deleted_at\s+IS\s+NULL/);
    expect(sql).toMatch(/\bi\.created_by\s*=\s*ANY\(\$\{householdIds\}\)/);
  });

  it('still has no category filter', () => {
    // The documented decision (index.js, above the route): where the member cache holds, the
    // seeds-only CHECK on source_plant_id already pins the category; where it does not, a filter
    // would hide a lot the user really did link.
    expect(sql).not.toMatch(/\bcategory\b/);
  });

  it('carries every field the list carried before, in the same order', () => {
    expect(flat).toMatch(
      /SELECT i\.id, i\.name, i\.seed_stage, i\.quantity_on_hand, i\.created_at, i\.seed_count, i\.seed_count_estimated, i\.seed_weight_g, pv\.display_name AS variety_name,/,
    );
    expect(flat).toMatch(/LEFT JOIN public\.cultivar pv ON pv\.id = i\.variety_id/);
    expect(flat).toMatch(/ORDER BY i\.created_at DESC, i\.id DESC\s*$/);
  });

  it('builds other_parents with ONE aggregate, and never joins the links into the lot list', () => {
    // A join in the outer FROM returns the lot once per other parent: the planting page would list a
    // three-parent lot twice. The table appears under FROM in two subqueries and under JOIN nowhere.
    expect(sql).not.toMatch(/\bJOIN\s+(?:LATERAL\s+)?(?:public\.)?seed_lot_parent_planting\b/i);
    expect(sql.match(/\bjsonb_agg\s*\(/gi)).toHaveLength(1);
    expect(sql).not.toMatch(/\bGROUP\s+BY\b/i);
    // `[]` for a lot with one parent, never null: null is not "no other parents".
    expect(flat).toMatch(/COALESCE\(\( SELECT jsonb_agg\(/);
    expect(flat).toMatch(/\), '\[\]'::jsonb\) AS other_parents/);
  });

  it('names each other parent { id, name, variety_name } and nothing else', () => {
    // name is garden_node.display_name and variety_name is cultivar.display_name. garden_node has NO
    // `name` and NO `variety_id`: reading either through the view is BUG-SEEDDETAIL500-001.
    expect(flat).toMatch(
      /jsonb_build_object\('id', ol\.plant_id, 'name', gn\.display_name, 'variety_name', opv\.display_name\)/,
    );
    expect(sql.match(/jsonb_build_object\s*\(/gi)).toHaveLength(1);
    expect(sql).not.toMatch(/\bgn\.name\b/);
    expect(sql).not.toMatch(/\bgn\.variety_id\b/);
    expect(sql).not.toMatch(/\bopv\.name\b/);
  });

  it('lists the OTHER live seed parents of the same lot, name then id', () => {
    expect(flat).toMatch(
      /WHERE ol\.inventory_item_id = i\.id AND ol\.role = 'seed_parent' AND ol\.deleted_at IS NULL AND ol\.plant_id <> \$\{plantId\}/,
    );
    expect(flat).toMatch(/ORDER BY gn\.display_name, ol\.plant_id\)/);
  });

  it('builds other_parents from the link rows alone, never from the column', () => {
    // The column arm decides whether a LOT is listed. It says nothing about who else is a parent: a
    // lot whose column names A and whose only live link is to B lists B on A's page and nobody on
    // B's, until a reconcile makes the two agree. Keeping the column out of here means other_parents
    // never names a planting that no link row records.
    const aggregate = flat.slice(flat.indexOf('COALESCE(('), flat.indexOf(") AS other_parents"));
    expect(aggregate).toMatch(/FROM public\.seed_lot_parent_planting ol/);
    expect(aggregate).not.toMatch(/source_plant_id/);
    expect(aggregate).not.toMatch(/\bOR\b/);
  });

  it('lets nothing about the other planting decide whether it is listed', () => {
    // An archived planting is the likeliest seed parent there is, and a soft-deleted one is still a
    // recorded parent. The element's id comes off the LINK and both joins are LEFT, so neither the
    // planting's state nor a cleared variety can drop it.
    expect(flat).toMatch(/LEFT JOIN public\.garden_node gn ON gn\.id = ol\.plant_id/);
    expect(flat).toMatch(/LEFT JOIN public\.cultivar opv ON opv\.id = gn\.cultivar_id/);
    expect(sql).not.toMatch(/\bgn\.deleted_at\b/);
    expect(sql).not.toMatch(/\bgn\.archived_at\b/);
    expect(sql).not.toMatch(/\bopv\.deleted_at\b/);
  });

  it('answers in the shape it always has, behind the same ownership gate', () => {
    const src = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
    const route = src.slice(src.indexOf('if (seedLotsMatch) {'));
    const body = route.slice(0, route.indexOf('if (idMatch) {'));
    expect(body).toMatch(/const parent = await loadOwnedPlantingRef\(sql, plantId, householdIds\);/);
    expect(body).toMatch(/if \(!parent\) return resp\(404, \{ error: 'Not found' \}\);/);
    expect(body).toMatch(/return resp\(200, \{ plant_id: plantId, seed_lots: rows \}\);/);
    // One statement: the list and its other_parents come from the same read, so a lot can never be
    // listed beside parents read a moment later.
    expect(body.match(/sql`/g)).toHaveLength(1);
  });
});
