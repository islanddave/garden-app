// OPS-SCHEMAAUDITJOIN-001 — the public.source columns lambda/inventory-items reads.
//
// WHY IT EXISTS NOW. V4-SOURCEREG-001 gave this handler its first reference to public.source (the
// liveness check behind source_id / acquired_from_source_id), and Phase 4 of
// scripts/dev-main-schema-audit.py is a RATCHET: `uncovered_relations` in
// scripts/schema-audit-join-baseline.json may fall, never rise. A relation touched by a handler and
// declared by no contract in the handler's OWN directory pushes that count up and reds the
// schema-audit workflow — so the contract ships in the same change as the query, not after it.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into an existing contract
// file SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in this
// file's own source text, because parse_test_file does read_text() then regex. lambda/varieties will
// need its own copy for the /sources routes; a shared module would be invisible to both.
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text`; the `--\s.*$` form that most files in this repo carry does
// not, and a surviving `--` hides whatever follows it (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather
// than hardcoded, so a handler added here that reads source is covered the day it lands.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract. Both columns verified present on public.source in live prod Neon on
// 2026-09-04 (12 columns: id, name, kind, locality, address, website_url, notes, match_key,
// created_by, created_at, updated_at, deleted_at).
//
// TWO columns, and the short list is the point rather than an omission. This handler does not read
// the catalogue — it asks one yes/no question about one row, so the contract is `id` (the FK target)
// and `deleted_at` (the liveness predicate). lambda/varieties owns the wide read for the picker and
// will declare the projection it actually selects; a contract listing columns nothing here uses
// would make Phase 1 assert something this code never does.
const AUDIT_COLUMNS = {
  source: ['deleted_at', 'id'],
};

const SOURCE_COLUMNS = AUDIT_COLUMNS.source;

// Extraction mirrors scripts/dev-main-schema-audit.py:238-286 so this guard sees the same
// statements Phase 4 credits. Only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// The alias group is OPTIONAL: an unaliased `FROM public.source WHERE ...` captures the next
// keyword, which NOT_AN_ALIAS rejects and UNALIASED_ARMS then has to account for by hand.
// `(?!\s*\.)` keeps `source_kind` / `source_plant_id` out — \b alone would match the prefix of
// neither (underscore is a word character), but the negative lookahead also rejects a qualified
// `source.` reference that is really a schema name.
const bindings = (s) => [...s.matchAll(
  /\b(?:FROM|JOIN)\s+(?:public\.)?source\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?/gi,
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

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

// Reads that name source with NO alias. Nothing can attribute their bare identifiers automatically —
// the surrounding query may scan other tables through their own aliases — so the arm is PINNED to
// its literal SQL and its columns listed by hand. Edit the query and the pin stops matching and this
// file reds, which is the only thing keeping the hand-listed columns honest.
//
// The whole of this handler's use of the relation is findDeadSourceRef: one existence probe, one
// bound id, `deleted_at IS NULL`. It is the ENTIRE contract, which is why an exact statement count
// below is affordable here where a floor would be the usual compromise.
const UNALIASED_ARMS = [
  {
    file: 'index.js',
    pin: /SELECT 1 FROM public\.source WHERE id = \$\{id\} AND deleted_at IS NULL/,
    columns: ['id', 'deleted_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/inventory-items source column contract', () => {
  it('finds the source statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a second read of this catalogue should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(STATEMENTS).toHaveLength(1);
  });

  it('accounts for every unaliased source read', () => {
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
    expect(referenced).toEqual([...SOURCE_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to a different source-ish thing', () => {
    // `slug` and `display_name` are public.source_KIND's primary key and label, and the two tables
    // are one join apart in the picker's data model — reading either off `source` is the likeliest
    // way to write a query that parses, deploys and 500s. `match_key` is real but GENERATED, so it
    // is never a legal thing to bind or compare a caller-supplied value against here.
    const NOT_ON_TABLE = ['slug', 'display_name', 'sort_order', 'source_id'];
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
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(['source']);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(SOURCE_COLUMNS);
  });
});
