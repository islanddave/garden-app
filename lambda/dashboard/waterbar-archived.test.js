// BUG-WATERBARARCHIVED-001 — the water bar's DISPLAYED `plantings` array is a THIRD copy of the
// lifecycle predicate, and it was the one copy nothing pinned.
//
// WHAT THIS FILE IS NOT. The rollup half of this ticket is already closed: BUG-ROLLUPLIFECYCLE-001
// (dev 201bdbe, 2026-08-10, shipped in prod v4.13.0) put the full actionability predicate on the
// plant arm of all five actionable rollups, INCLUDING queryWaterDueFromPlan's legacy_rows MIN and
// queryWaterDue's. rollup-lifecycle.test.js pins that, and re-pinning it here would be duplication.
// Verified against live prod on 2026-08-13 at that fix: the pre-fix predicate made 4 of Dave's 24
// legacy-due containers phantom-due (Peppers, Lettuce, Geranium, Strawberries — Peppers driven by
// ten archived `failed` pepper plantings, honest verdict 2026-08-16 vs the claimed 2026-06-21);
// the shipped predicate selects none of them.
//
// WHAT THIS FILE IS. Those queries carry the same lifecycle predicate in up to FOUR places:
//   1. the entity_memory rollup arm      (`m.plant_id IN (SELECT gp.id FROM public.garden_node gp …)`)
//   2. the EXISTS eligibility guard      (`EXISTS (SELECT 1 FROM public.garden_node gn …)`)
//   3. the DISPLAYED `plantings` array   (`json_agg(…) … AS plantings`)   <-- unpinned until now
//   4. queryHeadsUp's per-event filter   (`gn.id = el.plant_id …`)
// rollup-lifecycle.test.js compares (1) against (2) and stops there. Measured hole, 2026-08-13:
// deleting `gn.archived_at IS NULL` AND dropping 'rooting' from copy (3) of legacy_rows left all
// 170 lambda/dashboard tests GREEN. That is the exact contradiction this ticket names — a container
// alerting "water me" over a planting the row itself does not display — reachable from the other
// direction, and nothing caught it.
//
// THE INVARIANT: within one ACTIONABLE query, every public.garden_node lifecycle predicate must
// describe the SAME population. Not "contains archived_at" (a snapshot of today's literal) but
// mutual agreement, so widening or narrowing the population stays legal as long as it is done
// everywhere at once. Deliberately alias-agnostic and site-count-agnostic: a future 5th copy is
// picked up automatically rather than needing this file edited to cover it.
//
// Behavioral (mock-sql), matching the house harness in rollup-lifecycle.test.js /
// care-rekey-reads.test.js: these are pure builders, so the real emitted SQL is observable. This
// proves the handler's SQL TEXT, never DB behavior — no row is read here.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  queryWaterDue,
  queryWaterDueFromPlan,
  queryHarvestReady,
  queryHeadsUp,
  queryActiveProjects,
  queryInactiveList,
} from './handlers.js';

const sqlCalls = [];
function makeSql() {
  return function sqlTag(strings, ...values) {
    let resolved = '';
    strings.forEach((s, i) => {
      resolved += s;
      if (i < values.length) resolved += `$${i + 1}`;
    });
    sqlCalls.push({ resolved });
    return Promise.resolve([]);
  };
}
// Comments stripped before matching — handlers.js documents this very rule in `--` comments, and
// without this an assertion could pass on a comment that merely MENTIONS archived_at while the live
// predicate omits it. That is the vacuity trap for a source-text test.
const uncommented = (s) => s.replace(/--[^\n]*/g, '');
const emit = (fn) => { fn(makeSql(), 'user_alpha'); return uncommented(sqlCalls[0].resolved); };

beforeEach(() => { sqlCalls.length = 0; });

// Every `public.garden_node <alias>` site in one emitted query, reduced to the population its
// lifecycle predicate describes. Each site's window ends where the next one begins, so a site can
// never borrow its neighbour's tokens and read as filtered when it is not.
function nodeSites(q) {
  const starts = [];
  const re = /public\.garden_node\s+(\w+)/g;
  let m;
  while ((m = re.exec(q)) !== null) starts.push({ alias: m[1], at: m.index });
  return starts.map(({ alias, at }, i) => {
    const seg = q.slice(at, i + 1 < starts.length ? starts[i + 1].at : q.length);
    const st = new RegExp(`\\b${alias}\\.status NOT IN \\(([^)]*)\\)`).exec(seg);
    return {
      alias,
      deleted: new RegExp(`\\b${alias}\\.deleted_at IS NULL`).test(seg),
      archived: new RegExp(`\\b${alias}\\.archived_at IS NULL`).test(seg),
      statuses: st ? st[1].replace(/[\s']/g, '').split(',').sort().join(',') : null,
      // A site's window opens at `public.garden_node <alias>`, so the `json_agg(` that heads a
      // displayed array is BEHIND it — the array is identified by the closing shape that follows.
      displayed: /\)\s*,\s*'\[\]'::json\)\s*AS plantings/.test(seg),
    };
  });
}

const population = (s) => ({ deleted: s.deleted, archived: s.archived, statuses: s.statuses });
const NON_LIVE = 'dormant,ended,failed,rooting';

// ACTIONABLE — the value crosses a threshold, decides eligibility, or ranks a list. Same membership
// rollup-lifecycle.test.js uses; queryActiveProjects / queryInactiveList are HISTORY and are
// asserted (below) to be deliberately absent from this rule rather than silently skipped by it.
const ACTIONABLE = [
  ['queryWaterDue', queryWaterDue],
  ['queryWaterDueFromPlan', queryWaterDueFromPlan],
  ['queryHarvestReady', queryHarvestReady],
  ['queryHeadsUp', queryHeadsUp],
];

describe('BUG-WATERBARARCHIVED-001 — every garden_node predicate in an actionable query agrees', () => {
  // THE PIN. MUTATION: drop `gn.archived_at IS NULL`, or remove 'rooting', from the displayed
  // `plantings` array of queryWaterDue / legacy_rows / queryHeadsUp -> RED. That mutation was GREEN
  // across all 170 dashboard tests before this file existed.
  it.each(ACTIONABLE)('%s — all garden_node sites describe one population', (_n, fn) => {
    const sites = nodeSites(emit(fn));
    expect(sites.length).toBeGreaterThan(0);
    const [first, ...rest] = sites;
    for (const s of rest) {
      expect(population(s), `site "${s.alias}" diverges from site "${first.alias}"`)
        .toEqual(population(first));
    }
  });

  // Anti-vacuity. The parity assertion above passes trivially on a query with ONE site, so the
  // multi-copy queries must be known to still HAVE their copies — otherwise a refactor that deleted
  // the displayed array would turn the pin green by removing the thing it guards.
  it.each([
    ['queryWaterDue', queryWaterDue, 3],
    ['queryWaterDueFromPlan', queryWaterDueFromPlan, 4],
    ['queryHeadsUp', queryHeadsUp, 4],
  ])('%s still carries all %#-indexed duplicate predicate copies', (_n, fn, expected) => {
    expect(nodeSites(emit(fn)).length).toBe(expected);
  });

  // The displayed array is the copy this ticket is about: the row must not name a population
  // different from the one its verdict was computed over. Asserted by ROLE, not by position.
  it.each([
    ['queryWaterDue', queryWaterDue],
    ['queryWaterDueFromPlan', queryWaterDueFromPlan],
    ['queryHeadsUp', queryHeadsUp],
  ])('%s — the displayed plantings array is live-only and matches the rollup', (_n, fn) => {
    const sites = nodeSites(emit(fn));
    const shown = sites.filter((s) => s.displayed);
    expect(shown.length, 'the displayed plantings array must still exist').toBeGreaterThan(0);
    for (const s of shown) {
      expect(s.deleted).toBe(true);
      expect(s.archived).toBe(true);
      expect(s.statuses).toBe(NON_LIVE);
    }
  });
});

describe('BUG-WATERBARARCHIVED-001 — the water bar specifically', () => {
  // An archived / dormant / ended / failed / rooting planting's stale entity_memory row must not
  // reach the MIN that decides the container's verdict, on EITHER water path. The legacy_rows arm is
  // the one this ticket names; queryWaterDue is the same defect in the pre-DRG-WATERRECON reader,
  // still exported and still the shape legacy_rows mirrors.
  it.each([['queryWaterDue', queryWaterDue], ['queryWaterDueFromPlan', queryWaterDueFromPlan]])(
    '%s — no rollup arm can be driven by a non-live planting', (_n, fn) => {
      const arms = nodeSites(emit(fn)).filter((s) => s.alias === 'gp');
      expect(arms.length).toBeGreaterThan(0);
      for (const a of arms) {
        expect(a.archived).toBe(true);
        expect(a.statuses).toBe(NON_LIVE);
      }
    });

  // NO OVER-CORRECTION. A live planting must still be able to raise the alert. Suppressing real
  // watering is worse than the phantom this ticket fixes, and the tempting over-fix — filtering the
  // rollup down to some narrower "currently growing" set, or dropping the project arm — would do
  // exactly that. NULL status stays actionable (fail-open toward alerting, V3-ATTN-002), and the
  // project arm (`m.project_id = pp.id`) stays: 55 live prod events carry no plant_id at all, and 7
  // containers have a project entity_memory row with no plant rows under them.
  it.each([['queryWaterDue', queryWaterDue], ['queryWaterDueFromPlan', queryWaterDueFromPlan]])(
    '%s — live and NULL-status plantings still reach the rollup, project arm intact', (_n, fn) => {
      const q = emit(fn);
      expect(q).toContain('m.project_id = pp.id');
      for (const a of nodeSites(q).filter((s) => s.alias === 'gp')) {
        // An exclusion list, never an inclusion list: a whitelist of "growing" statuses would drop
        // every future status the moment it is added, silently stopping real alerts.
        expect(a.statuses).toBe(NON_LIVE);
      }
      expect(q).toMatch(/gp\.status IS NULL OR gp\.status NOT IN/);
    });

  // FALLBACK GATING UNCHANGED. legacy_rows may fire ONLY when the plan is absent or shape-drifted;
  // plan_rows only when it is trusted. Verified on live prod 2026-08-13: both users had a
  // schema_version=1 plan row for today, so this arm was not firing at all — the defect this ticket
  // names is latent, reachable only on an engine-skip day. A mutation that let both arms through
  // would double every row.
  it('queryWaterDueFromPlan keeps plan_rows / legacy_rows mutually exclusive', () => {
    const q = emit(queryWaterDueFromPlan).replace(/\s+/g, ' ');
    expect(q).toContain("SELECT * FROM plan_rows WHERE (SELECT ok FROM compat)");
    expect(q).toContain("SELECT * FROM legacy_rows WHERE NOT (SELECT ok FROM compat)");
  });
});

describe('BUG-WATERBARARCHIVED-001 — history queries are exempt by design, not by omission', () => {
  // Guards the other direction. If a future edit "tidied" the history rollups to match, this ticket
  // would have erased real garden history — a bed that produced a full spring crop would read as
  // never used. Stated here so the parity rule above is never read as universal.
  it.each([['queryActiveProjects', queryActiveProjects], ['queryInactiveList', queryInactiveList]])(
    '%s keeps archived plantings in its rollup', (_n, fn) => {
      const arms = nodeSites(emit(fn)).filter((s) => s.alias === 'gp');
      expect(arms.length).toBeGreaterThan(0);
      for (const a of arms) {
        expect(a.archived).toBe(false);
        expect(a.deleted).toBe(true);  // soft-delete is a retraction, excluded from history too
      }
    });
});
