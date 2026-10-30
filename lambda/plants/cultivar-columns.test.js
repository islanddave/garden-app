// OPS-SCHEMAAUDITJOIN-001 — the public.cultivar columns lambda/plants reads.
//
// Twenty columns across five statements — the widest cultivar contract, because this is where
// the seed-packet detail panel is assembled: the full growing card (care_notes, soil_notes,
// sun_requirements, common_diseases, expected_yield_notes, growth_habit, the scoville range,
// the DTM window) hangs off a planting's variety_id. The alias is `pv` (plus `opv` in the one
// statement that binds the view twice, the seed-lots read), and no statement here joins
// plant_varieties as well, so the binding is unambiguous.
//
// This is the exact surface of BUG-SEEDDETAIL500-001: cultivar is a VIEW over
// plant_varieties, a column dropped from the view 500s every seed packet detail page, and
// nothing fails at deploy time. That incident is why this contract exists.
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
// 2026-09-03 (V5-VARIETYHYBRIDFLAG-001): breeding_system added. Re-verified against live prod the
// same day — the view is now 46 columns and exposes breeding_system, breeding_source and
// breeding_confidence; only breeding_system is referenced by this Lambda, and only it is listed
// here. This is a COLUMN added to an existing keyed relation, not a new relation: the L-081 ratchet
// says a new relation gets its own contract file and the baseline is never raised, and neither of
// those applies to widening the cultivar list this file already owns.
// 2026-09-19 (V5-SEEDCARDS-001): scoville_source added, carried in the three variety_ref blocks
// that carry scoville_min/max so CropCard can label an estimated figure "est. ... SHU". Same kind of
// widening as breeding_system above, with one difference that matters: it is NOT YET ON PROD. It
// arrives with migrations/v5-scovillesource-001, which appends it to the cultivar VIEW and must be
// applied to staging and prod before this reaches dev; until then dev-main-schema-audit.py reports
// exactly this column missing from prod, which is the ordering guard working.
// 2026-10-06 (V5-SEEDMULTIPARENT-001, R2a): variety_rank and blend_key added, both read by the
// ?view=picker variety_ref only. variety_rank has been on the view since v5-varietyhybridflag-001.
// blend_key is NOT YET ON PROD: migrations/v5-varietyblend-001 appends it as the view's last column
// and must be applied to staging and prod before this reaches dev, the same ordering guard as
// scoville_source above.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  cultivar: ['blend_key', 'breeding_system', 'care_notes', 'common_diseases', 'crop_type_slug', 'days_to_maturity_max', 'days_to_maturity_min', 'deleted_at', 'display_name', 'dtm_basis', 'expected_yield_notes', 'genus', 'growth_habit', 'id', 'lifecycle', 'photo_id', 'scoville_max', 'scoville_min', 'scoville_source', 'soil_notes', 'source_url', 'species', 'sun_requirements', 'variety_rank'],
};

const CULTIVAR_COLUMNS = AUDIT_COLUMNS.cultivar;

// The cultivar statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'cultivar');

// Reads that name cultivar with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants cultivar column contract', () => {
  it('finds the cultivar statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    // 5 -> 6: V4-SEEDREVERSE-001's GET /api/plants/:id/seed-lots joins the view to label a saved
    // seed lot with its variety. It reads `pv.display_name` and `pv.id` only — both already in the
    // contract below — so the column set is unchanged and this count is the whole of the edit.
    // 6 -> 7: GET /api/plants/season-end joins cultivar for the name and crop slug, like the grid.
    expect(READS.statements).toHaveLength(7);
    // + `opv`: the seed-lots read binds the view a SECOND time, inside its other_parents aggregate,
    // for the variety of each other parent planting of a mixed lot. Same statement, so the count
    // above stays 7, and it reads `opv.display_name` and `opv.id` only, both already in the
    // contract. A separate alias because a second `pv` in there would shadow the lot's own.
    expect(READS.aliases).toEqual(['opv', 'pv']);
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
