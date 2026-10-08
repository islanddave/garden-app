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
  // V5-SEEDLOTADDITION-001 (release 3) — the picking table, a SECOND KEY of this literal rather than
  // a file of its own: its rows hang on this table's rows (parent_link_id is its only foreign key),
  // every statement that names it is in seed-lot-additions.js beside statements that name this one,
  // and a new contract file would raise the directory's count ratchet for no new coverage.
  //
  // ONLY the columns a statement here names — eleven of the table's thirteen. updated_at and
  // deleted_at are on the table and nothing in this directory reads or writes either, so the audit
  // must not assert them for it; the sweep below holds this list to the SQL in both directions too.
  seed_lot_addition: [
    'id',
    'addition_key',
    'parent_link_id',
    'picked_on',
    'seed_count',
    'seed_count_estimated',
    'seed_weight_g',
    'count_applied',
    'weight_applied',
    'created_by',
    'created_at',
  ],
};

const CONTRACT = AUDIT_COLUMNS.seed_lot_parent_planting;

// The picking table's statements and how each names it. One alias, `a`, wherever it is read; the one
// INSERT names its columns in a parenthesised list and RETURNs three of them bare.
const ADDITION_TABLE = 'seed_lot_addition';
const ADDITION_CONTRACT = AUDIT_COLUMNS.seed_lot_addition;
// The ONE binding of the link table that is deliberately not filtered to a live seed_parent row: the
// key lookup of seed-lot-additions.js judgeAddition, which finds the link row a recorded picking
// hangs on WHETHER OR NOT that row is still live (the plant may have been taken off the lot, or
// merged into another plant on it, since the picking was recorded — and the request must still read
// as a replay). It is reached by primary key from the picking row, never by lot or planting.
const KEY_LOOKUP_ALIAS = 'kl';

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
    // rather than inherit it. Eight today — in seed-lot-parents.js the parents read, the link INSERT,
    // three of the set-replace statements (facts, soft-delete, cache) and, since Follow-up 1, the
    // gate's "already a parent of this lot" arm and the create's all-linked assertion; in index.js
    // the /source-kind route's "does this lot have any" test. Update the number in the commit that
    // adds one.
    //
    // ELEVEN with release 2a. seed-lot-parents.js still has its seven (the facts and the cache each
    // read the table once more, inside the statement they already were). Three are new, each in a
    // new module: seed-lot-rules.js's read of which plantings are already parents, and its judge of
    // the same inside the transaction; seed-lot-filing.js's judge, which reads the lot's parents to
    // know their crop.
    //
    // FOURTEEN with release 3 (V5-SEEDLOTADDITION-001). Three more, all in seed-lot-additions.js: the
    // judge (the lot's live parents three ways, and the key's own link row), applyAddition (the link
    // row a picking hangs on, and the member cache's two reads) and the open-lots read (each lot's
    // parents, aggregated).
    expect(STATEMENTS.map((s) => s.file).sort()).toEqual([
      'index.js',
      'seed-lot-additions.js', 'seed-lot-additions.js', 'seed-lot-additions.js',
      'seed-lot-filing.js',
      'seed-lot-parents.js', 'seed-lot-parents.js', 'seed-lot-parents.js', 'seed-lot-parents.js',
      'seed-lot-parents.js', 'seed-lot-parents.js', 'seed-lot-parents.js',
      'seed-lot-rules.js', 'seed-lot-rules.js',
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
    let exempted = 0;
    for (const { file, sql } of STATEMENTS) {
      for (const { alias } of bindingsOf(sql)) {
        // The named exemption (release 3): the key lookup, in seed-lot-additions.js and nowhere else.
        if (file === 'seed-lot-additions.js' && alias === KEY_LOOKUP_ALIAS) { exempted++; continue; }
        expect(sql, `${file}: ${alias} is read without the role filter`)
          .toMatch(new RegExp(String.raw`\b${alias}\.role = 'seed_parent'`));
        expect(sql, `${file}: ${alias} is read without the live-row filter`)
          .toMatch(new RegExp(String.raw`\b${alias}\.deleted_at IS NULL`));
        checked++;
      }
    }
    // Sixteen bindings today — the read, the INSERT's three subqueries, the facts' two, the
    // soft-delete's target and its two, the cache's four, the gate's member arm, the create's
    // assertion, and index.js's one. Not a vacuous loop.
    expect(checked).toBeGreaterThanOrEqual(16);
    // Exactly one binding is exempt, so the exemption cannot quietly come to cover a second read.
    expect(exempted).toBe(1);
    for (const { file, sql } of STATEMENTS) expect(sql, file).not.toMatch(/pollen_parent/);
  });

  it('the one exempt binding is the key lookup: joined by primary key from the picking row, and it filters nothing', () => {
    const lookups = STATEMENTS.filter(({ sql }) => bindingsOf(sql).some((b) => b.alias === KEY_LOOKUP_ALIAS));
    expect(lookups.map((s) => s.file)).toEqual(['seed-lot-additions.js']);
    const [{ sql }] = lookups;
    expect(sql).toMatch(/LEFT JOIN public\.seed_lot_addition a ON a\.addition_key = \$\{additionKey\}::uuid\s+LEFT JOIN public\.seed_lot_parent_planting kl ON kl\.id = a\.parent_link_id/);
    // It reads which lot the row belongs to and when it was written, and nothing else — and it is
    // never a predicate on role or liveness, which is the whole of what the exemption allows.
    expect([...new Set([...sql.matchAll(/\bkl\.([a-z_]+)\b/g)].map((m) => m[1]))].sort())
      .toEqual(['created_at', 'id', 'inventory_item_id']);
    expect(sql).not.toMatch(/\bkl\.(role|deleted_at)\b/);
    // Every OTHER binding of the link table in that same statement keeps both filters.
    for (const { alias } of bindingsOf(sql).filter((b) => b.alias !== KEY_LOOKUP_ALIAS)) {
      expect(sql).toMatch(new RegExp(String.raw`\b${alias}\.role = 'seed_parent'`));
      expect(sql).toMatch(new RegExp(String.raw`\b${alias}\.deleted_at IS NULL`));
    }
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

  it('every inventory_items column the release-2a modules name is pinned by select-columns.test.js too', () => {
    // seed-lot-rules.js and seed-lot-filing.js are the third and fourth modules here to name
    // inventory_items outside index.js, and seed-lot-filing.js WRITES it (the re-file). The same
    // check as the one above, for each: a column either started naming that the directory's contract
    // does not pin would be audited by nothing.
    const contract = readFileSync(resolve(__dirname, 'select-columns.test.js'), 'utf8');
    const list = contract.match(/const INVENTORY_ITEMS_COLUMNS = \[([\s\S]*?)\];/);
    expect(list, 'select-columns.test.js no longer declares INVENTORY_ITEMS_COLUMNS').not.toBeNull();
    const pinned = new Set([...decomment(list[1]).matchAll(/'(\w+)'/g)].map((m) => m[1]));
    const sqlOf = (file) => (decomment(readFileSync(resolve(__dirname, file), 'utf8')).match(/sql`[^`]*`/g) ?? []).join('\n');
    const lotColumns = (sql) => [...new Set([...sql.matchAll(/\bi\.(\w+)/g)].map((m) => m[1]))].sort();

    const rules = sqlOf('seed-lot-rules.js');
    expect(lotColumns(rules)).toEqual(['category', 'created_by', 'deleted_at', 'id', 'variety_id']);
    // It reads; it never writes. (A write here would be a fourth writer of the lot row.)
    expect(rules).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);

    const filing = sqlOf('seed-lot-filing.js');
    expect(lotColumns(filing)).toEqual(['category', 'created_by', 'deleted_at', 'id', 'name', 'variety_id']);
    // Exactly one write, and its three SET targets (bare, by SQL's own rule) are these.
    const sets = [...filing.matchAll(/UPDATE public\.inventory_items i\s+SET\b([\s\S]*?)\bWHERE\b/g)];
    expect(sets).toHaveLength(1);
    expect([...sets[0][1].matchAll(/(?:^|,)\s*([a-z_]+)\s*=/g)].map((m) => m[1])).toEqual(['variety_id', 'name', 'updated_at']);
    expect(filing.match(/\b(UPDATE|INSERT|DELETE)\b/g)).toEqual(['UPDATE', 'UPDATE']);   // the lock's FOR UPDATE, and the write

    for (const col of [...lotColumns(rules), ...lotColumns(filing), 'updated_at']) {
      expect(pinned.has(col), `${col} is named by a release-2a module and not pinned`).toBe(true);
    }
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
    expect(pairs.map((m) => m[1])).toEqual([TABLE, ADDITION_TABLE]);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(CONTRACT);
    const additionCols = [...pairs[1][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(additionCols).toEqual(ADDITION_CONTRACT);
  });
});

// ── V5-SEEDLOTADDITION-001 (release 3) — the picking table, held to the same sweeps ────────────────
describe('V5-SEEDLOTADDITION-001 — lambda/inventory-items seed_lot_addition column contract', () => {
  const NAMING = HANDLERS.flatMap((f) => {
    const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
    return [...src.matchAll(/sql`([^`]*)`/g)]
      .map((m) => m[1])
      .filter((s) => new RegExp(`\\b${ADDITION_TABLE}\\b`).test(s))
      .map((sql) => ({ file: f, sql }));
  });
  const BOUND = new RegExp(String.raw`\b(FROM|JOIN)\s+public\.${ADDITION_TABLE}\s+([a-z_][a-z0-9_]*)`, 'gi');
  const boundIn = (s) => [...s.matchAll(BOUND)].map((m) => m[2]);
  const INSERT = new RegExp(String.raw`INSERT\s+INTO\s+public\.${ADDITION_TABLE}\s*\(([^)]*)\)\s*(?:VALUES|SELECT)\b`, 'gi');
  const insertedIn = (s) => [...s.matchAll(INSERT)].flatMap((m) => m[1].split(',').map((c) => c.trim()).filter(Boolean));
  // The INSERT's RETURNING list: bare names, by SQL's own rule for a statement with no alias.
  const returnedIn = (s) => [...s.matchAll(
    new RegExp(String.raw`INSERT\s+INTO\s+public\.${ADDITION_TABLE}\b[\s\S]*?\bRETURNING\s+([a-z_, ]+?)\s*\)`, 'gi'),
  )].flatMap((m) => m[1].split(',').map((c) => c.trim()).filter(Boolean));

  it('finds the statements: three, all in seed-lot-additions.js', () => {
    // The fast path's key read, the judge's key lookup, and applyAddition's INSERT. Exact, like the
    // link table's own list above: a fourth statement is reviewed against the contract, not inherited.
    expect(NAMING.map((s) => s.file)).toEqual(['seed-lot-additions.js', 'seed-lot-additions.js', 'seed-lot-additions.js']);
    // No other module names the table — index.js reaches it only through that one.
    expect(HANDLERS.filter((f) => new RegExp(`\\b${ADDITION_TABLE}\\b`)
      .test(decomment(readFileSync(resolve(__dirname, f), 'utf8'))))).toEqual(['seed-lot-additions.js']);
  });

  it('names the table schema-qualified everywhere, aliased `a` wherever it is read', () => {
    for (const { file, sql } of NAMING) {
      const mentions = (sql.match(new RegExp(`\\b${ADDITION_TABLE}\\b`, 'g')) ?? []).length;
      const inserts = (sql.match(new RegExp(String.raw`INSERT\s+INTO\s+public\.${ADDITION_TABLE}\s*\(`, 'gi')) ?? []).length;
      expect(boundIn(sql).length + inserts, `${file}: a reference the sweeps cannot attribute`).toBe(mentions);
      for (const alias of boundIn(sql)) expect(alias, file).toBe('a');
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set(NAMING.flatMap(({ sql }) => [
      ...(boundIn(sql).length ? [...sql.matchAll(/\ba\.([a-z_][a-z0-9_]*)\b/gi)].map((m) => m[1]) : []),
      ...insertedIn(sql),
      ...returnedIn(sql),
    ]))].sort();
    expect(referenced).toEqual([...ADDITION_CONTRACT].sort());
    // The two the table has and this directory leaves alone.
    for (const col of ['updated_at', 'deleted_at']) expect(ADDITION_CONTRACT).not.toContain(col);
  });

  it('has exactly one INSERT, and its column list and its SELECT line up', () => {
    const inserts = NAMING.filter(({ sql }) => insertedIn(sql).length > 0);
    expect(inserts).toHaveLength(1);
    const [{ sql }] = inserts;
    expect(insertedIn(sql)).toEqual([
      'addition_key', 'parent_link_id', 'picked_on', 'seed_count', 'seed_count_estimated', 'seed_weight_g',
      'count_applied', 'weight_applied', 'created_by',
    ]);
    expect(returnedIn(sql)).toEqual(['id', 'count_applied', 'weight_applied']);
    // Key, the lot's own link row, the day, the count and its basis (never one without the other),
    // the weight, the two flags, the caller. created_at is the table's default and is never written.
    expect(sql.replace(/\s+/g, ' ')).toContain(
      "SELECT ${additionKey}::uuid, pre.link_id, ${pickedOn}::date, ${addCount}::int, "
      + 'CASE WHEN ${addCount}::int IS NULL THEN NULL ELSE ${addEstimated}::boolean END, ${addWeight}::numeric, '
      + '(pre.c0 IS NOT NULL AND ${addCount}::int IS NOT NULL), (pre.w0 IS NOT NULL AND ${addWeight}::numeric IS NOT NULL), '
      + '${userId}::text FROM upd JOIN pre ON pre.id = upd.id',
    );
    // No statement here updates or deletes a picking: the table is insert-only in this release.
    for (const { file, sql: text } of NAMING) {
      expect(text, file).not.toMatch(new RegExp(String.raw`\b(UPDATE|DELETE\s+FROM)\s+public\.${ADDITION_TABLE}\b`, 'i'));
    }
  });

  it('every inventory_items column seed-lot-additions.js names is pinned by select-columns.test.js', () => {
    // The fifth module here to name inventory_items outside index.js, and the second to WRITE it.
    // The same check the two tests above make for the other four.
    const contract = readFileSync(resolve(__dirname, 'select-columns.test.js'), 'utf8');
    const list = contract.match(/const INVENTORY_ITEMS_COLUMNS = \[([\s\S]*?)\];/);
    expect(list, 'select-columns.test.js no longer declares INVENTORY_ITEMS_COLUMNS').not.toBeNull();
    const pinned = new Set([...decomment(list[1]).matchAll(/'(\w+)'/g)].map((m) => m[1]));
    const add = (decomment(readFileSync(resolve(__dirname, 'seed-lot-additions.js'), 'utf8')).match(/sql`[^`]*`/g) ?? []).join('\n');
    const read = [...new Set([...add.matchAll(/\bi\.(\w+)/g)].map((m) => m[1]))].sort();
    expect(read).toEqual([
      'category', 'created_at', 'created_by', 'deleted_at', 'id', 'name', 'quantity_on_hand', 'seed_count',
      'seed_count_estimated', 'seed_parent_plant_count', 'seed_process', 'seed_stage', 'seed_weight_g',
      'source_kind', 'source_plant_id', 'status', 'updated_at', 'variety_id',
    ]);
    expect(read.filter((c) => !pinned.has(c))).toEqual([]);
    // Exactly one write of the lot row, and its six SET targets (bare, by SQL's own rule) are these.
    const sets = [...add.matchAll(/UPDATE public\.inventory_items i\s+SET\b([\s\S]*?)\bFROM pre\b/g)];
    expect(sets).toHaveLength(1);
    const targets = [...sets[0][1].matchAll(/(?:^|,)\s*([a-z_]+)\s*=\s*(?:CASE|NOW\(\))/g)].map((m) => m[1]);
    expect(targets).toEqual([
      'source_plant_id', 'seed_count', 'seed_count_estimated', 'seed_weight_g', 'seed_parent_plant_count', 'updated_at',
    ]);
    expect(targets.filter((c) => !pinned.has(c))).toEqual([]);
    // What a picking must never move: the lot's own age, stage, process, container count and status.
    for (const col of ['created_at', 'year_harvested', 'seed_stage', 'seed_process', 'quantity_on_hand', 'status', 'name', 'variety_id']) {
      expect(targets).not.toContain(col);
    }
    expect(add.match(/\bUPDATE public\.inventory_items\b/g)).toHaveLength(1);
  });
});
