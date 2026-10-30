// OPS-SCHEMAAUDITJOIN-001 — the public.garden_node columns lambda/dashboard reads.
//
// The dashboard reads plantings three ways — the rollup counts, the care/water bar and the
// flagged-issue feed — under three different aliases in the same file, so a column that exists for
// one query is not evidence it exists at all. `container_type`, `lineage_note` and `notes` are
// reached ONLY by the flagged-issue arm.
//
// This is the relation BUG-SEEDDETAIL500-001 was on: `p.name` does not exist on garden_node (it is
// `display_name`), and it passed a green audit, a green unit suite and a green integration run
// while 500-ing every seed packet detail page in prod. lambda/inventory-items and lambda/plants
// already declare it; Phase 4 credits per directory, so neither buys these ten anything.
//
// A new relation this directory reads goes in as a key of one of its keyed AUDIT_COLUMNS files, not
// a new file (scripts/count-ratchets.json). Never put both forms in one file: parse_test_file returns on
// the keyed form first, so a keyed block in an AUDIT_TABLES file silently drops that file's tables.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex. A shared
// contract module is invisible to it, which is why a relation several Lambdas JOIN needs a
// contract in each of their directories rather than one in a common place.
//
// Static source inspection rather than import: lambda/_test-stubs make the handlers importable, but
// the stub never evaluates SQL, so the columns a statement names are visible only in its source text.
import { describe, it, expect } from 'vitest';
import { ownContract, tableReads } from '../_test-stubs/columnContract.js';

// L-081 KEYED contract. Every column below verified present on public.garden_node in live prod Neon on
// 2026-08-29 (55 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  garden_node: [
    'archived_at', 'container_id', 'container_type', 'cultivar_id', 'deleted_at', 'display_name',
    'id', 'lineage_note', 'notes', 'status'
  ],
};

const GARDEN_NODE_COLUMNS = AUDIT_COLUMNS.garden_node;

// The garden_node statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'garden_node');

// Reads that name garden_node with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/dashboard garden_node column contract', () => {
  it('finds the garden_node statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(12);
    expect(READS.aliases).toEqual(['ga', 'gn', 'gna', 'gne', 'gp', 'p']);
  });

  it('accounts for every unaliased garden_node read', () => {
    // An unaliased read added without a pin here would slip past columnsOf() entirely and the
    // tightness assertion below would still pass — this count is what closes that hole.
    expect(READS.unaliased).toBe(UNALIASED_ARMS.length);
    for (const arm of UNALIASED_ARMS) {
      expect(READS.pinHolds(arm), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = READS.referenced(UNALIASED_ARMS);
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. Extra columns are not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing reads makes the audit assert something the code never does.
    expect(referenced).toEqual([...GARDEN_NODE_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // `name` is the regression itself. The other three are the plausible confusions:
    // event_log carries project_id and plant_id, and inventory_items carries variety_id — none of
    // the four exist on garden_node.
    const NOT_ON_TABLE = ['name', 'project_id', 'plant_id', 'variety_id'];
    for (const col of NOT_ON_TABLE) {
      expect(GARDEN_NODE_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block
    // with NO warning and NO skip count, and Phase 4 just keeps counting this relation as
    // uncovered. A misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and
    // schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const parsed = ownContract(import.meta.url);
    expect(parsed).not.toBeNull();
    expect(parsed.map(([key]) => key)).toEqual(['garden_node']);
    const cols = parsed[0][1];
    expect(cols).toEqual(GARDEN_NODE_COLUMNS);
  });
});
