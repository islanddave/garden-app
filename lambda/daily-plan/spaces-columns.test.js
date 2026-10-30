// BUG-SPACESREADUNSCOPED-001 — the L-081 column contract for `spaces`, which daily-plan reads twice per run:
// the plantings query's `join spaces sp` (each planting's Space and household) and the per-run Space read
// `select id, postal_code, weather_lat, weather_lng, created_by from spaces` (handler.js, after db-ready),
// which drives every Space's weather point, owner and household.
//
// WHY IT EXISTS: until this file no CI check named a `spaces` column for daily-plan. A renamed or dropped
// weather_lat/weather_lng/created_by would throw on the Space read and stop the nightly plan for every
// user, and the integration tests reach that read only through AC-7's text match. Multi-space Phase 1
// (step 1.6) puts the read under the same audit the `locations` and `weather_daily` reads already have.
//
// WHY A NEW FILE AND NOT AN EXISTING ONE (scripts/count-ratchets.json `raises`): select-columns.test.js
// declares AUDIT_TABLES = ['weather_daily'], and the auditor cross-products every *COLUMNS array against
// every declared table, so `spaces` there would demand weather_daily.postal_code. locations-columns.test.js
// is keyed but pins its key set to exactly ['locations'] (its auditor-shape case). One relation, one file.
// `plots` is the exception, declared here by multi-space step 3.2b (V5-SPACEPLOTTIER-001): the Space tier's
// child, read once, by the weather_daily upsert's plot_id stamp (handler.js writeWeatherDaily). Its
// reads must carry an alias (`plots pl`) so each column is attributable.
//
// HOW CI CONSUMES IT: as locations-columns.test.js says — scripts/dev-main-schema-audit.py Phase 1 globs
// lambda/**/*columns.test.js, regex-parses the AUDIT_COLUMNS literal out of this file's TEXT, and checks
// each (table, column) against prod; promote-gate.yml runs it with --gate. This vitest file keeps the list
// honest in both directions: every declared column is read, and every `spaces` column read is declared.
//
// DO NOT EDIT THE SPACE READ'S SQL TEXT to suit this file: AC-7 (tests/integration/space-photos.int.test.js)
// matches it exactly and the daily-plan mock-pg tests stub on /from spaces/.
//
// MUTATION LOG — 2026-10-16, lane t3-ms1-c2. Each applied alone, this file run, RED observed, file restored:
//   * the Space read selects a new `name` (the column-add mutant)       -> 2 RED
//   * contract drops `created_by` / declares an unread `name`           -> 2 RED each
//   * the plantings join reads a new `sp.name`                          -> 1 RED (the aliased arm is load-bearing)
// 2026-10-20, lane 3.2b (the plots key), same procedure:
//   * the plot_id stamp reads a new `pl.name`                           -> 1 RED
//   * contract drops `deleted_at`                                       -> 1 RED
//   * the stamp loses its alias (`from plots where …`)                  -> 1 RED
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownContract } from '../_test-stubs/columnContract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// L-081 KEYED contract: the columns of the per-run Space read, which are also a superset of the plantings
// join's (`sp.id`, `sp.created_by`). `plots`: the columns of the weather_daily plot_id stamp.
const AUDIT_COLUMNS = {
  spaces: ['id', 'postal_code', 'weather_lat', 'weather_lng', 'created_by'],
  plots: ['id', 'workspace_id', 'is_default', 'deleted_at'],
};

// JS `//` comments first, then SQL `--` comments (same rules as locations-columns.test.js).
const jsDecomment = (s) => s.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const sqlDecomment = (s) => s.split('\n').map((l) => l.replace(/(^|\s)--(\s.*)?$/, '$1')).join('\n');

// The `.query(` templates in the Lambda's non-test sources, in all three quote styles, without the
// `.query(` prefix and the closing quote.
function sourceStatements() {
  const files = readdirSync(__dirname).filter((f) => /\.js$/.test(f) && !/\.test\.js$/.test(f));
  return files.flatMap((f) => {
    const s = jsDecomment(readFileSync(join(__dirname, f), 'utf8'));
    return [
      ...(s.match(/\.query\(\s*`[^`]*`/g) ?? []),
      ...(s.match(/\.query\(\s*'[^']*'/g) ?? []),
      ...(s.match(/\.query\(\s*"[^"]*"/g) ?? []),
    ].map((q) => [f, q.replace(/^\.query\(\s*./, '').slice(0, -1)]);
  });
}

// A `spaces` relation reference and its alias.
const SPACES_REF = /\b(?:from|join)\s+(?:public\.)?spaces\b(?:\s+(?:as\s+)?(?!(?:on|where|left|right|inner|join|using|cross|full|natural|group|order|limit|union)\b)([a-z_][a-z0-9_]*))?/gi;
// An unaliased reference is attributable only when the statement is a bare one-relation select of plain
// column names, which is the shape of the per-run Space read.
const BARE_SELECT = /^\s*select\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)\s+from\s+(?:public\.)?spaces\s*$/i;

function spacesReads(stmt) {
  const s = sqlDecomment(stmt);
  const cols = new Set();
  const unattributed = [];
  const refs = [...s.matchAll(SPACES_REF)];
  for (const m of refs) {
    if (m[1]) {
      for (const c of s.matchAll(new RegExp(`\\b${m[1]}\\.([a-z_][a-z0-9_]*)\\b`, 'gi'))) cols.add(c[1].toLowerCase());
      continue;
    }
    const bare = s.match(BARE_SELECT);
    if (!bare) { unattributed.push(s.trim().slice(0, 120)); continue; }
    for (const c of bare[1].split(',')) cols.add(c.trim().toLowerCase());
  }
  return { refs: refs.length, cols, unattributed };
}

// A `plots` relation reference. Alias required: the stamp is a subquery inside an INSERT, so no bare form
// is attributable.
const PLOTS_REF = /\b(?:from|join)\s+(?:public\.)?plots\b(?:\s+(?:as\s+)?(?!(?:on|where|left|right|inner|join|using|cross|full|natural|group|order|limit|union)\b)([a-z_][a-z0-9_]*))?/gi;

function plotsReads(stmt) {
  const s = sqlDecomment(stmt);
  const cols = new Set();
  const unattributed = [];
  const refs = [...s.matchAll(PLOTS_REF)];
  for (const m of refs) {
    if (!m[1]) { unattributed.push(s.trim().slice(0, 120)); continue; }
    for (const c of s.matchAll(new RegExp(`\\b${m[1]}\\.([a-z_][a-z0-9_]*)\\b`, 'gi'))) cols.add(c[1].toLowerCase());
  }
  return { refs: refs.length, cols, unattributed };
}

describe('BUG-SPACESREADUNSCOPED-001 — daily-plan `spaces` column contract (L-081 Phase 1)', () => {
  it('declares exactly the spaces columns the daily-plan SQL reads — no more, no fewer', () => {
    const read = new Set();
    let bearing = 0;
    for (const [file, stmt] of sourceStatements()) {
      const r = spacesReads(stmt);
      expect(r.unattributed, `${file}: a spaces reference this guard cannot attribute — extend it`).toEqual([]);
      if (r.refs) bearing++;
      for (const c of r.cols) read.add(c);
    }
    // non-vacuity: the plantings query (join spaces sp) and the per-run Space read (from spaces)
    expect(bearing).toBeGreaterThanOrEqual(2);
    expect([...read].sort()).toEqual([...AUDIT_COLUMNS.spaces].sort());
  });

  it('reads the per-run Space read itself, so the exact set is not carried by the join alone', () => {
    const bare = sourceStatements().map(([, s]) => sqlDecomment(s)).filter((s) => BARE_SELECT.test(s));
    expect(bare).toHaveLength(1);
    expect(bare[0].match(BARE_SELECT)[1].split(',').map((c) => c.trim())).toEqual(AUDIT_COLUMNS.spaces);
  });

  it('declares exactly the plots columns the daily-plan SQL reads (V5-SPACEPLOTTIER-001)', () => {
    const read = new Set();
    let bearing = 0;
    for (const [file, stmt] of sourceStatements()) {
      const r = plotsReads(stmt);
      expect(r.unattributed, `${file}: an unaliased plots reference this guard cannot attribute — alias it`).toEqual([]);
      if (r.refs) bearing++;
      for (const c of r.cols) read.add(c);
    }
    // non-vacuity: the weather_daily upsert's plot_id stamp
    expect(bearing).toBeGreaterThanOrEqual(1);
    expect([...read].sort()).toEqual([...AUDIT_COLUMNS.plots].sort());
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py parses, under its Phase 1 glob', () => {
    // The auditor reads TEXT: replicate its own regexes against this file. The closing `};` is load-bearing.
    const parsed = ownContract(import.meta.url);
    expect(parsed).not.toBeNull();
    expect(parsed.map(([key]) => key)).toEqual(['spaces', 'plots']);
    expect(parsed[0][1]).toEqual(AUDIT_COLUMNS.spaces);
    expect(parsed[1][1]).toEqual(AUDIT_COLUMNS.plots);
    const audit = readFileSync(join(__dirname, '..', '..', 'scripts', 'dev-main-schema-audit.py'), 'utf8');
    const glob = audit.match(/^PHASE1_GLOB\s*=\s*"([^"]+)"/m)[1];
    expect(new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(basename(fileURLToPath(import.meta.url)))).toBe(true);
  });
});
