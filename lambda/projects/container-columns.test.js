// OPS-SCHEMAAUDITJOIN-001 — the public.container columns lambda/projects reads.
//
// container IS the projects table, so this is the relation's home directory and by far its
// widest contract: 23 of the table's 30 columns. Seven statements name it with NO alias, including
// the three near-identical list projections that differ only in their parent_id predicate — each
// is pinned separately rather than by one loose regex, so a change to one of them cannot be
// absorbed by a pin that happens to still match another.
//
// Those projections also qualify by TABLE NAME rather than by alias (`em.project_id = container.id`
// inside the last_activity_at correlated sub-select). Postgres forbids that once a relation is
// aliased, so it only ever appears in the unaliased arms — which is another reason those arms carry
// their columns by hand instead of through the alias scan.
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
    'archived_at', 'assignee_user_id', 'classification', 'created_at', 'created_by', 'deleted_at',
    'description', 'display_name', 'featured_photo_id', 'id', 'is_public', 'kind_set_at',
    'location_id', 'parent_id', 'slug', 'species', 'start_date', 'status', 'target_end_date',
    'type', 'updated_at', 'variety', 'version', 'workspace_id'
  ],
};

const CONTAINER_COLUMNS = AUDIT_COLUMNS.container;

// The container statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'container');

// Reads that name container with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'index.js',
    // The restore probe. Reads deleted_at on a row it expects to be soft-deleted, so this
    // is the one place a NULL deleted_at is the interesting answer rather than the filter.
    pin: /SELECT \/\* restore-probe \*\/ id, deleted_at FROM public\.container/,
    columns: ['id', 'deleted_at', 'created_by'],
  },
  {
    file: 'index.js',
    // PROJ-RESCOPE's pre-state CTE: the snapshot written into proj_rescope_events before an
    // admin reclassify. These five columns ARE the audit record, so a rename here silently changes
    // what a rescope is recoverable from.
    // workspace_id (V5-SPACETENANCYKEY-001 2.2) is not part of that record: it stamps the audit row
    // with the project's own Space.
    pin: /SELECT id, classification AS kind, parent_id AS parent_project_id, display_name AS name,\s+target_end_date, kind_set_at, workspace_id\s+FROM public\.container/,
    columns: [
      'id', 'classification', 'parent_id', 'display_name', 'target_end_date', 'kind_set_at',
      'workspace_id', 'deleted_at'
    ],
  },
  {
    file: 'index.js',
    // The ADMIN list. Distinguished from the three household lists below by having no
    // created_by predicate at all — it returns every project — and by its ORDER BY. It is also the
    // only one of the four that SELECTS created_by.
    pin: /FROM public\.container\s+WHERE deleted_at IS NULL\s+ORDER BY parent_id NULLS FIRST, display_name ASC/,
    columns: [
      'id', 'display_name', 'slug', 'status', 'variety', 'start_date', 'is_public', 'location_id',
      'created_at', 'updated_at', 'parent_id', 'classification', 'target_end_date', 'kind_set_at',
      'assignee_user_id', 'created_by', 'deleted_at'
    ],
  },
  {
    file: 'index.js',
    // Household list, root level only (?parent_id=null).
    pin: /FROM public\.container\s+WHERE created_by = ANY\(\$\{householdIds\}\)\s+AND deleted_at IS NULL\s+AND archived_at IS NULL\s+AND parent_id IS NULL/,
    columns: [
      'id', 'display_name', 'slug', 'status', 'variety', 'start_date', 'is_public', 'location_id',
      'created_at', 'updated_at', 'parent_id', 'classification', 'target_end_date', 'kind_set_at',
      'assignee_user_id', 'created_by', 'deleted_at', 'archived_at'
    ],
  },
  {
    file: 'index.js',
    // Household list, children of one parent (?parent_id=<uuid>).
    pin: /FROM public\.container\s+WHERE created_by = ANY\(\$\{householdIds\}\)\s+AND deleted_at IS NULL\s+AND archived_at IS NULL\s+AND parent_id = \$\{parentIdFilter\}/,
    columns: [
      'id', 'display_name', 'slug', 'status', 'variety', 'start_date', 'is_public', 'location_id',
      'created_at', 'updated_at', 'parent_id', 'classification', 'target_end_date', 'kind_set_at',
      'assignee_user_id', 'created_by', 'deleted_at', 'archived_at'
    ],
  },
  {
    file: 'index.js',
    // Household list, unfiltered — the default GET /api/projects.
    pin: /FROM public\.container\s+WHERE created_by = ANY\(\$\{householdIds\}\)\s+AND deleted_at IS NULL\s+AND archived_at IS NULL\s+ORDER BY start_date DESC NULLS LAST/,
    columns: [
      'id', 'display_name', 'slug', 'status', 'variety', 'start_date', 'is_public', 'location_id',
      'created_at', 'updated_at', 'parent_id', 'classification', 'target_end_date', 'kind_set_at',
      'assignee_user_id', 'created_by', 'deleted_at', 'archived_at'
    ],
  },
  {
    file: 'index.js',
    // V4-AUTHZSWEEP-001's parent check on CREATE. Without it a project could be born
    // parented to another household's container; the created_by predicate is the whole guard.
    pin: /SELECT \/\* authz-parent-check \*\/ id FROM public\.container/,
    columns: ['id', 'created_by', 'deleted_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/projects container column contract', () => {
  it('finds the container statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(11);
    expect(READS.aliases).toEqual(['c', 'p', 'pp']);
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
