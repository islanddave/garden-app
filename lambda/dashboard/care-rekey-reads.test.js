// V4-CAREKEY-001 Step D — the entity_memory READ cutover (design V100 §3-D, blast-radius item B2).
//
// entity_memory is now keyed on the planting. Every project-level display in handlers.js reads the
// CONTAINER CARE ROLLUP instead of a single container-keyed row:
//
//     the container's care recency = newest of { its plantings' rows } UNION { its own row }
//
// Behavioral (mock-sql), not static: these are pure builders, so the real emitted SQL is observable.
// Same makeSql harness as index.test.js / softdel-feed.test.js.
//
// Every assertion below names the source mutation that turns it RED. Each was applied to the real
// source, RED observed, then the file restored byte-identically (shasum-verified) — see the
// V4-CAREKEY-001 report.
//
// WHY BOTH ARMS ARE ASSERTED, not just the plant arm. Measured on live prod 2026-08-07:
//   * plant arm   — 262 rows. Drop it and every tile loses the per-planting truth the re-key exists
//                   to expose (51 of 252 plantings were being shown a SIBLING's last_watered_at).
//   * project arm — 76 rows. Drop it and 7 containers whose only entity_memory row is their own
//                   vanish from the dashboard, and the 55 live project-LEVEL events that carry no
//                   plant_id (11 waterings, 14 observations, 13 photos) stop counting as activity.
// A rollup that reads only one arm is a regression whichever arm it picks, so both are pinned.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  queryActiveProjects,
  queryWaterDue,
  queryWaterDueFromPlan,
  queryHarvestReady,
  queryHeadsUp,
  queryInactiveList,
} from './handlers.js';

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
const uncommented = (s) => s.replace(/--[^\n]*/g, '');
const emit = (fn) => { fn(makeSql(), 'user_alpha'); return uncommented(sqlCalls[0].resolved); };

beforeEach(() => { sqlCalls.length = 0; });

// The six project-level readers the cutover covers. queryWaterDue is included even though
// handleDashboard no longer calls it (queryWaterDueFromPlan replaced it at DRG-WATERRECON-001): it
// is still exported, still the reference shape legacy_rows mirrors, and leaving it project-keyed
// would leave a live re-entry point into the coarse cache.
const READERS = [
  ['queryActiveProjects', queryActiveProjects],
  ['queryWaterDue', queryWaterDue],
  ['queryWaterDueFromPlan', queryWaterDueFromPlan],
  ['queryHarvestReady', queryHarvestReady],
  ['queryHeadsUp', queryHeadsUp],
  ['queryInactiveList', queryInactiveList],
];

describe('Step D — project-level reads roll up plant-keyed entity_memory', () => {
  // MUTATION (per reader): in that reader's rollup, delete the
  // `OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp ...)` arm -> RED for that reader.
  // This is THE re-key assertion: without the plant arm the reader is still reading only the coarse
  // container-keyed cache and nothing has actually been re-keyed.
  it.each(READERS)('%s reads the plant arm', (_name, fn) => {
    const q = emit(fn);
    expect(q).toMatch(/m\.plant_id IN \(\s*SELECT gp\.id FROM public\.garden_node gp/);
  });

  // MUTATION (per reader): delete `m.project_id = pp.id` from that reader's rollup predicate -> RED.
  // Guards the OTHER direction of the same mistake — a "cutover" that drops project-level events and
  // the 7 childless containers on the floor.
  it.each(READERS)('%s keeps the project arm', (_name, fn) => {
    const q = emit(fn);
    expect(q).toMatch(/WHERE m\.project_id = pp\.id/);
  });

  // MUTATION: change any surviving `entity_memory em ON em.project_id` back into a direct join, e.g.
  // restore `LEFT JOIN entity_memory em ON em.project_id = pp.id` in queryHarvestReady -> RED.
  // The rollup is the ONLY sanctioned way to read entity_memory for a container; a direct
  // container-keyed join anywhere in this file is the pre-re-key shape sneaking back.
  it('no reader joins entity_memory directly on a container id', () => {
    const re = /(?<![\w`])sql`([^`]*)`/g;
    const offenders = [];
    let m;
    while ((m = re.exec(SRC)) !== null) {
      const body = uncommented(m[1]);
      if (/JOIN\s+entity_memory\s+em\s+ON\s+em\.project_id/.test(body)) {
        offenders.push(body.replace(/\s+/g, ' ').trim().slice(0, 120));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Step D — next_water_at is reconstituted at read time, never from a plant row', () => {
  // MUTATION: in queryWaterDue's rollup, drop the COALESCE and select `MIN(m.next_water_at)` -> RED.
  // Plant-keyed rows carry next_water_at NULL BY CONSTRUCTION (0b-backfill.sql and the Step-B upsert
  // both omit it — design §8.1: the engine owns "due", the cache owns "when"). Live prod: 0 of 262
  // plant rows have it set. So a rollup that reads the column raw returns the project fiction or
  // nothing at all, and the bar silently stops firing for every re-keyed container.
  it.each([['queryWaterDue', queryWaterDue], ['queryWaterDueFromPlan', queryWaterDueFromPlan]])(
    '%s derives next_water_at from last_watered_at + the interval ladder',
    (_name, fn) => {
      const q = emit(fn);
      expect(q).toMatch(/COALESCE\(m\.next_water_at,[\s\S]*?m\.last_watered_at/);
      expect(q).toMatch(/COALESCE\(m\.watering_interval_days, 4\)/);
    },
  );

  // MUTATION: change `MIN(COALESCE(m.next_water_at,` to `MAX(COALESCE(m.next_water_at,` in
  // queryWaterDue -> RED. MIN vs MAX is the whole point of the grain change: the container is due
  // when its MOST overdue planting is due. Under MAX, one overdue planting inside the 66-planting
  // container is masked by its 65 well-watered siblings — the exact conflation the re-key removes,
  // reintroduced by a one-word edit.
  it.each([['queryWaterDue', queryWaterDue], ['queryWaterDueFromPlan', queryWaterDueFromPlan]])(
    '%s takes the MIN across the rollup so the most-overdue planting decides',
    (_name, fn) => {
      const q = emit(fn);
      expect(q).toMatch(/MIN\(COALESCE\(m\.next_water_at,/);
      expect(q).not.toMatch(/MAX\(COALESCE\(m\.next_water_at,/);
    },
  );
});

describe('Step D — V4-PROJHIDE-001 unblock: the water_due row carries its own subject', () => {
  // MUTATION: delete the `CASE WHEN count(*) = 1 THEN MIN(d.name) END AS plant_name` line from the
  // grouped CTE -> RED. Dashboard.jsx's PROJECTS_HIDDEN branch already renders w.plant_name and the
  // server has never emitted it, so every row in that branch falls back to the literal "Water due".
  it('queryWaterDueFromPlan emits plant_name for single-planting groups', () => {
    const q = emit(queryWaterDueFromPlan);
    expect(q).toMatch(/CASE WHEN count\(\*\) = 1 THEN MIN\(d\.name\) END AS plant_name/);
  });

  // MUTATION: delete `NULL::text AS plant_name` from legacy_rows -> RED (Postgres would reject the
  // UNION ALL at runtime, which no mock-sql test can see; this is the static stand-in). The two
  // branches are combined with `SELECT * FROM plan_rows UNION ALL SELECT * FROM legacy_rows`, so a
  // column added to one branch and not the other is a 500 on the fallback path only — i.e. it fails
  // exactly when the engine has already skipped and the bar is the last thing still working.
  it('both water_due branches project plant_name in the same position', () => {
    const q = emit(queryWaterDueFromPlan);
    const planCols = q.match(/g\.plantings, g\.plant_name, 'plan'::text AS water_due_source/);
    const legacyCols = q.match(/NULL::text AS plant_name,\s*\n?\s*CASE WHEN \(SELECT present FROM plan_present\)/);
    expect(planCols, 'plan_rows must project plant_name after plantings').not.toBeNull();
    expect(legacyCols, 'legacy_rows must project plant_name in the same slot').not.toBeNull();
  });

  // MUTATION: delete the B5 comment block above the wd CTE's WHERE -> RED. Not decoration: B5 is a
  // KNOWN OPEN GAP (a projectless planting is dropped from the bar by that predicate) that is inert
  // only while 0 projectless plantings exist, and PROJHIDE is what makes them exist. The marker is
  // the handoff to whoever lands PROJHIDE; losing it loses the finding.
  it('the B5 projectless-planting gap is still marked in source', () => {
    expect(SRC).toMatch(/CARE RE-KEY B5 — KNOWN GAP, DELIBERATELY LEFT OPEN AT STEP D/);
  });
});
