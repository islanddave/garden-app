import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// BUG-LOGMANYSTATUS-001 — every SQL predicate in the fleet that excludes plantings BY STATUS must
// use one of the vocabularies registered below, and no other.
//
// The bug this guard exists to prevent has now happened twice in two days, both times in the same
// shape: a query that resolves a set of plantings filters deleted_at / archived_at / ownership and
// then invents its own status rule, or none. Round one left every `dormant` planting in Log Many's
// bulk scope; round two left `ended` and `failed` there, and 32 phantom care events landed on
// plantings Dave had already closed out before it was caught. Both were invisible to a green suite
// because a per-site test only ever asserts what its own site does.
//
// WHY A TEST AND NOT A SHARED CONSTANT. A constant is possible — lambda/plants/anchorCreate.js does
// it, binding `${DEAD_STATUSES}::text[]` through `= ANY(...)`, which neon 0.10.x supports even
// though a bare `NOT IN (${LIST})` would silently become one bound parameter. It just does not buy
// convergence: deploy-lambda.yml zips each function from its own directory (`cd
// lambda/${{matrix.function}}`), so a `../shared` module is not packaged and the constant would
// have to be COPIED into each dir — pinned by exactly this kind of sync test, the shape
// household-copies-sync.test.js and crop-derive-copies-sync.test.js already use. So the sync test
// is the convergence mechanism either way, and rewriting four hot queries from `NOT IN (...)` to
// `= ANY(...)` to reach it would change their text (breaking the source-text guards in
// harvest-ready.test.js and logmany-dormant.test.js) and their plans, for no added safety.
//
// The registry below is deliberately a LIST OF THREE, not one canonical answer. Two of the three
// disagree about `rooting` and that disagreement is intentional; see LIVE vs CARE.

const here = dirname(fileURLToPath(import.meta.url));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(p);
  }
  return out;
}

// Prose names a construct without being it: this file's own siblings discuss
// `NOT IN ('failed','ended','dormant')` at length in comments. Match code only.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

// A status name that can ONLY belong to a planting. `container.status` (project lifecycle) runs
// planning/seeding/sprouting/growing/flowering/fruiting/harvested/ended, so the overlap with
// plants.status is {flowering, fruiting, harvested, ended} and these are the discriminators. Used
// to skip project-status predicates like `pp.status NOT IN ('planning','harvested','ended')` in
// dashboard/handlers.js, which are a different vocabulary on a different table and not in scope.
const PLANTING_ONLY = new Set(['seed', 'seedling', 'rooting', 'vegetative', 'dormant', 'failed', 'dead']);

const key = (arr) => [...new Set(arr)].sort().join(',');

// ── The registry ──────────────────────────────────────────────────────────────────────────────
// LIVE — "alive and owed routine care". The population a care/logging surface acts ON.
//   lambda/events/index.js       Log Many batch scope resolver   (BUG-LOGMANYSTATUS-001)
//   lambda/events/index.js       GET /api/events/harvest-ready
//   lambda/daily-plan/handler.js the daily plan's planting set
//   lambda/harvests/watch-route.js the harvest watch band
//   lambda/plants/anchorCreate.js DEAD_STATUSES, same set via `= ANY(...)`
const LIVE = ['dormant', 'ended', 'failed'];
// CARE — LIVE plus `rooting`. Used ONLY by recommendation surfaces: dashboard/handlers.js
//   (Water Due, Harvest Ready, Heads Up, Give Attention) and findings/index.js.
//   The extra term is why the two lists differ and it is NOT a typo to converge away here: those
//   surfaces RANK and NAG, and a propagation cutting has no cadence worth ranking. Every surface
//   that LOGS or PLANS care keeps `rooting` in, because a cutting striking roots has no root system
//   to buffer a missed watering — live prod's single rooting row took 14 waterings in 90 days.
//   Whether the dashboard is right to hide it from Water Due is a real open question, and a
//   separate one from this file: it is a change to 13 query sites on the nag surfaces.
const CARE = ['dormant', 'ended', 'failed', 'rooting'];
// ANCHOR — the nightly anchor-derivation population (daily-plan/handler.js, the pg.query path).
//   Deliberately NOT LIVE: a dormant garlic still has a planted date worth deriving, so `dormant`
//   is correctly absent. Recorded here rather than converged. Note it also carries two terms that
//   are not in the status vocabulary at all — see the out-of-vocabulary test below.
const ANCHOR = ['archived', 'dead', 'ended', 'failed'];
const REGISTERED = new Map([[key(LIVE), 'LIVE'], [key(CARE), 'CARE'], [key(ANCHOR), 'ANCHOR']]);

// The four in-SQL LIVE sites, alias-normalized. anchorCreate.js is excluded here on purpose: it
// expresses the same SET through a bound array, so it has no matching text and gets its own test.
const LIVE_TEXT = "status NOT IN ('failed', 'ended', 'dormant')";

const FILES = walk(here);

// Both exclusion shapes. The `<>` shape is not hypothetical: it is exactly what the Log Many
// resolver carried between the two bugs (`p.status <> 'dormant'`), and a NOT-IN-only matcher would
// have called that file clean.
const NOT_IN_RE = /(\w+)\.status\s+NOT\s+IN\s*\(([^)]*)\)/gi;
const NEQ_RE = /(\w+)\.status\s*(?:<>|!=)\s*'([a-z_]+)'/gi;

function sites() {
  const found = [];
  for (const path of FILES) {
    const rel = relative(here, path);
    const src = decomment(readFileSync(path, 'utf8'));
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;
    for (const m of src.matchAll(NOT_IN_RE)) {
      const list = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      if (list.some((s) => PLANTING_ONLY.has(s))) {
        found.push({ rel, line: lineOf(m.index), alias: m[1], list, text: m[0] });
      }
    }
    for (const m of src.matchAll(NEQ_RE)) {
      if (PLANTING_ONLY.has(m[2])) {
        found.push({ rel, line: lineOf(m.index), alias: m[1], list: [m[2]], text: m[0] });
      }
    }
  }
  return found;
}

const SITES = sites();

describe('planting-status exclusions use a registered vocabulary', () => {
  it('the scan finds sites at all (vacuity floor)', () => {
    // Without this, a regex that quietly stops matching — a reformat, a line break inside the
    // NOT IN, a rename of `status` — turns this whole file into a green no-op.
    expect(SITES.length).toBeGreaterThanOrEqual(19);
  });

  it('every site matches LIVE, CARE or ANCHOR exactly — no fourth vocabulary', () => {
    const rogue = SITES
      .filter((s) => !REGISTERED.has(key(s.list)))
      .map((s) => `${s.rel}:${s.line}  ${s.text}`);
    // The failure message is the point: a new surface that invents its own list gets told where it
    // is and which three lists it could have used, in the run that introduced it.
    expect(rogue).toEqual([]);
  });

  it('all three vocabularies are actually in use (none is dead registry weight)', () => {
    const used = new Set(SITES.map((s) => REGISTERED.get(key(s.list))));
    expect([...used].sort()).toEqual(['ANCHOR', 'CARE', 'LIVE']);
  });

  it('the LIVE sites are byte-identical after alias normalization', () => {
    // Text identity, not just set identity: it is what makes `git grep` on one of them find the
    // rest, which is how the sweep that produced this file worked.
    const live = SITES.filter((s) => REGISTERED.get(key(s.list)) === 'LIVE');
    expect(live.length).toBe(4);
    for (const s of live) {
      expect(`${s.rel}:${s.line} ${s.text.replace(/^\w+\./, '')}`)
        .toBe(`${s.rel}:${s.line} ${LIVE_TEXT}`);
    }
  });

  it('the Log Many batch resolver is one of the LIVE sites', () => {
    // Named, not merely counted. The whole registry could be internally consistent while the
    // surface this file was written for sat unfiltered.
    const live = SITES.filter((s) => REGISTERED.get(key(s.list)) === 'LIVE').map((s) => s.rel);
    expect(live.filter((r) => r === 'events/index.js')).toHaveLength(2);
    expect(live).toContain('daily-plan/handler.js');
    expect(live).toContain('harvests/watch-route.js');
  });

  it('anchorCreate.js DEAD_STATUSES carries the LIVE set, expressed as a bound array', () => {
    const src = readFileSync(join(here, 'plants', 'anchorCreate.js'), 'utf8');
    const m = src.match(/const DEAD_STATUSES = \[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(key([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]))).toBe(key(LIVE));
  });

  it('LIVE and CARE name only real statuses; ANCHOR is the recorded exception', () => {
    // src/lib/constants.js is the vocabulary of record and the server has no copy of it, so the
    // two lists that gate care are checked against it here. ANCHOR's `dead` and `archived` match
    // nothing in prod (0 rows each, 2026-08-20) and it omits `dormant`; that is a finding parked
    // for its own row, pinned so that fixing it forces this registry to be updated in the same
    // commit rather than drifting silently.
    const CONSTS = readFileSync(join(here, '..', 'src', 'lib', 'constants.js'), 'utf8');
    const vocab = new Set(
      [...CONSTS.match(/export const PLANT_STATUSES = \[([^\]]*)\]/)[1].matchAll(/'([a-z_]+)'/g)]
        .map((x) => x[1]),
    );
    expect(LIVE.filter((s) => !vocab.has(s))).toEqual([]);
    expect(CARE.filter((s) => !vocab.has(s))).toEqual([]);
    expect(ANCHOR.filter((s) => !vocab.has(s))).toEqual(['archived', 'dead']);
  });
});
