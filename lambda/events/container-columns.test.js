// OPS-SCHEMAAUDITJOIN-001 — the public.container columns lambda/events reads.
//
// Thirty statements — the highest count against any relation in this audit — for eight
// columns. events almost never reads a container: it joins one to prove household ownership
// through created_by (garden_node has no RLS, L-087) and to resolve a cover image. The gap between
// 30 statements and 8 columns is the point: this is an authorization surface, not a data surface.
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

// L-081 KEYED contract. Every column below verified present on public.container in live prod Neon on
// 2026-08-29 (30 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  container: [
    'archived_at', 'created_by', 'deleted_at', 'display_name', 'featured_image_id',
    'featured_photo_id', 'id', 'location_id'
  ],
};

const CONTAINER_COLUMNS = AUDIT_COLUMNS.container;

// The container statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'container');

// Reads that name container with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/events container column contract', () => {
  it('finds the container statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    // 31st (BUG-EVENTSPATCHRESOLVE-001): the PATCH resolve ownership pre-read; reads pp.id,
    // pp.deleted_at and pp.created_by, all already in the contract below.
    expect(READS.statements).toHaveLength(31);
    expect(READS.aliases).toEqual(['c', 'pp']);
  });

  it('accounts for every unaliased container read', () => {
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
    expect(referenced).toEqual([...CONTAINER_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on container. `name` is the live one — half the reads in this
    // repo select `display_name AS name`, so the wire field is name and the column is not.
    // container_id, plant_id and project_id are all FK columns POINTING AT this table from
    // elsewhere, never columns on it.
    const NOT_ON_TABLE = ['name', 'container_id', 'plant_id', 'project_id', 'title'];
    for (const col of NOT_ON_TABLE) {
      expect(CONTAINER_COLUMNS).not.toContain(col);
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
    expect(parsed.map(([key]) => key)).toEqual(['container']);
    const cols = parsed[0][1];
    expect(cols).toEqual(CONTAINER_COLUMNS);
  });
});
