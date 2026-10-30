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
// A new relation this directory reads goes in as a key of one of its keyed AUDIT_COLUMNS files, not
// a new file (scripts/count-ratchets.json). Never put both forms in one file: parse_test_file returns on
// the keyed form first, so a keyed block in an AUDIT_TABLES file silently drops that file's tables.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in this
// file's own source text. lambda/plants and lambda/inventory-items declare the same relation for
// their own statements and credit nothing here.
//
// Static source inspection. That the statement RUNS, and what it matches, is tests/integration's job;
// seed-saved-lot-xp.test.js drives the handler over a recording mock and proves what is BOUND.
import { describe, it, expect } from 'vitest';
import { ownContract, tableReads } from '../_test-stubs/columnContract.js';

// L-081 KEYED contract: EVERY column of the table that any statement in lambda/events names. Four of
// the table's eight: this directory asks one yes/no question of a link and reads nothing off it.
const AUDIT_COLUMNS = {
  seed_lot_parent_planting: ['deleted_at', 'inventory_item_id', 'plant_id', 'role'],
};

const TABLE = 'seed_lot_parent_planting';
const CONTRACT_COLUMNS = AUDIT_COLUMNS[TABLE];

// The seed_lot_parent_planting statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'seed_lot_parent_planting', { verbs: 'FROM|JOIN|UPDATE' });

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/events seed_lot_parent_planting column contract', () => {
  it('finds the one seed_lot_parent_planting statement, so the assertions below are not vacuous', () => {
    expect(READS.handlers).toContain('seedLotRewards.js');
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(1);
    expect(READS.statements[0].file).toBe('seedLotRewards.js');
    expect(READS.aliasesOf(READS.statements[0].sql)).toEqual(['sl']);
  });

  it('has no unaliased statement and no UPDATE on the table', () => {
    // An unaliased statement's bare identifiers are invisible to columnsOf(), and the tightness
    // assertion below would still pass. Nothing here needs one; if that changes, pin it by hand as
    // lambda/plants/seed-lot-parent-planting-columns.test.js does.
    expect(READS.unaliased).toBe(0);
    for (const { file, sql } of READS.statements) {
      expect(sql, file).not.toMatch(/\bUPDATE\s+(?:public\.)?seed_lot_parent_planting\b/i);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = READS.referenced();
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
      for (const { file, sql } of READS.statements) {
        expect(sql, `${file}: sl.${col} is not a ${TABLE} column`)
          .not.toMatch(new RegExp(String.raw`\bsl\.${col}\b`, 'i'));
      }
    }
  });

  it('reads LIVE seed_parent links only, by lot and planting', () => {
    // The whole predicate. A retired link (deleted_at set) must not key a reward on the jar, and
    // 'pollen_parent' exists in the CHECK and nowhere in releases 1-3.
    expect(READS.statements[0].sql).toMatch(
      /FROM public\.seed_lot_parent_planting sl\s+WHERE sl\.inventory_item_id = \$\{lotId\}::uuid\s+AND sl\.plant_id = \$\{plantId\}::uuid\s+AND sl\.role = 'seed_parent'\s+AND sl\.deleted_at IS NULL/,
    );
  });

  it('never writes a link from this directory, and never names the second role', () => {
    // Links are written by lambda/inventory-items, under the lot's ownership predicate.
    for (const f of READS.handlers) {
      const src = READS.source(f);
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
    const parsed = ownContract(import.meta.url);
    expect(parsed).not.toBeNull();
    expect(parsed.map(([key]) => key)).toEqual([TABLE]);
    const cols = parsed[0][1];
    expect(cols).toEqual(CONTRACT_COLUMNS);
  });
});
