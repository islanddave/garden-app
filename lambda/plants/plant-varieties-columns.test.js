// OPS-SCHEMAAUDITJOIN-001 — the public.plant_varieties columns lambda/plants reads.
//
// One statement in index.js, and the only read in this set that takes `name` off the BASE
// table rather than `display_name` off the cultivar VIEW — the rest of this directory reads
// the view (see cultivar-columns.test.js beside this file). Three columns.
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

// L-081 KEYED contract. Every column below verified present on public.plant_varieties in live prod Neon on
// 2026-08-29 (45 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  plant_varieties: ['crop_type_slug', 'id', 'name'],
};

const PLANT_VARIETIES_COLUMNS = AUDIT_COLUMNS.plant_varieties;

// The plant_varieties statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'plant_varieties');

// Reads that name plant_varieties with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'authz-parents.js',
    // resolveContainerForCultivar's `target` CTE (V4-AUTOPROJECT-001, dev 1f567ae). It reads the
    // spoken/posted cultivar's crop type so the candidate containers can be filtered to the ones
    // holding THAT crop and nothing else — the `other = 0` purity guard the resolver's safety rests
    // on. Unaliased because the CTE selects from the table directly, so columnsOf() cannot attribute
    // its bare identifiers and they are listed by hand here.
    pin: /SELECT crop_type_slug AS slug FROM public\.plant_varieties WHERE id = \$\{cultivarId\}/,
    columns: ['crop_type_slug', 'id'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants plant_varieties column contract', () => {
  it('finds the plant_varieties statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(2);
    expect(READS.aliases).toEqual(['pv']);
  });

  it('accounts for every unaliased plant_varieties read', () => {
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
    expect(referenced).toEqual([...PLANT_VARIETIES_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on plant_varieties, and the first is the sharpest trap in this repo's
    // schema. plant_varieties is the BASE TABLE and `cultivar` is a VIEW over it whose definition
    // reads `SELECT id, name AS display_name, ... FROM plant_varieties` — so the SAME row answers to
    // `display_name` through the view and to `name` here, and a handler that reads pv.display_name
    // off the base table gets nothing at runtime with nothing failing at deploy time. `variety_id`
    // and `plant_id` are FKs POINTING AT this table (from plants) and at plants respectively; the
    // key here is plain `id`. And the crop link is `crop_type_slug` — bare `slug` is crop_types' own
    // primary key, one hop away.
    const NOT_ON_TABLE = ['display_name', 'variety_id', 'plant_id', 'slug'];
    for (const col of NOT_ON_TABLE) {
      expect(PLANT_VARIETIES_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a plant_varieties column`).not.toContain(col);
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
    expect(parsed.map(([key]) => key)).toEqual(['plant_varieties']);
    const cols = parsed[0][1];
    expect(cols).toEqual(PLANT_VARIETIES_COLUMNS);
  });
});
