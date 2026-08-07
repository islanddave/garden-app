// V4-CAREKEY-001 Step D — projects list `last_activity_at`.
//
// All four /api/projects GET variants (admin, parent_id=null, parent_id=<uuid>, unfiltered) derived
// last_activity_at from a single container-keyed entity_memory row. After the re-key that row no
// longer receives planting activity, so an un-migrated subselect would freeze every project's
// "last activity" at whatever project-LEVEL event last touched it — and 69 of 76 containers have
// no project-level activity at all, so they would report their created_at forever via the COALESCE.
//
// Static-source, matching this directory's existing harness (select-columns.test.js,
// param-typing.test.js): projects/index.js imports @neondatabase/serverless + @clerk/backend, which
// are not resolvable at app level.
//
// Every assertion names the source mutation that turns it RED. Each was applied to the real source,
// RED observed, then index.js restored byte-identically (shasum-verified).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const uncommented = SRC.replace(/--[^\n]*/g, '');

const activityBlocks = uncommented.match(/COALESCE\(\(SELECT[\s\S]*?\) AS last_activity_at/g) ?? [];

describe('Step D — last_activity_at rolls up planting activity', () => {
  // MUTATION: delete any one of the four subselects (or convert one back to the pre-re-key
  // `COALESCE((SELECT em.last_event_at FROM entity_memory em WHERE em.project_id = container.id),
  // created_at)`) -> RED. Four near-identical SQL blocks in one file is precisely the shape where a
  // migration lands in three of them; the count is the guard against that.
  it('all four GET variants carry a last_activity_at rollup', () => {
    expect(activityBlocks).toHaveLength(4);
  });

  // MUTATION: drop the plant arm from any one subselect -> RED. Without it the value is frozen at
  // the last project-LEVEL event, which for 69 of 76 live containers means it never moves again.
  it('every rollup reads the plant arm', () => {
    const missing = activityBlocks.filter(
      (b) => !/em\.plant_id IN \(SELECT gp\.id FROM public\.garden_node gp/.test(b),
    );
    expect(missing).toEqual([]);
  });

  // MUTATION: drop `em.project_id = container.id` from any one subselect -> RED. The other
  // direction: 55 live events carry no plant_id and 7 containers have no plant-keyed row at all, so
  // a plant-only rollup silently backdates them to created_at.
  it('every rollup keeps the project arm', () => {
    const missing = activityBlocks.filter((b) => !/WHERE em\.project_id = container\.id/.test(b));
    expect(missing).toEqual([]);
  });

  // MUTATION: change `SELECT MAX(em.last_event_at)` back to `SELECT em.last_event_at` in any one
  // subselect -> RED. The pre-re-key subselect returned one row because entity_memory had a UNIQUE
  // on project_id; the rollup's predicate matches one project row PLUS one row per planting, so a
  // non-aggregated subselect raises 21000 "more than one row returned by a subquery" — a 500 on the
  // projects list for every container holding a planting with care history. That is most of them.
  it('every rollup aggregates, because the predicate now matches many rows', () => {
    const missing = activityBlocks.filter((b) => !/SELECT MAX\(em\.last_event_at\)/.test(b));
    expect(missing).toEqual([]);
  });

  // MUTATION: delete `AND gp.deleted_at IS NULL` from any one rollup -> RED. A soft-deleted
  // planting's care recency must not keep its container looking active.
  it('every rollup excludes soft-deleted plantings', () => {
    const missing = activityBlocks.filter((b) => !/gp\.deleted_at IS NULL/.test(b));
    expect(missing).toEqual([]);
  });

  // MUTATION: delete `, created_at)` from any one rollup -> RED. A container with no care rows at
  // all must still sort; this COALESCE predates the re-key and must survive it.
  it('every rollup still falls back to created_at', () => {
    const missing = activityBlocks.filter((b) => !/created_at\) AS last_activity_at/.test(b));
    expect(missing).toEqual([]);
  });
});
