// OPS-SCHEMAAUDITJOIN-001 — the public.plants columns lambda/events reads.
//
// Five statements. Two are authz-parents.js, the write-FK parent resolver byte-identical in
// seven directories; the other three are index.js harvest reads. Two of those join a planting
// only to filter (p.deleted_at IS NULL) while ownership is proved through the container, and
// the third is the ready-to-pick projection, the only reader here of status, archived_at and
// variety_id. The fifth names the table with NO alias — a scalar sub-select for the
// container-level harvest history — and is pinned below.
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

// L-081 KEYED contract. Every column below verified present on public.plants in live prod Neon on
// 2026-08-29 (55 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  plants: ['archived_at', 'created_by', 'deleted_at', 'id', 'name', 'project_id', 'status', 'variety_id'],
};

const PLANTS_COLUMNS = AUDIT_COLUMNS.plants;

// The plants statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'plants');

// Reads that name plants with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'index.js',
    // The container-level harvest history: rows logged against the container rather than any
    // one planting, reached by resolving THIS planting's project_id in a scalar sub-select.
    // `AND deleted_at IS NULL` inside the sub-select is load-bearing — without it a soft-deleted
    // planting still resolves a project_id and the caller gets a sibling container's harvests.
    pin: /AND e\.project_id = \(SELECT project_id FROM plants WHERE id = \$\{plantId\}::uuid AND deleted_at IS NULL\)/,
    columns: ['project_id', 'id', 'deleted_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/events plants column contract', () => {
  it('finds the plants statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(6);
    expect(READS.aliases).toEqual(['gn', 'gn2', 'p', 'pl']);
  });

  it('accounts for every unaliased plants read', () => {
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
    expect(referenced).toEqual([...PLANTS_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on plants, and each is a live confusion. The primary key is `id`;
    // `plant_id` is the FK POINTING AT this table from event_log, photos and ready_impression.
    // `display_name` belongs to garden_node, the VIEW over this table — the reads here address the
    // BASE table, where the CHECK constraints live, and it calls the column `name`. A planting
    // reaches its container through `project_id`, never a container_id. The crop taxonomy is two
    // hops away (plants.variety_id -> plant_varieties.crop_type_slug), so crop_type_slug is not
    // here. And the cultivar link is the `variety_id` uuid; free-text `variety` is plant_projects'.
    const NOT_ON_TABLE = ['plant_id', 'display_name', 'container_id', 'crop_type_slug', 'variety'];
    for (const col of NOT_ON_TABLE) {
      expect(PLANTS_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a plants column`).not.toContain(col);
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
    expect(parsed.map(([key]) => key)).toEqual(['plants']);
    const cols = parsed[0][1];
    expect(cols).toEqual(PLANTS_COLUMNS);
  });
});
