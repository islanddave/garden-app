// OPS-SCHEMAAUDITJOIN-001 — the public.cultivar columns lambda/facebook-share reads.
//
// Two statements in index.js, both label lookups: the cultivar name that goes into the post
// copy, plus its crop_type_slug so the post can name the crop too. Four columns.
//
// cultivar is a VIEW over plant_varieties, so a column dropped from the view is a 500 at
// runtime with nothing failing at deploy time — that is BUG-SEEDDETAIL500-001's exact shape,
// and the reason a view gets a column contract at all.
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

// L-081 KEYED contract. Every column below verified present on public.cultivar in live prod Neon on
// 2026-08-29 (42 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  cultivar: ['crop_type_slug', 'deleted_at', 'display_name', 'id'],
};

const CULTIVAR_COLUMNS = AUDIT_COLUMNS.cultivar;

// The cultivar statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'cultivar');

// Reads that name cultivar with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/facebook-share cultivar column contract', () => {
  it('finds the cultivar statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(2);
    expect(READS.aliases).toEqual(['cv']);
  });

  it('accounts for every unaliased cultivar read', () => {
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
    expect(referenced).toEqual([...CULTIVAR_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // cultivar is a VIEW over plant_varieties (verified against prod: pg_get_viewdef reads
    // `SELECT id, name AS display_name, ... FROM plant_varieties`), and these five are exactly the
    // traps that creates. The label is `display_name` HERE and `name` on the base table, so `name`
    // resolves through the view to nothing. unit_weights, weight_confidence and weight_source are
    // the three columns the view does NOT project — they exist on plant_varieties and on crop_types,
    // and reading them off this relation is the single most likely way to reproduce
    // BUG-SEEDDETAIL500-001. `variety_id` is the FK POINTING AT this view's id from plants; here the
    // column is plain `id`.
    const NOT_ON_TABLE = ['name', 'unit_weights', 'weight_confidence', 'weight_source', 'variety_id'];
    for (const col of NOT_ON_TABLE) {
      expect(CULTIVAR_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a cultivar column`).not.toContain(col);
      }
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
    expect(parsed.map(([key]) => key)).toEqual(['cultivar']);
    const cols = parsed[0][1];
    expect(cols).toEqual(CULTIVAR_COLUMNS);
  });
});
