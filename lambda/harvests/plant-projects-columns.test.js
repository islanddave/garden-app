// OPS-SCHEMAAUDITJOIN-001 — the public.plant_projects columns lambda/harvests reads.
//
// Five statements, every one through the `pj` alias, and the only directory here that reads
// archived_at. Three are index.js label reads (`pj.name AS project_name`, :240 and :322); one is
// ready-impression.js:175, whose ownership test is COALESCE(pj.created_by, p.created_by) — a
// project-less planting is owned by its own created_by; and watch-route.js excludes archived and
// soft-deleted containers from the ready-to-pick watch, which is where archived_at comes from. No
// unaliased read: this directory never reaches the table without binding it.
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
// than hardcoded, so a handler added here that JOINs plant_projects is covered the day it lands
// instead of the day someone remembers to extend a list.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract. Every column below verified present on public.plant_projects in live prod Neon on
// 2026-08-29 (33 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  plant_projects: ['archived_at', 'created_by', 'deleted_at', 'id', 'name'],
};

const PLANT_PROJECTS_COLUMNS = AUDIT_COLUMNS.plant_projects;

// Extraction mirrors scripts/dev-main-schema-audit.py:238-286 so this guard sees the same
// statements Phase 4 credits. Only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation — that is where the auditor's `l` phantom
// came from (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// Regex literals are re-created on every evaluation, so each call gets a fresh lastIndex. The alias
// group is OPTIONAL: an unaliased `FROM public.plant_projects WHERE ...` captures the next keyword,
// which NOT_AN_ALIAS rejects and UNALIASED_ARMS then has to account for by hand.
const bindings = (s) => [...s.matchAll(
  /\b(?:FROM|JOIN)\s+(?:public\.)?plant_projects\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?/gi,
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

// Scoped to statements that BIND plant_projects, so an `x.col` belonging to some other query in the
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

// Reads that name plant_projects with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/harvests plant_projects column contract', () => {
  it('finds the plant_projects statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(STATEMENTS).toHaveLength(5);
    expect([...new Set(STATEMENTS.flatMap((s) => aliasesOf(s.sql)))].sort())
      .toEqual(['pj']);
  });

  it('accounts for every unaliased plant_projects read', () => {
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
    expect(referenced).toEqual([...PLANT_PROJECTS_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on plant_projects, and each is a live confusion. The primary key is `id`;
    // `project_id` is the FK POINTING AT this table from plants, photos and event_log. The label
    // column is `name` — `display_name` belongs to container, the VIEW over this table that much of
    // the repo reads instead. There is no plant_id: a container does not point at a planting, the
    // planting points at the container. And the cultivar column here is free-text `variety`, not the
    // `variety_id` uuid that plants carries.
    const NOT_ON_TABLE = ['project_id', 'display_name', 'plant_id', 'variety_id'];
    for (const col of NOT_ON_TABLE) {
      expect(PLANT_PROJECTS_COLUMNS).not.toContain(col);
      for (const { file, sql } of STATEMENTS) {
        for (const a of aliasesOf(sql)) {
          expect(sql, `${file}: ${a}.${col} is not a plant_projects column`)
            .not.toMatch(new RegExp(String.raw`\b${a}\.${col}\b`, 'i'));
        }
      }
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a plant_projects column`).not.toContain(col);
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
    expect(pairs.map((m) => m[1])).toEqual(['plant_projects']);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(PLANT_PROJECTS_COLUMNS);
  });
});
