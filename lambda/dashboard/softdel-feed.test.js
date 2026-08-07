// V4-SOFTDEL-001 F3 — queryRecentEvents (the Dashboard Log feed).
//
// This builder was the outlier in handlers.js: queryWaterDue, queryWaterDueFromPlan, queryHeadsUp
// and searchEvents all already filtered pp.deleted_at, and the feed did not — so an undone
// container kept its events on the Log, with the deleted container's display_name still resolving
// through the same JOIN and the unfiltered `LEFT JOIN public.garden_node gn` still rendering the
// deleted PLANTING's name beside them.
//
// Behavioral (mock-sql), not static: queryRecentEvents is a pure builder, so the real SQL text and
// the real bound params are observable here. Mirrors index.test.js's makeSql harness.
//
// Every assertion is mutation-verified — the named source mutation was applied, RED observed, and
// handlers.js restored byte-identically (shasum-checked).

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryRecentEvents, HIDE_EVENTS_UNDER_DELETED_PLANTING } from './handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'handlers.js'), 'utf8');

const sqlCalls = [];
function makeSql() {
  return function sqlTag(strings, ...values) {
    let resolved = '';
    strings.forEach((s, i) => {
      resolved += s;
      if (i < values.length) resolved += `$${i + 1}`;
    });
    sqlCalls.push({ strings: Array.from(strings), values, resolved });
    return Promise.resolve([]);
  };
}
// A predicate living only inside a `--` comment is not a predicate.
const uncommented = (s) => s.replace(/--[^\n]*/g, '');

beforeEach(() => { sqlCalls.length = 0; });

describe('queryRecentEvents — F3 container soft-delete filter', () => {
  // MUTATION: delete `AND pp.deleted_at IS NULL` from queryRecentEvents' WHERE -> RED.
  it('excludes events whose container is soft-deleted', async () => {
    await queryRecentEvents(makeSql(), 'user_alpha');
    expect(uncommented(sqlCalls[0].resolved)).toMatch(/AND pp\.deleted_at IS NULL/);
  });

  // MUTATION: delete the same line -> RED. Guards the actual regression shape: the feed used to
  // filter archived_at ONLY, which reads as "we thought about container state here" and is exactly
  // why the missing sibling went unnoticed.
  it('filters deleted AND archived containers — archived_at alone was the bug', async () => {
    await queryRecentEvents(makeSql(), 'user_alpha');
    const q = uncommented(sqlCalls[0].resolved);
    expect(q).toMatch(/AND pp\.archived_at IS NULL/);
    expect(q).toMatch(/AND pp\.deleted_at IS NULL/);
  });

  // MUTATION: remove `AND pp.deleted_at IS NULL` from queryHeadsUp's flagged CTE -> RED here. The
  // whole F3 argument is that the feed was inconsistent with its own file, so that claim is
  // asserted rather than asserted-in-prose.
  //
  // FLOOR LOWERED 5 -> 3 BY V4-CAREKEY-001, AND THE LOST COVERAGE MOVED TO THE TEST BELOW, NOT
  // DROPPED. Two of the original five were never event queries: the alias pattern `e[a-z]*` also
  // matches `em`, so queryWaterDue and queryWaterDueFromPlan's legacy_rows were caught by their
  // `JOIN public.container pp ON pp.id = em.project_id` — an ENTITY_MEMORY join. The care re-key
  // turned both into `FROM public.container pp` + a plant-keyed rollup, so they stopped matching a
  // regex that was only ever meant to describe event queries. Both still filter pp.deleted_at.
  // Relaxing the count on its own would have let the protection shrink 5 -> 3 silently, so the
  // container-mention test below now supersets this one and cannot shrink under a re-key.
  it('every container-joined event query in handlers.js filters pp.deleted_at', () => {
    const re = /(?<![\w`])sql`([^`]*)`/g;
    const joined = [];
    let m;
    while ((m = re.exec(SRC)) !== null) {
      if (/JOIN\s+public\.container\s+pp\s+ON\s+pp\.id\s*=\s*e[a-z]*\.project_id/.test(m[1])) joined.push(m[1]);
    }
    expect(joined.length).toBeGreaterThanOrEqual(3);
    const unfiltered = joined.map(uncommented)
      .filter(b => !/\bpp\.deleted_at IS NULL\b/.test(b))
      .map(b => b.replace(/\s+/g, ' ').slice(0, 120));
    expect(unfiltered).toEqual([]);
  });
});

// V4-CAREKEY-001 — the guard that survives a re-key.
//
// The test above is keyed on a JOIN SHAPE, which is exactly the thing a re-key rewrites; it lost two
// members the moment two container joins became `FROM public.container pp`. These two are keyed on
// what actually has to stay true — "this query can reach a container / a planting" — which no
// re-keying of entity_memory can reduce.
describe('BUG-SOFTDELREAD-001 — soft-delete filtering survives the care re-key', () => {
  const templates = () => {
    const re = /(?<![\w`])sql`([^`]*)`/g;
    const out = [];
    let m;
    while ((m = re.exec(SRC)) !== null) out.push(m[1]);
    return out;
  };
  const oneLine = (b) => b.replace(/\s+/g, ' ').trim().slice(0, 140);

  // NO ALLOWLIST. There was one: queryCounts' plant_count subquery filtered pp.archived_at but not
  // pp.deleted_at — the exact "archived_at alone was the bug" shape this file exists to kill, in the
  // one place the F3 sweep missed. Pre-existing, and latent (measured 0 on live prod 2026-08-07: no
  // live unarchived planting sat under a soft-deleted-but-unarchived container). It is now fixed, so
  // the assertion runs with zero exceptions and any future violation — there or anywhere else — is
  // caught immediately rather than hiding behind a named gap.

  // MUTATION: delete `AND pp.deleted_at IS NULL` from queryWaterDue's WHERE -> RED (that query is a
  // member here via `FROM public.container pp`, and is NOT a member of the join-shape test above).
  // Same for queryCounts' plant_count subquery.
  it('every query that reaches a container filters pp.deleted_at', () => {
    const reaching = templates().filter(t => /public\.container\s+pp\b/.test(uncommented(t)));
    expect(reaching.length).toBeGreaterThanOrEqual(12);
    const unfiltered = reaching
      .map(uncommented)
      .filter(t => !/\bpp\.deleted_at IS NULL\b/.test(t))
      .map(oneLine);
    expect(unfiltered).toEqual([]);
  });

  // MUTATION: delete `AND gp.deleted_at IS NULL` from queryActiveProjects' care rollup -> RED. The
  // re-key introduced a NEW way to reach a planting — the rollup's `plant_id IN (SELECT gp.id FROM
  // public.garden_node gp ...)` — and a soft-deleted planting's care recency must not roll up into
  // its container's tiles. Nothing guarded this before, because before the re-key it did not exist.
  it('every care rollup that reaches a planting filters gp.deleted_at', () => {
    const rollups = templates().filter(t => /public\.garden_node\s+gp\b/.test(uncommented(t)));
    expect(rollups.length).toBeGreaterThanOrEqual(6);
    const unfiltered = rollups.map(uncommented)
      .filter(t => !/\bgp\.deleted_at IS NULL\b/.test(t))
      .map(oneLine);
    expect(unfiltered).toEqual([]);
  });
});

describe('queryRecentEvents — F3 deleted-PLANTING policy switch', () => {
  // MUTATION: flip the constant to `true` in handlers.js -> RED. The shipped value is the
  // no-product-change one; the 56 prod events under a soft-deleted planting stay on the feed.
  it('ships DISABLED — a deleted planting whose container lives keeps its events', () => {
    expect(HIDE_EVENTS_UNDER_DELETED_PLANTING).toBe(false);
  });

  // MUTATION: flip the constant to `true` -> RED (the bound value becomes true). This is the
  // assertion that the switch is really WIRED to the query rather than being a decorative export:
  // the constant's value is observable in the query's own bound params.
  it('binds the switch as a real query parameter, so flipping the constant changes the SQL', async () => {
    await queryRecentEvents(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain(false);
    expect(uncommented(sqlCalls[0].resolved))
      .toMatch(/AND \(\$\d+::boolean IS NOT TRUE\s*\n?\s*OR e\.plant_id IS NULL OR gn\.deleted_at IS NULL\)/);
  });

  // MUTATION: change `gn.deleted_at IS NULL` to `gn.id IS NOT NULL` -> RED. The enabled arm has
  // to test the planting's SOFT-DELETE, not merely that a planting row joined.
  it('the enabled arm tests the planting’s own deleted_at (via the existing LEFT JOIN gn)', async () => {
    await queryRecentEvents(makeSql(), 'user_alpha');
    const q = uncommented(sqlCalls[0].resolved);
    expect(q).toMatch(/LEFT JOIN public\.garden_node gn ON gn\.id = e\.plant_id/);
    expect(q).toMatch(/gn\.deleted_at IS NULL/);
  });
});
