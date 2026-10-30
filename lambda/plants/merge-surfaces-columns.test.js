// OPS-SCHEMAAUDITJOIN-001 / Put-Up train §6a — the columns lambda/plants/merge.js reads on the four
// planting-merge surfaces the train added: kitchen_batch_input, preservation_source, ready_impression,
// watch_exclusion.
//
// WITHOUT THIS FILE the promote's prod schema gate refuses the train. merge.js queries these four
// relations and no contract in lambda/plants declared them, so the Phase 4 ratchet
// (scripts/schema-audit-join-baseline.json, uncovered_relations = 47, may fall and never rise) counted
// 51. Measured offline with the auditor's own parse_test_file / parse_sql_relations and its exact file
// filter: 24 lambdas / 249 relation refs / 51 uncovered without this file, 47 with it. The failure
// could not show before the sitting: until the prod DDL lands, Phase 4(a) returns early on a relation
// prod does not have yet and never reaches the ratchet. scripts/test_schema_audit_join_ratchet.py now
// recomputes the count DB-free in build-and-test, so the next one reds the PR instead. The correct edit
// is always a contract, never a raised baseline.
//
// A new relation this directory reads goes in as a key of one of its keyed AUDIT_COLUMNS files, not
// a new file (scripts/count-ratchets.json). Never put both forms in one file: parse_test_file returns on
// the keyed form first, so a keyed block in an AUDIT_TABLES file silently drops that file's tables.
//
// WHY ALL FOUR IN ONE FILE: the keyed form binds columns to ONE relation each and does not
// cross-product, so the four can share a file without asserting each other's columns. Phase 4 credits a
// contract only to the handler's OWN directory, and only when the AUDIT_COLUMNS literal is in this file's
// own source text — which is why it lives here rather than beside lambda/preservation's contract, which
// already declares kitchen_batch_input for that directory and credits nothing to this one.
//
// NOT HERE, though merge.js repoints them as well: inventory_items.source_plant_id and
// seed_lot_parent_planting.plant_id (a saved-seed lot's member cache and the parent links behind it).
// index.js reads both relations too, and this file holds every relation it declares to merge.js alone
// (the statement-file assertion in the first test), so a second reader cannot be declared here. Each
// has its own directory-wide contract, which carries merge.js's statements as pinned arms:
// inventory-items-columns.test.js and seed-lot-parent-planting-columns.test.js.
//
// Static source inspection rather than import: lambda/_test-stubs make the handlers importable, but
// the stub never evaluates SQL, so the columns a statement names are visible only in its source text.
import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlersIn, ownContract, tableReads } from '../_test-stubs/columnContract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// L-081 KEYED contract, the columns as merge.js's own SQL names them. All present in the migration DDL:
// kitchen_batch_input.id (v5-inflightbatch-001/0a) and .plant_id (v5-putupmake-001/0a, 1b, which ships
// in the same promote as F); preservation_source (v5-putupmultisource-001/0a); ready_impression
// (v4-readytrayimpression-001/0a); watch_exclusion (v4-watchexcluded-001/0a). The early pre-promote
// review verified every one in live prod information_schema except kitchen_batch_input.plant_id, which
// lands with 1b's DDL before the gate runs.
const AUDIT_COLUMNS = {
  kitchen_batch_input: ['id', 'plant_id'],
  preservation_source: ['id', 'plant_id'],
  ready_impression: ['id', 'plant_id', 'user_id', 'shown_on', 'region'],
  watch_exclusion: ['id', 'plant_id', 'user_id', 'evaluated_on', 'reason'],
  // Put-Up release 2 (B′): v5-pantry-001/0a creates pantry_item (id, plant_id among its columns).
  pantry_item: ['id', 'plant_id'],
};

const TABLES = Object.keys(AUDIT_COLUMNS);

// Each relation's statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
// UPDATE <table> is not a binding (the repoint UPDATEs), the same as the auditor's own relation parse.
const READS = Object.fromEntries(TABLES.map((table) => [table, tableReads(import.meta.url, table)]));

// Reads that name the table with NO alias: merge.js's step-6 snapshot of every row about to move, which a
// restore replays. Each is PINNED to its literal SQL with its columns listed by hand — edit the query and
// the pin stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const snapshotPin = (table) => new RegExp(
  String.raw`SELECT\s+id,\s*plant_id\s+AS\s+old_value\s+FROM\s+${table}\s+WHERE\s+plant_id\s*=\s*ANY\(\$\{loserIds\}\)`,
);
const UNALIASED_ARMS = TABLES.map((table) => ({
  table, file: 'merge.js', pin: snapshotPin(table), columns: ['id', 'plant_id'],
}));

// Exact, not a floor: a new statement against one of these relations should be reviewed against the
// contract rather than inherit it. Update this in the same commit that adds one. The two telemetry
// surfaces also carry the conflict-prune DELETE, aliased l (the loser row), w (the winner's) and o (a
// lower-id loser's).
const EXPECTED = {
  kitchen_batch_input: { statements: 1, aliases: [] },
  preservation_source: { statements: 1, aliases: [] },
  ready_impression: { statements: 2, aliases: ['l', 'o', 'w'] },
  watch_exclusion: { statements: 2, aliases: ['l', 'o', 'w'] },
  pantry_item: { statements: 1, aliases: [] },
};

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants merge-surface column contract', () => {
  it('finds the statements for every declared relation, so the assertions below are not vacuous', () => {
    expect(handlersIn(__dirname)).toContain('merge.js');
    expect(Object.keys(EXPECTED)).toEqual(TABLES);
    for (const table of TABLES) {
      const stmts = READS[table].statements;
      expect(stmts, table).toHaveLength(EXPECTED[table].statements);
      expect([...new Set(stmts.map((s) => s.file))], table).toEqual(['merge.js']);
      expect(READS[table].aliases, table).toEqual(EXPECTED[table].aliases);
    }
  });

  it('accounts for every unaliased read of each relation', () => {
    // An unaliased read added without a pin would slip past columnsOf() entirely and the tightness
    // assertion below would still pass — this count is what closes that hole.
    for (const table of TABLES) {
      const arms = UNALIASED_ARMS.filter((a) => a.table === table);
      expect(READS[table].unaliased, table).toBe(arms.length);
      for (const arm of arms) {
        expect(READS[table].pinHolds(arm), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
      }
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    for (const table of TABLES) {
      const referenced = READS[table].referenced(UNALIASED_ARMS.filter((a) => a.table === table));
      // Both directions. The contract is what Phase 1 audits against prod, so a column nothing reads
      // makes the audit assert something the code never does.
      expect(referenced, table).toEqual([...AUDIT_COLUMNS[table]].sort());
    }
  });

  it('never reaches for a column that belongs to another table', () => {
    // Each is absent from its table's DDL and is a live confusion in merge.js, where these statements sit
    // beside near-identical ones for other surfaces. The two telemetry DELETEs are copies of each other
    // and of watch_impression's: shown_on/region are the impression key, evaluated_on/reason the
    // exclusion key, and neither telemetry table has a deleted_at to filter on. kitchen_batch_input's
    // owner column is created_by, preservation_source's is user_id. source_plant_id is the
    // inventory_items name on the repoint line between them.
    const NOT_ON_TABLE = {
      kitchen_batch_input: ['user_id', 'source_plant_id'],
      preservation_source: ['created_by', 'source_plant_id'],
      ready_impression: ['evaluated_on', 'reason', 'deleted_at'],
      watch_exclusion: ['shown_on', 'region', 'deleted_at'],
      // pantry_item's owner column is user_id (not created_by); the merge names only id and plant_id.
      pantry_item: ['created_by', 'source_plant_id'],
    };
    expect(Object.keys(NOT_ON_TABLE)).toEqual(TABLES);
    for (const table of TABLES) {
      for (const col of NOT_ON_TABLE[table]) {
        expect(AUDIT_COLUMNS[table], `${col} is not a ${table} column`).not.toContain(col);
        expect(READS[table].refsTo(col)).toEqual([]);
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with NO
    // warning, and Phase 4 keeps counting all four relations as uncovered. A misspelled KEY is worse —
    // Phase 1 audits a relation that does not exist. Replicate the auditor's own two regexes
    // (dev-main-schema-audit.py:124-127) against this file's own source.
    const parsed = ownContract(import.meta.url);
    expect(parsed).not.toBeNull();
    expect(parsed.map(([key]) => key)).toEqual(TABLES);
    for (const [table, cols] of parsed) {
      expect(cols, table).toEqual(AUDIT_COLUMNS[table]);
    }
  });
});
