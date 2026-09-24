// OPS-L081LOCHEATED-001 — the L-081 column contract for `locations`, which daily-plan's nightly
// plantings query and its rain autolog both read.
//
// WHY IT EXISTS: v4.137.0 made the plantings query select `l.heated` UNCONDITIONALLY. On a schema without
// that column the query throws, and that is the nightly plan for both users. Until this file the daily-plan
// L-081 audit covered weather_daily only, so nothing in CI checked any `locations` column against prod
// (the integration tests never run this query, and daily-plan has no staging Lambda).
//
// WHY A NEW FILE AND NOT select-columns.test.js: that file declares AUDIT_TABLES = ['weather_daily'], and
// scripts/dev-main-schema-audit.py cross-products every collected *COLUMNS array against every declared
// table (parse_test_file, form 1). Adding `locations` there would demand weather_daily.heated and FAIL.
// A keyed block dropped into it is worse: form 0 returns first, so weather_daily would silently leave the
// audit (the trap lambda/daily-plan-read/household-columns.test.js documents). One relation, one file.
//
// HOW CI CONSUMES IT: .github/workflows/schema-audit.yml runs on every push to dev that touches
// lambda/**/*.js (this file included). dev-main-schema-audit.py Phase 1 globs lambda/**/*columns.test.js,
// REGEX-parses the AUDIT_COLUMNS literal out of this file's TEXT (it never runs it), and checks each
// (table, column) against prod's information_schema.columns: a missing one exits 1 and reds the workflow.
// That workflow is advisory, but promote-gate.yml runs the same audit (--gate) on the promoted SHA before main
// moves and refuses the promote on a miss (OPS-PROMOTESCHEMAGATE-001). This vitest file is what keeps the
// declared list honest in both directions: every declared column is really read by the daily-plan SQL,
// and every `locations` column that SQL reads is declared, so the next `l.<col>` cannot ship unaudited.
//
// The plantings statement is read as the DRIVER RECEIVES it (the cover-inherit-test harness), with the
// flag off and on, because the flag splices a recursive CTE over locations into it at runtime. The other
// statements are the `.query(` templates in the Lambda's source, which is how select-columns.test.js
// reads them. No Postgres here: the columns' existence is the auditor's job, against prod.
//
// MUTATION LOG — 2026-09-18, lane-nextfixes-20260918. Each applied alone, this file run, RED observed,
// file restored byte-for-byte (sha256 checked):
//   * contract drops `heated` / declares an unread `frost_free`          -> 1 RED each (exact set)
//   * plantings query reads a new `l.name`                              -> 2 RED
//   * plantings query stops reading `l.heated`                          -> 3 RED
//   * flag-ON-only cover CTE reads `l0.name`                            -> 1 RED (the ON capture is load-bearing)
//   * rain autolog roof walk reads `l.level`                            -> 1 RED (the source scan is load-bearing)
//   * an unaliased `(select count(*) from locations)`                   -> 1 RED
//   * the contract's closing `};` dropped                               -> 1 RED (auditor-shape case)
//   * the auditor's PHASE1_GLOB narrowed to `*select-columns.test.js`   -> 1 RED (this file would go unread)
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { run } = handler;

// L-081 KEYED contract. `heated` is migrations/v5-locheated-001 (on prod since 2026-09-18,
// schema_version 5.0.0-locheated-001). parent_id and deleted_at are read only by the flag-gated
// cover-inherit CTE and by the rain autolog's roof walk.
const AUDIT_COLUMNS = {
  locations: ['id', 'parent_id', 'covered', 'type_label', 'heated', 'deleted_at'],
};

// The plantings SELECT is the FIRST statement run() issues; throwing on it stops the run there.
async function plantingsSql(flagOverrides) {
  let sql = null;
  const pg = { query: async (q) => { if (sql === null) { sql = q; throw new Error('__captured__'); } return { rows: [] }; } };
  try { await run({ pg, today: '2026-09-18', dryRun: true, flagOverrides }); } catch (e) { if (e.message !== '__captured__') throw e; }
  if (sql === null) throw new Error('no statement captured — this guard has gone blind');
  return sql;
}

// JS `//` comments first, for the source scan (same rule as select-columns.test.js)...
const jsDecomment = (s) => s.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
// ...then SQL `--` comments, including a BARE `--`. The plantings statement names `l.covered` and
// `locations.heated` in its own `--` prose, and those are not column reads.
const sqlDecomment = (s) => s.split('\n').map((l) => l.replace(/(^|\s)--(\s.*)?$/, '$1')).join('\n');

function sourceStatements() {
  const files = readdirSync(__dirname).filter((f) => /\.js$/.test(f) && !/\.test\.js$/.test(f));
  return files.flatMap((f) => jsDecomment(readFileSync(join(__dirname, f), 'utf8'))
    .match(/\.query\(\s*`[^`]*`/g) ?? []);
}

// A `locations` relation reference and its alias. A reference with NO alias captures nothing and is
// reported by name below, because this guard can only attribute `alias.col` reads.
const LOC_REF = /\b(?:from|join)\s+(?:public\.)?locations\b(?:\s+(?:as\s+)?(?!(?:on|where|left|right|inner|join|using|cross|full|natural|group|order|limit|union)\b)([a-z_][a-z0-9_]*))?/gi;

function locationsReads(stmt) {
  const s = sqlDecomment(stmt);
  const cols = new Set();
  const unaliased = [];
  for (const m of s.matchAll(LOC_REF)) {
    if (!m[1]) { unaliased.push(m[0]); continue; }
    for (const c of s.matchAll(new RegExp(`\\b${m[1]}\\.([a-z_][a-z0-9_]*)\\b`, 'gi'))) cols.add(c[1].toLowerCase());
  }
  return { refs: [...s.matchAll(LOC_REF)].length, cols, unaliased };
}

const STATEMENTS = async () => [
  ['plantings, cover-inherit OFF', await plantingsSql(null)],
  ['plantings, cover-inherit ON', await plantingsSql({ CARE_COVER_INHERIT_ENABLED: true })],
  ...sourceStatements().map((s, i) => [`source .query #${i}`, s]),
];

describe('OPS-L081LOCHEATED-001 — daily-plan `locations` column contract (L-081 Phase 1)', () => {
  it('the plantings query reads l.heated with the cover-inherit flag off AND on (it is unconditional)', async () => {
    for (const ovr of [null, { CARE_COVER_INHERIT_ENABLED: true }]) {
      expect([...locationsReads(await plantingsSql(ovr)).cols]).toContain('heated');
    }
  });

  it('declares exactly the locations columns the daily-plan SQL reads — no more, no fewer', async () => {
    const read = new Set();
    let bearing = 0;
    for (const [label, stmt] of await STATEMENTS()) {
      const r = locationsReads(stmt);
      expect(r.unaliased, `${label}: an unaliased locations reference — extend this guard`).toEqual([]);
      if (r.refs) bearing++;
      for (const c of r.cols) read.add(c);
    }
    // non-vacuity: both captured plantings statements plus the source templates that carry the
    // plantings query and the rain autolog's roof walk
    expect(bearing).toBeGreaterThanOrEqual(4);
    expect([...read].sort()).toEqual([...AUDIT_COLUMNS.locations].sort());
  });

  it('only the flag-ON plantings statement reaches parent_id/deleted_at — so both captures are needed', async () => {
    const off = locationsReads(await plantingsSql(null)).cols;
    const on = locationsReads(await plantingsSql({ CARE_COVER_INHERIT_ENABLED: true })).cols;
    expect([...off].sort()).toEqual(['covered', 'heated', 'id', 'type_label']);
    expect([...on]).toEqual(expect.arrayContaining(['parent_id', 'deleted_at']));
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py parses, under its Phase 1 glob', () => {
    // The auditor reads TEXT: replicate its own regexes against this file. The closing `};` is load-bearing
    // (without it the block is ignored with no warning), and the body must hold pairs only.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(['locations']);
    expect([...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1])).toEqual(AUDIT_COLUMNS.locations);
    // and the auditor's discovery glob, read from the script rather than restated, still matches this name
    const audit = readFileSync(join(__dirname, '..', '..', 'scripts', 'dev-main-schema-audit.py'), 'utf8');
    const glob = audit.match(/^PHASE1_GLOB\s*=\s*"([^"]+)"/m)[1];
    expect(new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(basename(fileURLToPath(import.meta.url)))).toBe(true);
  });
});
