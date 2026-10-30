// OPS-SCHEMAAUDITJOIN-001 / L-081 — the public.v_resolved_care columns lambda/plants reads.
//
// ADDED BY V5-HEATRESPONSEDISPLAY-001, which put `LEFT JOIN public.v_resolved_care rc ON
// rc.leaf_id = p.id` into index.js to read the curated per-cultivar heat prose for DISPLAY. That
// join is what took the repo's uncovered-relation count from 48 to 49 and red the L-081 schema
// audit on dev. The fix is this file — a contract for the NEW relation — and NOT raising
// scripts/schema-audit-join-baseline.json, which would retire the ratchet's only tooth.
//
// v_resolved_care is a VIEW (system||cultivar||leaf, shallow right-wins merge), not a table. It is
// joined rather than re-implemented so this read cannot drift from the one the care engine
// resolves through, which means its column surface is a real contract: a future edit to the view
// that drops or renames either column below breaks a shipped read, and this file is what says so.
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

// L-081 KEYED contract. Every column below verified present on public.v_resolved_care in live prod Neon on
// 2026-08-29 (24 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  // Both columns verified present on public.v_resolved_care in live prod Neon on 2026-09-02
  // (the view exposes exactly four: leaf_id, resolved_profile, resolved_scopes, cadence_scopes).
  // Only these two are READ here — resolved_scopes/cadence_scopes are consumed elsewhere, and a
  // contract lists what this directory's handlers actually touch, not the whole relation.
  v_resolved_care: ['leaf_id', 'resolved_profile'],
};

const V_RESOLVED_CARE_COLUMNS = AUDIT_COLUMNS.v_resolved_care;

// The v_resolved_care statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'v_resolved_care');

// Reads that name v_resolved_care with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants v_resolved_care column contract', () => {
  it('finds the v_resolved_care statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    // Exactly one today: the V5-HEATRESPONSEDISPLAY-001 read in index.js. Kept as an exact count
    // rather than a floor so a second join against this view is reviewed against the contract
    // instead of silently inheriting it — update this number in the commit that adds one.
    expect(READS.statements).toHaveLength(1);
    expect(READS.aliases).toEqual(['rc']);
  });

  it('accounts for every unaliased v_resolved_care read', () => {
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
    expect(referenced).toEqual([...V_RESOLVED_CARE_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on v_resolved_care, and each is a live confusion. This table has NO id at all —
    // `slug` is the PRIMARY KEY and the FK target of plant_varieties and preservation_log, which is
    // why a rename is a resurrect rather than a polite conflict (varieties/index.js:159-161). The
    // label is `display_name`, not `name`. `crop_type_slug` is what the CHILD tables call their FK
    // into here; on this table it is plain `slug`. And the two defaulted columns are
    // `default_lifecycle` and `default_unit` — bare `lifecycle` and `unit` belong to plant_varieties
    // and harvest_log respectively, and reading either off this table would silently be undefined.
    const NOT_ON_TABLE = ['id', 'name', 'crop_type_slug', 'lifecycle', 'unit'];
    for (const col of NOT_ON_TABLE) {
      expect(V_RESOLVED_CARE_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a v_resolved_care column`).not.toContain(col);
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
    expect(parsed.map(([key]) => key)).toEqual(['v_resolved_care']);
    const cols = parsed[0][1];
    expect(cols).toEqual(V_RESOLVED_CARE_COLUMNS);
  });
});
