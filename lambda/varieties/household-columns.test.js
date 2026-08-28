// OPS-SCHEMAAUDITJOIN-001 — the four relations household.js queries, and the columns each of its
// write-FK ownership loaders touches.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT MERGED INTO select-columns.test.js: locations,
// inventory_items, spaces and photos are nobody's "own" table here — they are referenced by a shared
// helper — so under the AUDIT_TABLES form they were audited by NOTHING. That form cross-products
// every collected *COLUMNS array against every declared table, which is why each such file declares
// exactly one table, and why joined relations carried no contract at all until the keyed form landed
// (BUG-SEEDDETAIL500-001: `p.name` on garden_node passed a green audit and 500-ed every seed packet
// page). Worse, dropping a keyed AUDIT_COLUMNS block into an existing select-columns.test.js
// SILENTLY DESTROYS that file's coverage — parse_test_file returns on the keyed form first and never
// reaches the AUDIT_TABLES collector (scripts/dev-main-schema-audit.py:128-137). Always a new file.
//
// WHY IT IS COPIED 19 TIMES: Phase 4 credits a contract only to the handler's OWN directory (it
// groups by Path(handler).parent), and only when the AUDIT_COLUMNS literal is in that file's own
// source text — parse_test_file does read_text() then regex, so importing a shared contract object
// from a helper module is invisible to it. So this file lives beside every household.js: the 18
// per-Lambda copies plus canonical lambda/ itself. The copies are held byte-identical by
// lambda/household-columns-sync.test.js.
//
// Static source inspection rather than import: the contract has to be asserted against the SQL TEXT,
// and household.js is imported by handlers that load @neondatabase/serverless at module scope.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference — household.js documents its owner columns
// and the stale photos.uploaded_by in prose, and without this the assertions below would read that
// prose as SQL. The `--(\s.*)?$` arm matches a BARE `--` separator line too; the `--\s.*$` form that
// 156 other files in this repo carry does not, and a surviving `--` hides the CTE that follows it
// (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'household.js'), 'utf8'));

// L-081 KEYED contract. Every column below verified present on live prod Neon 2026-08-28.
// TWO PROD TRAPS, both deliberate and both asserted below: spaces has NO deleted_at (9 columns —
// household.js:79 says so in prose, this makes it enforceable) and photos has NO name (24 columns).
// Giving all four relations the same four-column array is the obvious copy-paste error, and it
// hard-FAILs Phase 1 with exit 1.
const AUDIT_COLUMNS = {
  locations: ['id', 'name', 'created_by', 'deleted_at'],
  inventory_items: ['id', 'name', 'created_by', 'deleted_at'],
  spaces: ['id', 'name', 'created_by'],
  photos: ['id', 'created_by', 'deleted_at'],
};

// Extraction mirrors scripts/dev-main-schema-audit.py:238-286 so this guard sees exactly the
// relation set Phase 4 will credit. Only SQL inside a tagged sql`` template is in scope.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation — that is where the auditor's `l` phantom
// came from (dev-main-schema-audit.py:239-242). household.js has none today; the scrub is here so a
// future one cannot quietly invent a relation this contract does not declare.
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;
const RELATION = /\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)(?!\s*\.)/gi;

// household.js uses NO table aliases — every statement is the bare `SELECT id, name FROM locations`
// form — so the `ct.<col>` extractor in lambda/dashboard/crop-types-columns.test.js would match
// nothing here and pass vacuously. Instead every bare identifier surviving the removal of the ${...}
// interpolations, the relation names and the keywords below is treated as a column reference.
// Fail-closed by construction: an identifier this set does not know reads as an unknown column and
// reds the test rather than slipping past it.
const SQL_KEYWORDS = new Set([
  'select', 'from', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'lateral',
  'where', 'and', 'or', 'not', 'is', 'null', 'in', 'any', 'all', 'exists', 'between', 'like',
  'ilike', 'as', 'on', 'using', 'order', 'group', 'by', 'having', 'limit', 'offset', 'asc',
  'desc', 'distinct', 'true', 'false', 'case', 'when', 'then', 'else', 'end', 'with', 'public',
]);

const STATEMENTS = [...SRC.matchAll(SQL_TEMPLATE)].map((m) => m[1]
  .replace(/\$\{[^}]*\}/g, ' ')
  .replace(DISTINCT_FROM, ' '));

const relationsOf = (stmt) => [...new Set(
  [...stmt.matchAll(RELATION)].map((m) => m[1].toLowerCase()),
)].sort();

const columnsOf = (stmt) => [...new Set(
  [...stmt.replace(RELATION, ' ').matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((w) => !SQL_KEYWORDS.has(w)),
)].sort();

describe('OPS-SCHEMAAUDITJOIN-001 — household.js column contract', () => {
  it('still issues the four ownership SELECTs, so the assertions below are not vacuous', () => {
    expect(SRC).toMatch(/SELECT\s+id,\s*name\s+FROM\s+locations\b/);
    expect(SRC).toMatch(/SELECT\s+id,\s*name\s+FROM\s+inventory_items\b/);
    expect(SRC).toMatch(/SELECT\s+id,\s*name\s+FROM\s+spaces\b/);
    expect(SRC).toMatch(/SELECT\s+id\s+FROM\s+photos\b/);
    expect(STATEMENTS).toHaveLength(4);
  });

  it('touches exactly the relations the contract declares — no more, no fewer', () => {
    // The direction that matters for the Phase 4 ratchet: a relation added to household.js without a
    // contract entry is 19 uncovered refs at once, one per copy dir, and would FAIL the ratchet.
    const touched = [...new Set(STATEMENTS.flatMap(relationsOf))].sort();
    expect(touched).toEqual(Object.keys(AUDIT_COLUMNS).sort());
  });

  it('references no column absent from its relation contract, and declares none it does not use', () => {
    for (const stmt of STATEMENTS) {
      const rels = relationsOf(stmt);
      // One relation per statement is what makes the column->relation mapping unambiguous. A future
      // JOIN here must extend this guard rather than silently widen its blind spot.
      expect(rels).toHaveLength(1);
      const declared = AUDIT_COLUMNS[rels[0]];
      expect(declared, `no AUDIT_COLUMNS entry for ${rels[0]}`).toBeDefined();
      expect(columnsOf(stmt)).toEqual([...declared].sort());
    }
  });

  it('keeps the two prod column traps — spaces has no deleted_at, photos has no name', () => {
    // Verified against prod information_schema 2026-08-28. These are not omissions to tidy up: the
    // columns do not exist, and adding them to make the four arrays match hard-FAILs Phase 1.
    expect(AUDIT_COLUMNS.spaces).not.toContain('deleted_at');
    expect(AUDIT_COLUMNS.photos).not.toContain('name');
    // And the SQL must not reach for them either. Scoped to the one statement that names the
    // relation — a whole-file scan would match the deleted_at in the NEXT loader's query.
    const stmtFor = (rel) => STATEMENTS.find((s) => relationsOf(s).includes(rel));
    expect(columnsOf(stmtFor('spaces'))).not.toContain('deleted_at');
    expect(columnsOf(stmtFor('photos'))).not.toContain('name');
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with
    // NO warning and NO skip count, and the audit just quietly keeps counting these relations as
    // uncovered. Replicate the auditor's own two regexes against this file's own source text.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`. Drop that semicolon and `[\s\S]*?` runs on to the
    // next `};` in the file, swallowing everything between — measured 2026-08-28, and because the
    // swallowed text happens to contain no `key: [...]` pairs the auditor still extracts the right
    // four. That makes the file parseable BY ACCIDENT, one unrelated edit away from going dark with
    // no warning and no skip count. A contract body holds pairs only, never statements.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1]).sort()).toEqual(Object.keys(AUDIT_COLUMNS).sort());
    for (const [, table, body] of pairs) {
      const cols = [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
      expect(cols).toEqual(AUDIT_COLUMNS[table]);
    }
  });
});
