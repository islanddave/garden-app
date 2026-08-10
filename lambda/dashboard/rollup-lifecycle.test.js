// BUG-ROLLUPLIFECYCLE-001 — the entity_memory container rollup's plant-arm lifecycle filter.
//
// THE RULE THIS FILE PINS:
//   a rollup whose value crosses a threshold, decides eligibility, or ranks a list must range over
//   the SAME population as the eligibility guard standing next to it. A rollup whose value is only
//   displayed as history may range wider.
//
// Before this ticket every rollup filtered `gp.deleted_at IS NULL` alone, while the `plantings`
// array and the EXISTS guard inside the very same queries filtered
// `deleted_at IS NULL AND archived_at IS NULL AND status NOT IN (...)`. The consequence was not
// cosmetic: the row asserted "water due" and then named no planting that could be its subject.
// Measured on live prod 2026-08-10 (dev d9afab9) — the Peppers container was legacy-water-due SOLELY
// on an archived planting's frozen last_watered_at; honest verdict 2026-08-13. Because an archived
// planting's dates never advance again, that error is monotonic: it recedes further into the past
// every day rather than aging out.
//
// The shape is copy-pasted at 11 call sites across two Lambdas, so the defect is one careless
// duplication away from returning. That is what this file exists to stop — it is a static/behavioral
// parity assertion, not a data assertion, because no SQL gate can express it: a gate that said "no
// container is water-due solely from a non-live planting" becomes wrong-by-construction the moment
// the reader is fixed.
//
// Behavioral (mock-sql), matching the house harness in care-rekey-reads.test.js: these are pure
// builders, so the real emitted SQL is observable.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  queryActiveProjects,
  queryWaterDue,
  queryWaterDueFromPlan,
  queryHarvestReady,
  queryHeadsUp,
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
// Comments are stripped before matching: this file's own rationale lives in `--` comments inside
// handlers.js, and without this an assertion could pass on a comment that merely MENTIONS
// archived_at while the live predicate omits it. That is the vacuity trap for a source-text test.
const uncommented = (s) => s.replace(/--[^\n]*/g, '');
const emit = (fn) => { fn(makeSql(), 'user_alpha'); return uncommented(sqlCalls[0].resolved); };

beforeEach(() => { sqlCalls.length = 0; });

// Every `m.plant_id IN (SELECT gp.id FROM public.garden_node gp WHERE ...)` arm in one emitted query.
// Returns the text of each subquery's WHERE clause, so a reader with several rollups is checked at
// EVERY one of them rather than at whichever happens to match first.
function plantArms(q) {
  const out = [];
  const re = /m\.plant_id IN \(SELECT gp\.id FROM public\.garden_node gp\s+WHERE ([\s\S]*?)\)\s*\n/g;
  let m;
  while ((m = re.exec(q)) !== null) out.push(m[1].replace(/\s+/g, ' ').trim());
  return out;
}

const STATUS_EXCL = "(gp.status IS NULL OR gp.status NOT IN ('dormant','ended','failed','rooting'))";

// ACTIONABLE — the value crosses a threshold, decides eligibility, or ranks a list.
const ACTIONABLE = [
  ['queryWaterDue', queryWaterDue],
  ['queryWaterDueFromPlan', queryWaterDueFromPlan],
  ['queryHarvestReady', queryHarvestReady],
  ['queryHeadsUp', queryHeadsUp],
];
// HISTORY — the value is displayed as a record of what happened. Archiving a planting does not
// un-happen its events, and stripping them here would make a bed that produced a full spring crop
// read as never used.
const HISTORY = [
  ['queryActiveProjects', queryActiveProjects],
  ['queryInactiveList', queryInactiveList],
];

describe('BUG-ROLLUPLIFECYCLE-001 — actionable rollups exclude non-live plantings', () => {
  // MUTATION: delete `AND gp.archived_at IS NULL` from any one actionable rollup -> RED.
  it.each(ACTIONABLE)('%s excludes archived plantings from EVERY plant arm', (_n, fn) => {
    const arms = plantArms(emit(fn));
    expect(arms.length).toBeGreaterThan(0);
    for (const arm of arms) expect(arm).toContain('gp.archived_at IS NULL');
  });

  // MUTATION: delete the status exclusion from any one actionable rollup -> RED.
  // archived_at alone does NOT close the class: a `failed` planting is dead tissue with a frozen
  // date, and `dormant` is the class the daily-plan engine suppresses because interval-watering a
  // dormant succulent rots the crown — this app has already lost a plant that way.
  it.each(ACTIONABLE)('%s excludes non-actionable statuses from EVERY plant arm', (_n, fn) => {
    const arms = plantArms(emit(fn));
    expect(arms.length).toBeGreaterThan(0);
    for (const arm of arms) expect(arm.replace(/\s+/g, ' ')).toContain(STATUS_EXCL);
  });

  // THE COHERENCE ASSERTION, and the reason the other two are not sufficient on their own.
  // It is not enough that the rollup filters SOMETHING; it must filter the same population its own
  // eligibility guard does. If the guard is ever widened or narrowed, this goes RED unless the
  // rollup moves with it — which is the actual invariant, rather than a snapshot of today's literal.
  // MUTATION: change the guard's status list without changing the rollup's -> RED.
  it.each(ACTIONABLE)('%s rollup population == its own eligibility guard population', (_n, fn) => {
    const q = emit(fn);
    const guard = /EXISTS \(\s*SELECT 1 FROM public\.garden_node gn\s+WHERE ([\s\S]*?)\)\s*\n/.exec(q);
    if (!guard) return; // queryHarvestReady gates at container level and has no sibling guard.
    const guardStatuses = /gn\.status NOT IN \(([^)]*)\)/.exec(guard[1]);
    for (const arm of plantArms(q)) {
      const armStatuses = /gp\.status NOT IN \(([^)]*)\)/.exec(arm);
      expect(Boolean(armStatuses)).toBe(Boolean(guardStatuses));
      if (guardStatuses) expect(armStatuses[1].replace(/\s/g, '')).toBe(guardStatuses[1].replace(/\s/g, ''));
      expect(arm.includes('gp.archived_at IS NULL')).toBe(guard[1].includes('gn.archived_at IS NULL'));
    }
  });
});

describe('BUG-ROLLUPLIFECYCLE-001 — history rollups KEEP archived plantings', () => {
  // MUTATION: "tidy up" by adding `AND gp.archived_at IS NULL` here too -> RED.
  // This direction is asserted deliberately. The uniform fix is the tempting one and it is wrong:
  // it would erase real garden history from the only surfaces built to display it, and
  // queryInactiveList exists precisely to show finished things.
  it.each(HISTORY)('%s does NOT exclude archived plantings', (_n, fn) => {
    const arms = plantArms(emit(fn));
    expect(arms.length).toBeGreaterThan(0);
    for (const arm of arms) expect(arm).not.toContain('gp.archived_at IS NULL');
  });

  // Soft-delete is a RETRACTION of the record, not a completion of it, so it is excluded from both
  // classes — and from history too. Pinned so a future edit cannot reason "history keeps everything".
  it.each([...ACTIONABLE, ...HISTORY])('%s excludes soft-deleted plantings everywhere', (_n, fn) => {
    const arms = plantArms(emit(fn));
    expect(arms.length).toBeGreaterThan(0);
    for (const arm of arms) expect(arm).toContain('gp.deleted_at IS NULL');
  });
});
