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
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into an existing contract
// file SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex. A shared
// contract module is invisible to it, which is why a relation several Lambdas JOIN needs a
// contract in each of their directories rather than one in a common place.
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text`; the `--\s.*$` form that 156 other files in this repo carry
// does not, and a surviving `--` hides the CTE declaration that follows it
// (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather
// than hardcoded, so a handler added here that JOINs container is covered the day it lands
// instead of the day someone remembers to extend a list.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

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
    'type', 'updated_at', 'variety', 'version'
  ],
};

const CONTAINER_COLUMNS = AUDIT_COLUMNS.container;

// Extraction mirrors scripts/dev-main-schema-audit.py:238-286 so this guard sees the same
// statements Phase 4 credits. Only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation — that is where the auditor's `l` phantom
// came from (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// Regex literals are re-created on every evaluation, so each call gets a fresh lastIndex. The alias
// group is OPTIONAL: an unaliased `FROM public.container WHERE ...` captures the next keyword,
// which NOT_AN_ALIAS rejects and UNALIASED_ARMS then has to account for by hand.
const bindings = (s) => [...s.matchAll(
  /\b(?:FROM|JOIN)\s+(?:public\.)?container\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?/gi,
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

// Scoped to statements that BIND container, so an `x.col` belonging to some other query in the
// same file can never be read as this table's.
const columnsOf = (s) => [...new Set(aliasesOf(s).flatMap((a) => [...s.matchAll(
  new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
)].map((m) => m[1].toLowerCase())))];

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1].replace(DISTINCT_FROM, ' '))
    .filter((s) => bindings(s).length > 0)
    .map((sql) => ({ file: f, sql }));
});

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
    pin: /SELECT id, classification AS kind, parent_id AS parent_project_id, display_name AS name,\s+target_end_date, kind_set_at\s+FROM public\.container/,
    columns: [
      'id', 'classification', 'parent_id', 'display_name', 'target_end_date', 'kind_set_at',
      'deleted_at'
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
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(STATEMENTS).toHaveLength(11);
    expect([...new Set(STATEMENTS.flatMap((s) => aliasesOf(s.sql)))].sort())
      .toEqual(['c', 'p', 'pp']);
  });

  it('accounts for every unaliased container read', () => {
    // An unaliased read added without a pin here would slip past columnsOf() entirely and the
    // tightness assertion below would still pass — this count is what closes that hole.
    const bare = STATEMENTS.reduce((n, s) => n + unaliasedIn(s.sql), 0);
    expect(bare).toBe(UNALIASED_ARMS.length);
    for (const arm of UNALIASED_ARMS) {
      const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
      expect(arm.pin.test(src), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set([
      ...STATEMENTS.flatMap((s) => columnsOf(s.sql)),
      ...UNALIASED_ARMS.flatMap((a) => a.columns),
    ])].sort();
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
      for (const { file, sql } of STATEMENTS) {
        for (const a of aliasesOf(sql)) {
          expect(sql, `${file}: ${a}.${col} is not a container column`)
            .not.toMatch(new RegExp(String.raw`\b${a}\.${col}\b`, 'i'));
        }
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block
    // with NO warning and NO skip count, and Phase 4 just keeps counting this relation as
    // uncovered. A misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and
    // schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(['container']);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(CONTAINER_COLUMNS);
  });
});
