// OPS-SCHEMAAUDITJOIN-001 — the public.app_config columns lambda/critter reads and writes.
//
// WHY NOW: V5-ADMINCENTER-001 (e5569b6) put routes 11+12 on this Lambda and with them the first
// FROM against public.app_config. Phase 4 groups by handler directory, so that single new relation
// ref pushed the joined-relation census from 48 to 49 and the `L-081 Schema Audit (dev)` ratchet
// went red on every dev push from 2026-09-09 onward. It is a real gap, not a miscount: the read at
// index.js:483-485 and the upsert at index.js:505-510 carried no column contract in this directory.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into this directory's
// existing contract file would SILENTLY DESTROY its critter_state coverage. Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex.
//
// Static source inspection rather than import: index.js loads @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference, and this Lambda documents app_config's
// shape in prose three times over (index.js:467-473, validators.js:117). The `--(\s.*)?$` arm
// matches a BARE `--` separator line as well as `-- text`
// (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather
// than hardcoded, so a handler added here that touches app_config is covered the day it lands.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract. Verified against live prod Neon on 2026-09-14: public.app_config has
// EXACTLY THREE columns — key (text, PK), value (jsonb), updated_at (timestamptz). The keyed form
// binds these columns to ONE relation, so this file cannot assert its list onto critter_state,
// which select-columns.test.js in this directory declares.
const AUDIT_COLUMNS = {
  app_config: ['key', 'value'],
};

const APP_CONFIG_COLUMNS = AUDIT_COLUMNS.app_config;

const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;
// Mirrors the auditor's Phase 4 extractor. It is what Phase 4 credits, and the ONLY form it sees.
// Built fresh on every call, never shared: .test() on a /g/ regex advances lastIndex, so a
// module-level literal reused across statements would start mid-string and skip matches silently.
const relationRe = () => /\b(?:FROM|JOIN)\s+(?:public\.)?app_config\b(?!\s*\.)/gi;
// The auditor stops at FROM/JOIN, so Phase 4 never sees the upsert — Phase 2 audits that separately
// from its INSERT column list. This file covers BOTH arms deliberately: a directory's contract that
// described only the half one phase happens to look at would be the vacuous kind of coverage
// OPS-L081COLS-001 exists to prevent, and RETURNING key, value is a read by any other name.
const writeTargetRe = () => /\bINSERT\s+INTO\s+(?:public\.)?app_config\b(?!\s*\.)/gi;

const NAMES_TABLE = (s) => relationRe().test(s) || writeTargetRe().test(s);

// Neither arm aliases the table, so nothing can attribute a bare identifier by alias. Instead every
// identifier surviving the removal of the ${...} interpolations, the quoted literals, the relation
// references and the keywords below is treated as a column reference. Fail-closed by construction:
// an identifier this set does not know reads as an unknown column and reds this file rather than
// slipping past it — which is exactly what would happen if updated_at were ever added to the upsert.
const SQL_KEYWORDS = new Set([
  'select', 'from', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'lateral',
  'where', 'and', 'or', 'not', 'is', 'null', 'in', 'any', 'all', 'exists', 'between', 'like',
  'ilike', 'as', 'on', 'using', 'order', 'group', 'by', 'having', 'limit', 'offset', 'asc',
  'desc', 'distinct', 'true', 'false', 'case', 'when', 'then', 'else', 'end', 'with', 'public',
  // Write path. `excluded` is the ON CONFLICT pseudo-relation, `jsonb` a cast target.
  'insert', 'into', 'values', 'conflict', 'do', 'update', 'set', 'excluded', 'returning', 'jsonb',
]);

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1]
      .replace(/\$\{[^}]*\}/g, ' ')
      .replace(DISTINCT_FROM, ' ')
      // 'nav_tabs' is a ROW KEY, not a column. Left in place it reads as an identifier and the
      // absence assertion below could never fire on the one name most likely to be mistaken for one.
      .replace(/'[^']*'/g, ' '))
    .filter(NAMES_TABLE)
    .map((sql) => ({ file: f, sql }));
});

const columnsOf = (s) => [...new Set(
  [...s.replace(relationRe(), ' ').replace(writeTargetRe(), ' ').matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((w) => !SQL_KEYWORDS.has(w)),
)].sort();

// Both arms are unaliased, so the mechanical extraction above has nothing to anchor to except the
// statements themselves. These pins prove the statements it reads are still the ones documented
// here — edit either query and the pin stops matching and this file reds, rather than passing on a
// contract derived from SQL that no longer exists.
const PINNED_ARMS = [
  {
    file: 'index.js',
    // Route 11, GET /api/app-config. Ungated on purpose and keyed by `key` alone — app_config has
    // no created_by and no user_id, which is precisely why route 12 needs the admin gate.
    pin: /SELECT key, value FROM public\.app_config WHERE key = ANY\(/,
  },
  {
    file: 'index.js',
    // Route 12, PATCH /api/app-config. updated_at is deliberately absent from the column list: the
    // live set_updated_at BEFORE UPDATE trigger maintains it (verified on prod 2026-09-14), and
    // naming it here would hand the handler a value the trigger then overwrites.
    pin: /INSERT INTO public\.app_config \(key, value\)[\s\S]*?ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value\s+RETURNING key, value/,
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/critter app_config column contract', () => {
  it('finds the app_config statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(STATEMENTS).toHaveLength(PINNED_ARMS.length);
    for (const arm of PINNED_ARMS) {
      const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
      expect(arm.pin.test(src), `arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set(STATEMENTS.flatMap((s) => columnsOf(s.sql)))].sort();
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. Extra columns are not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing reads makes the audit assert something the code never does.
    expect(referenced).toEqual([...APP_CONFIG_COLUMNS].sort());
  });

  it('leaves updated_at to the trigger — it exists on the table, and no statement may name it', () => {
    // The one column on this table the contract must NOT carry. It is real in prod, so it cannot go
    // in the NOT_ON_TABLE list below; the guard is that the handler never writes or reads it.
    expect(APP_CONFIG_COLUMNS).not.toContain('updated_at');
    for (const { file, sql } of STATEMENTS) {
      expect(sql, `${file}: updated_at is the set_updated_at trigger's, not the handler's`)
        .not.toMatch(/\bupdated_at\b/i);
    }
  });

  it('never reaches for a column that belongs to nothing on this table', () => {
    // None of these exist on public.app_config (information_schema, prod, 2026-09-14) and each is a
    // live confusion: the PK is `key`, never `id` or `name`; the store is installation-wide with NO
    // actor column at all, which index.js:467-473 makes the security argument for; and `nav_tabs` is
    // a ROW KEY in a generic k/v table, not a column of it.
    const NOT_ON_TABLE = ['id', 'name', 'created_by', 'user_id', 'nav_tabs'];
    for (const col of NOT_ON_TABLE) {
      expect(APP_CONFIG_COLUMNS).not.toContain(col);
      for (const { file, sql } of STATEMENTS) {
        expect(sql, `${file}: ${col} is not an app_config column`)
          .not.toMatch(new RegExp(String.raw`\b${col}\b`, 'i'));
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
    expect(pairs.map((m) => m[1])).toEqual(['app_config']);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(APP_CONFIG_COLUMNS);
  });
});
