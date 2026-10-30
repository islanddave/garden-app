// OPS-SCHEMAAUDITJOIN-001 — the public.source columns lambda/plants reads.
//
// WHY IT EXISTS NOW. V4-SOURCEREG-001 gave this handler its first reference to public.source (the
// liveness check behind source_id / acquired_from_source_id), and Phase 4 of
// scripts/dev-main-schema-audit.py is a RATCHET: `uncovered_relations` in
// scripts/schema-audit-join-baseline.json may fall, never rise. Measured with the auditor's own
// parse_sql_relations / parse_test_file against this worktree: lambda/plants' gap goes 14 -> 15 and
// the global total 48 -> 49 the moment the query lands, so the contract ships in the same change as
// the query rather than after it. lambda/inventory-items carries the identical file for the identical
// reason; this is the second of the three the source picker needs.
//
// A new relation this directory reads goes in as a key of one of its keyed AUDIT_COLUMNS files, not
// a new file (scripts/count-ratchets.json). Never put both forms in one file: parse_test_file returns on
// the keyed form first, so a keyed block in an AUDIT_TABLES file silently drops that file's tables
// (this directory's select-columns.test.js declares `garden_node` that way).
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in this
// file's own source text, because parse_test_file does read_text() then regex. A shared module is
// invisible to it.
//
// Static source inspection rather than import: lambda/_test-stubs make the handlers importable, but
// the stub never evaluates SQL, so the columns a statement names are visible only in its source text.
import { describe, it, expect } from 'vitest';
import { ownContract, tableReads } from '../_test-stubs/columnContract.js';

// L-081 KEYED contract. Both columns verified present on public.source in live prod Neon on
// 2026-09-04 (12 columns: id, name, kind, locality, address, website_url, notes, match_key,
// created_by, created_at, updated_at, deleted_at).
//
// TWO columns, and the short list is the point rather than an omission. This handler does not read
// the catalogue — it asks one yes/no question about one row, so the contract is `id` (the FK target)
// and `deleted_at` (the liveness predicate). lambda/varieties owns the wide read for the picker and
// declares the projection it actually selects; a contract listing columns nothing here uses would
// make Phase 1 assert something this code never does.
const AUDIT_COLUMNS = {
  source: ['deleted_at', 'id'],
};

const SOURCE_COLUMNS = AUDIT_COLUMNS.source;

// The source statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
// Its `source\b(?!\s*\.)` binding keeps this directory's source_* columns (source_type, source_ref,
// source_generation, source_inventory_item_id) and a schema-qualified `source.` out.
const READS = tableReads(import.meta.url, 'source');

// Reads that name source with NO alias. Nothing can attribute their bare identifiers automatically —
// the surrounding query may scan other tables through their own aliases — so the arm is PINNED to
// its literal SQL and its columns listed by hand. Edit the query and the pin stops matching and this
// file reds, which is the only thing keeping the hand-listed columns honest.
//
// The whole of this handler's use of the relation is findDeadSourceRef: one existence probe, one
// bound id, `deleted_at IS NULL`, shared by both verbs. It is the ENTIRE contract, which is why an
// exact statement count below is affordable here where a floor would be the usual compromise.
const UNALIASED_ARMS = [
  {
    file: 'index.js',
    pin: /SELECT 1 FROM public\.source WHERE id = \$\{id\} AND deleted_at IS NULL/,
    columns: ['id', 'deleted_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/plants source column contract', () => {
  it('finds the source statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a second read of this catalogue should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(1);
    expect([...new Set(READS.statements.map((s) => s.file))]).toEqual(['index.js']);
  });

  it('accounts for every unaliased source read', () => {
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
    expect(referenced).toEqual([...SOURCE_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to a different source-ish thing', () => {
    // Every name here is a live confusion in THIS directory rather than a generic near-miss.
    // source_type / source_ref / source_generation and source_inventory_item_id are columns on
    // public.plants and sit four lines from the new ones in the same SET list; `slug` and
    // `display_name` are public.source_KIND's primary key and label, one join away in the picker's
    // data model, and `display_name` is additionally what garden_node renames plants.name to, so it
    // is the single likeliest identifier to be reached for by muscle memory in this file.
    // `match_key` is real but GENERATED, so it is never a legal thing to bind a caller value against.
    const NOT_ON_TABLE = [
      'source_type', 'source_ref', 'source_generation', 'source_inventory_item_id',
      'slug', 'display_name', 'match_key',
    ];
    for (const col of NOT_ON_TABLE) {
      expect(SOURCE_COLUMNS).not.toContain(col);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a source column`).not.toContain(col);
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with
    // NO warning and NO skip count, and Phase 4 just keeps counting this relation as uncovered. A
    // misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and schema-audit.yml
    // maps exit 2 to a ::warning and exit 0, so one typo silences all four phases behind a green
    // check. Replicate the auditor's own two regexes against this file's own source.
    const parsed = ownContract(import.meta.url);
    expect(parsed).not.toBeNull();
    expect(parsed.map(([key]) => key)).toEqual(['source']);
    const cols = parsed[0][1];
    expect(cols).toEqual(SOURCE_COLUMNS);
  });
});
