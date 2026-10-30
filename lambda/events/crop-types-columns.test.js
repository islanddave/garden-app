// OPS-SCHEMAAUDITJOIN-001 — the public.crop_types columns lambda/events reads.
//
// One statement: the ready-to-pick projection in index.js, which reads all four harvest-cadence
// columns at once (harvest_habit, repeat_interval_days and the two harvest_season_*_doy bounds).
// It is the only non-test file under lambda/ that names harvest_season_start_doy at all —
// measured by grep, so scoped to lambda/ and to this SHA. It reaches the table two hops out —
// plants.variety_id -> plant_varieties.crop_type_slug -> crop_types.slug — so a column dropped
// here surfaces as a silently empty pick list rather than an error.
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

// L-081 KEYED contract. Every column below verified present on public.crop_types in live prod Neon on
// 2026-08-29 (24 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  crop_types: ['deleted_at', 'display_name', 'harvest_habit', 'harvest_season_end_doy', 'harvest_season_start_doy', 'repeat_interval_days', 'slug'],
};

const CROP_TYPES_COLUMNS = AUDIT_COLUMNS.crop_types;

// The crop_types statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'crop_types');

// Reads that name crop_types with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/events crop_types column contract', () => {
  it('finds the crop_types statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(1);
    expect(READS.aliases).toEqual(['ct']);
  });

  it('accounts for every unaliased crop_types read', () => {
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
    expect(referenced).toEqual([...CROP_TYPES_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on crop_types, and each is a live confusion. This table has NO id at all —
    // `slug` is the PRIMARY KEY and the FK target of plant_varieties and preservation_log, which is
    // why a rename is a resurrect rather than a polite conflict (varieties/index.js:159-161). The
    // label is `display_name`, not `name`. `crop_type_slug` is what the CHILD tables call their FK
    // into here; on this table it is plain `slug`. And the two defaulted columns are
    // `default_lifecycle` and `default_unit` — bare `lifecycle` and `unit` belong to plant_varieties
    // and harvest_log respectively, and reading either off this table would silently be undefined.
    const NOT_ON_TABLE = ['id', 'name', 'crop_type_slug', 'lifecycle', 'unit'];
    for (const col of NOT_ON_TABLE) {
      expect(CROP_TYPES_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a crop_types column`).not.toContain(col);
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
    expect(parsed.map(([key]) => key)).toEqual(['crop_types']);
    const cols = parsed[0][1];
    expect(cols).toEqual(CROP_TYPES_COLUMNS);
  });
});
