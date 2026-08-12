// Care-cache recompute on event undo (BUG-CARECACHEUNDO-001, 2026-08-07). Static-source per L-072
// house style, matching undo-route.test.js / undo-cascade.test.js (DB-free).
//
// ROOT CAUSE pinned here: all four undo recompute arms — batch and single, project-keyed and
// plant-keyed — recomputed ONLY last_watered_at. Undoing a harvest / fertilizing / pruning /
// observation soft-deleted the event and left the matching entity_memory column, and last_event_at,
// permanently ahead of the event log. Every forward upsert is GREATEST(), so the cache can never
// walk backwards on its own, and nothing else repaired it. The single-event arm was worse than
// incomplete: the whole recompute sat behind `event_type === 'watering' || 'rain'`, so a harvest
// undo ran no recompute at all.
//
// Confirmed on live prod at authoring time: 2 plant rows cached a soft-deleted harvest —
// "Beefsteak Rescue 2" (cached 2026-07-31, true max 2026-07-14) and "Pineapple Tomato" (cached
// 2026-08-04, no surviving harvest whatsoever).
//
// THE INVARIANT: a recompute must be the exact inverse of ITS OWN arm's forward writer. That is why
// the two harvest filters below deliberately DIFFER and both are asserted — the plant-keyed writer
// maps IN ('harvest','first_harvest') (0b-backfill.sql), the project-keyed writer maps 'harvest'
// alone. A "consistency" refactor that unifies them would make an unrelated undo move
// last_harvested_at to a date no forward write ever set, and would pass a laxer test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

// The route markers are COMMENT banners, so the offsets are taken in RAW; the extracted window is
// then decommented so every assertion below runs against code and cannot be satisfied by prose.
// Bounded by the route's OWN terminating `return`, not by a magic character count. The lengths
// here were 9000 / 12000 and broke the moment a comment was added inside either route (W-BATCHNULL,
// 2026-08-12). The failure mode that matters is not this one — a positive assertion that loses its
// text fails loudly. It is that a window which slides too short makes every NEGATIVE assertion pass
// vacuously, asserting nothing about code that has simply left the frame. Same fix applied in
// undo-cascade.test.js; keep the two in step.
const routeWindow = (startMarker, endMarker) => {
  const i = RAW.indexOf(startMarker);
  expect(i, `route marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const j = RAW.indexOf(endMarker, i);
  expect(j, `route terminator not found: ${endMarker}`).toBeGreaterThan(i);
  return decomment(RAW.slice(i, j + endMarker.length));
};
const batchUndo = () => routeWindow(
  '/api/events/batch/:id — undo a batch', 'return resp(200, { undone: true, batch_id: batchId });');
const singleUndo = () => routeWindow(
  '/api/events/:id — single-event undo', 'return resp(200, { undone: true, id: eventId });');

// One arm's statement, isolated inside its own route block by the key it joins on. The four arms
// have near-identical SET lists, so anchoring must run BACKWARDS from the distinguishing FROM clause
// — a forward search would let one arm's assertions be satisfied by a sibling's text.
const stmtOf = (routeBlock, tailAnchor, head) => {
  const end = routeBlock.indexOf(tailAnchor);
  expect(end).toBeGreaterThan(-1);
  const start = routeBlock.lastIndexOf(head, end);
  expect(start).toBeGreaterThan(-1);
  return routeBlock.slice(start, end);
};
// SET list only (the UPDATE), for the column assignments.
const arm = (routeBlock, tailAnchor) => stmtOf(routeBlock, tailAnchor, 'UPDATE entity_memory em SET');
// CTE + UPDATE, for the surv/MAX() assertions.
const full = (routeBlock, tailAnchor) => stmtOf(routeBlock, tailAnchor, 'WITH ');

const RECENCY_COLUMNS = [
  'last_event_at',
  'last_watered_at',
  'last_fertilized_at',
  'last_pruned_at',
  'last_observed_at',
  'last_harvested_at',
  // BUG-LASTISSUEPLANT-001 (2026-08-07). last_issue_at was absent from all six recompute arms while
  // the project-keyed forward upsert wrote it through GREATEST — so the column this file's own
  // header calls "permanently ahead of the event log" was still exactly that, in the very fix that
  // claimed to have repaired every recency column. It is keyed on the FLAG, not on event_type,
  // because that is what its forward writer keys on; the flag predicate is asserted separately below
  // so widening this list can never be satisfied by an event_type-scoped MAX().
  'last_issue_at',
];

const ARMS = [
  { name: 'batch undo, project-keyed', route: batchUndo, tail: 'FROM surv WHERE em.project_id = surv.project_id', harvest: "e.event_type = 'harvest' AND" },
  { name: 'batch undo, plant-keyed', route: batchUndo, tail: 'FROM surv WHERE em.plant_id = surv.plant_id', harvest: "e.event_type IN ('harvest','first_harvest')" },
  { name: 'single undo, project-keyed', route: singleUndo, tail: 'FROM surv WHERE em.project_id = ${projectId}', harvest: "e.event_type = 'harvest' AND" },
  { name: 'single undo, plant-keyed', route: singleUndo, tail: 'FROM surv WHERE em.plant_id = ${plantId}', harvest: "e.event_type IN ('harvest','first_harvest')" },
].map((a) => ({ ...a, get: () => arm(a.route(), a.tail), all: () => full(a.route(), a.tail) }));

describe.each(ARMS)('events Lambda — undo recompute arm: $name', ({ get, name }) => {
  it.each(RECENCY_COLUMNS)('recomputes %s from the surviving events', (col) => {
    expect(get()).toMatch(new RegExp(`${col}\\s*=\\s*surv\\.m`));
  });

  it('assigns each column from surv, never from a GREATEST that cannot walk backwards', () => {
    // The entire point of the repair: an undo must be able to LOWER a cached value. A GREATEST here
    // would silently reintroduce the ratchet that made the drift permanent.
    const stmt = get();
    for (const col of RECENCY_COLUMNS) {
      expect(stmt).not.toMatch(new RegExp(`${col}\\s*=\\s*GREATEST`));
    }
    expect(name).toBeTruthy();
  });
});

describe('events Lambda — the surv CTEs read only surviving events', () => {
  it.each(ARMS)('$name computes exactly 7 MAX()es, every one scoped to deleted_at IS NULL', ({ all }) => {
    // A MAX() without the deleted_at filter would re-read the row the undo just soft-deleted and
    // write the stale value straight back — the failure would look exactly like no fix at all.
    // 7 since BUG-LASTISSUEPLANT-001 added the flag-keyed last_issue_at arm.
    const stmt = all();
    expect((stmt.match(/MAX\(e\.event_date\)/g) ?? []).length).toBe(7);
    expect((stmt.match(/e\.deleted_at IS NULL/g) ?? []).length).toBe(7);
  });

  it.each(ARMS)('$name recomputes last_issue_at from the FLAG, not from an event_type', ({ all }) => {
    // BUG-LASTISSUEPLANT-001. The forward writer keys last_issue_at on flagged_as_issue, so its
    // inverse must too. An event_type-scoped MAX() here would satisfy the RECENCY_COLUMNS list and
    // the MAX() count above while recomputing the wrong set of rows — green, and still wrong.
    const stmt = all();
    expect(stmt).toMatch(/e\.flagged_as_issue = true AND e\.deleted_at IS NULL\) AS mi/);
    expect((stmt.match(/e\.flagged_as_issue = true/g) ?? []).length).toBe(1);
  });

  it.each(ARMS)('$name leaves last_event_at unfiltered by event_type', ({ all }) => {
    // last_event_at is "any activity", including the status_change events that plants/index.js and
    // projects/index.js write. Filtering it would drop those and under-report activity.
    expect(all()).toMatch(/MAX\(e\.event_date\) FROM event_log e\s*\n\s*WHERE e\.(project|plant)_id = [^\n]*AND e\.deleted_at IS NULL\) AS me/);
  });
});

describe('events Lambda — per-arm writer parity on the harvest mapping', () => {
  it.each(ARMS)('$name uses its own writer’s harvest filter', ({ all, harvest }) => {
    expect(all()).toContain(harvest);
  });
});

describe('events Lambda — single-event undo is no longer gated on watering', () => {
  it('does not wrap the recompute in an event_type === watering/rain JS branch', () => {
    // The original defect. If this gate comes back, undoing a harvest silently updates nothing.
    expect(singleUndo()).not.toMatch(/if \(owned\[0\]\.event_type === 'watering'/);
  });

  it('pushes the project-keyed recompute unconditionally', () => {
    const b = singleUndo();
    const push = b.indexOf('stmts.push(sql`');
    expect(push).toBeGreaterThan(-1);
    // Every `if` above the first recompute push must be an ownership guard that RETURNS, so none of
    // them can gate the push. This used to name the single expected guard via lastIndexOf('if (');
    // BUG-NULLPROJEVENT-001 added a SECOND 404 guard (the isEventOwned re-check on the row the
    // ownership read returned), which became the last `if` and broke the landmark while the property
    // it was testing still held. Asserting the property across ALL of them is what the test meant,
    // and it no longer has to be re-anchored every time a guard is added.
    const ownedRead = b.indexOf('const owned = await sql');
    expect(ownedRead).toBeGreaterThan(-1);
    const guards = b.slice(ownedRead, push).match(/^\s*if \(.*$/gm) ?? [];
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) expect(g).toMatch(/return resp\(404, \{ error: 'Not found' \}\);/);
  });

  it('still guards the plant-keyed recompute on plantId — project-level events have none', () => {
    // Not a redundant guard: the neon driver cannot type a NULL bound param even with ::uuid, so an
    // unguarded ${plantId} would 500 the undo on every project-level event.
    expect(singleUndo()).toMatch(/if \(plantId\) \{\s*stmts\.push\(sql`/);
  });
});

describe('events Lambda — next_water_at is NOT treated as a recency column', () => {
  it('single undo recomputes next_water_at only when the undone event was watering/rain', () => {
    // The nightly daily-plan engine owns "due". Recomputing it from last_watered + interval on an
    // unrelated undo would clobber the engine's value — so the gate moved from JS into SQL rather
    // than disappearing with the recency gate.
    expect(singleUndo()).toMatch(
      /next_water_at = CASE WHEN \$\{undoneType\}::text NOT IN \('watering','rain'\) THEN em\.next_water_at/);
  });

  it('never appears in either plant-keyed arm — the plant cache is pure recency', () => {
    for (const a of ARMS.filter((x) => x.name.includes('plant-keyed'))) {
      expect(a.get()).not.toMatch(/next_water_at/);
    }
  });
});
