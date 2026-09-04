// OPS-SCHEMAAUDITJOIN-001 — the public.source / public.source_kind columns lambda/varieties reads.
//
// WHY THIS FILE HAD TO SHIP WITH THE ROUTES AND NOT AFTER THEM: Phase 4 of
// scripts/dev-main-schema-audit.py counts (directory, relation) pairs a handler binds in FROM/JOIN
// that no column contract in that handler's OWN directory declares, and fails when the count
// exceeds scripts/schema-audit-join-baseline.json. V4-SOURCEREG-001 introduced the first two reads
// of these relations anywhere in lambda/, so landing them without this file raises the baseline by
// two — and the L-081 ratchet is a one-way instrument: a new relation gets a contract, the number
// never goes up.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into an existing contract
// file SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex.
//
// Six statements, every one unaliased, so all six are pinned by hand below. Two of them exist to
// read soft-deleted rows ON PURPOSE and are pinned for that reason: source.match_key is unique only
// among live rows (so the collision probe must see the deleted ones to offer a restore), and
// source_kind.slug is the PRIMARY KEY (so a resurrect would violate it rather than conflict).
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope. (source-routes.test.js in this directory does import the handler,
// through the vitest.config.ts stub aliases — but the assertions here are about SQL TEXT, which is
// what the auditor itself reads, and reading it the same way is the point.)
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text`; a surviving `--` hides the CTE declaration that follows it
// (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather
// than hardcoded, so a handler added here that binds either relation is covered the day it lands.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract. Every column below verified present on live prod Neon 2026-09-04 through
// information_schema.columns (source: 12 columns, source_kind: 7).
// The keyed form binds columns to ONE relation each, so this file cannot assert source's list onto
// source_kind — the cross-product the unkeyed form produces is what made joined relations
// unauditable in the first place.
const AUDIT_COLUMNS = {
  source: ['address', 'deleted_at', 'id', 'kind', 'locality', 'match_key', 'name', 'notes', 'website_url'],
  source_kind: ['deleted_at', 'display_name', 'slug', 'sort_order'],
};

const RELATIONS = Object.keys(AUDIT_COLUMNS);

// Extraction mirrors scripts/dev-main-schema-audit.py:238-286 so this guard sees the same
// statements Phase 4 credits. Only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// `public.source` is a strict PREFIX of `public.source_kind`, and this is the one place in this
// file where getting that wrong is silent: without the trailing \b, every source_kind statement
// also reads as a source statement, the counts still add up, and source's contract inherits
// source_kind's columns. \b fails before `_`, which is what keeps the two apart.
const bindings = (rel, s) => [...s.matchAll(
  new RegExp(String.raw`\b(?:FROM|JOIN)\s+(?:public\.)?${rel}\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?`, 'gi'),
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (rel, s) => [...new Set(bindings(rel, s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (rel, s) => bindings(rel, s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

// Scoped to statements that BIND the relation, so an `x.col` belonging to some other query in the
// same file can never be read as this table's.
const columnsOf = (rel, s) => [...new Set(aliasesOf(rel, s).flatMap((a) => [...s.matchAll(
  new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
)].map((m) => m[1].toLowerCase())))];

const ALL_STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1].replace(DISTINCT_FROM, ' '))
    .map((sql) => ({ file: f, sql }));
});
const statementsFor = (rel) => ALL_STATEMENTS.filter((s) => bindings(rel, s.sql).length > 0);

// Reads that name the relation with NO alias. Nothing can attribute their bare identifiers
// automatically, so each arm is PINNED to its literal SQL and its columns are listed by hand. Edit
// the query and the pin stops matching and this file reds, which is the only thing keeping the
// hand-listed columns honest.
const UNALIASED_ARMS = {
  source: [
    {
      file: 'index.js',
      // GET /api/varieties/sources — the list SourcePicker renders. This projection IS the wire
      // contract; deleted_at appears as a filter only and never reaches the client.
      pin: /SELECT id, name, kind, locality, address, website_url, notes\s+FROM public\.source\s+WHERE deleted_at IS NULL\s+ORDER BY name ASC/,
      columns: ['id', 'name', 'kind', 'locality', 'address', 'website_url', 'notes', 'deleted_at'],
    },
    {
      file: 'index.js',
      // The collision probe for a new source. Reading match_key (a GENERATED column) rather than
      // recomputing the fold in SQL is the point: it is the exact value uq_source_match_key_live
      // indexes. The ABSENCE of a deleted_at filter is also the point and is pinned for it — that
      // index is PARTIAL, so a soft-deleted row does not block the INSERT but IS the row the
      // caller wants restored, and deleted_at is selected here as DATA rather than as a filter.
      pin: /SELECT id, name, kind, locality, address, website_url, notes, deleted_at\s+FROM public\.source\s+WHERE match_key = \$\{matchKey\}\s+ORDER BY deleted_at DESC NULLS FIRST\s+LIMIT 1/,
      columns: ['id', 'name', 'kind', 'locality', 'address', 'website_url', 'notes', 'deleted_at', 'match_key'],
    },
  ],
  source_kind: [
    {
      file: 'index.js',
      // The FK check on POST /sources. Deliberately narrower than the FK itself: a soft-deleted
      // kind still satisfies fk_source_kind, so leaving this to the constraint would let a source
      // be typed to a retired kind.
      pin: /SELECT slug FROM public\.source_kind WHERE slug = \$\{kind\} AND deleted_at IS NULL/,
      columns: ['slug', 'deleted_at'],
    },
    {
      file: 'index.js',
      // GET /api/varieties/source-kinds — the vocabulary the picker's kind control renders.
      // sort_order exists only for this ordering; nothing else in the repo reads it.
      pin: /SELECT slug, display_name, sort_order\s+FROM public\.source_kind\s+WHERE deleted_at IS NULL\s+ORDER BY sort_order ASC, display_name ASC/,
      columns: ['slug', 'display_name', 'sort_order', 'deleted_at'],
    },
    {
      file: 'index.js',
      // The collision set for a newly minted kind, and the one read that must see EVERYTHING.
      // Two different subsets come out of it: slugs from every row (slug is the PK, so a
      // soft-deleted row still occupies it) and labels from the live rows only
      // (uq_source_kind_display_live is PARTIAL). display_name is read here as the LABEL FOLD
      // input, not for display.
      pin: /const allKinds = await sql`SELECT slug, display_name, sort_order, deleted_at FROM public\.source_kind`;/,
      columns: ['slug', 'display_name', 'sort_order', 'deleted_at'],
    },
    {
      file: 'index.js',
      // sort_order for a mint, computed by Postgres inside the INSERT so it cannot be bound wrong.
      // max + 10, NOT the column default of 0: the twelve seeded kinds occupy 10..120 and a 0
      // would sort every minted kind above all of them.
      pin: /\(SELECT coalesce\(max\(sort_order\), 0\) \+ 10 FROM public\.source_kind\)/,
      columns: ['sort_order'],
    },
  ],
};

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/varieties source + source_kind column contract', () => {
  it('finds the statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact counts, not floors: a new statement against either table should be reviewed against the
    // contract rather than inherit it. Update these in the same commit that adds one.
    expect(statementsFor('source')).toHaveLength(2);
    expect(statementsFor('source_kind')).toHaveLength(4);
  });

  it('keeps public.source and public.source_kind apart despite the prefix', () => {
    // The failure this guards is silent: a prefix match would make every source_kind statement also
    // count as a source statement and hand source's contract four columns it never reads.
    const sourceSql = statementsFor('source').map((s) => s.sql);
    expect(sourceSql.every((s) => /public\.source\b/.test(s))).toBe(true);
    expect(sourceSql.some((s) => /public\.source_kind\b/.test(s))).toBe(false);
  });

  for (const rel of RELATIONS) {
    it(`${rel}: accounts for every unaliased read`, () => {
      // An unaliased read added without a pin here would slip past columnsOf() entirely and the
      // tightness assertion below would still pass — this count is what closes that hole.
      const bare = statementsFor(rel).reduce((n, s) => n + unaliasedIn(rel, s.sql), 0);
      expect(bare).toBe(UNALIASED_ARMS[rel].length);
      for (const arm of UNALIASED_ARMS[rel]) {
        const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
        expect(arm.pin.test(src), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
      }
    });

    it(`${rel}: references no column absent from the contract, and declares none it does not use`, () => {
      const referenced = [...new Set([
        ...statementsFor(rel).flatMap((s) => columnsOf(rel, s.sql)),
        ...UNALIASED_ARMS[rel].flatMap((a) => a.columns),
      ])].sort();
      expect(referenced.length).toBeGreaterThan(0);
      // Both directions. An extra column is not harmless padding: the contract is what Phase 1
      // audits against prod, so one nothing reads makes the audit assert something the code doesn't.
      expect(referenced).toEqual([...AUDIT_COLUMNS[rel]].sort());
    });
  }

  it('never reaches for a column that belongs to the OTHER source table', () => {
    // Each of these is a live confusion between the pair. source is keyed by a uuid `id` and its
    // label is `name`; source_kind has NO id at all — `slug` is the PRIMARY KEY and the FK target —
    // and its label is `display_name`. `kind` is what the CHILD column on source is called; on
    // source_kind that same value is `slug`. And `sort_order` orders the vocabulary, not the rows.
    const NOT_ON_TABLE = {
      source: ['display_name', 'slug', 'sort_order'],
      source_kind: ['id', 'name', 'kind', 'locality', 'website_url'],
    };
    for (const rel of RELATIONS) {
      for (const col of NOT_ON_TABLE[rel]) {
        expect(AUDIT_COLUMNS[rel]).not.toContain(col);
        for (const { file, sql } of statementsFor(rel)) {
          for (const a of aliasesOf(rel, sql)) {
            expect(sql, `${file}: ${a}.${col} is not a ${rel} column`)
              .not.toMatch(new RegExp(String.raw`\b${a}\.${col}\b`, 'i'));
          }
        }
        for (const arm of UNALIASED_ARMS[rel]) {
          expect(arm.columns, `${arm.file}: ${col} is not a ${rel} column`).not.toContain(col);
        }
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block
    // with NO warning and NO skip count, and Phase 4 just keeps counting these relations as
    // uncovered. A misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and
    // schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(RELATIONS);
    for (const [, rel, body] of pairs) {
      const cols = [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
      expect(cols).toEqual(AUDIT_COLUMNS[rel]);
    }
  });
});
