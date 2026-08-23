// BUG-PHOTOEVENTREANCHOR-001 — a re-anchored event must take its photos with it.
//
// THE DEFECT. PUT /api/events/:id moves event_log.project_id/plant_id (Slice 3, "re-anchor") and
// referenced the `photos` table nowhere at all, so every photo hanging off the event stayed on the
// anchor the event had just left. Measured on prod 2026-08-23 across 874 event-attached, undeleted
// photos: ONE genuinely stranded row (photo 31bdddc5 on project "Strawberries" while its harvest
// event had moved to "Blueberries"). The ledger row's "23 rows" counts a DIFFERENT predicate —
// `photos.project_id IS DISTINCT FROM event_log.project_id`, which is 24, of which 23 are photos
// whose project_id was NEVER populated. NULL-vs-set is not stranded-vs-following, and this suite
// pins that distinction in the code rather than leaving it to a comment.
//
// WHY STATIC SOURCE. lambda/events/index.js imports @clerk/backend and three @aws-sdk packages that
// live only in lambda/events/package.json, so it cannot be imported in the unit run and vi.mock
// cannot help (Vite resolves before mocks). Same tier-2 approach as undo-cascade.test.js /
// undo-recompute.test.js / event-photos.test.js, and it carries the same honest limit: it proves
// the statement is WRITTEN, not that Postgres ran it. The executing proof is the EXPLAIN plan taken
// against prod at authoring time and tests/integration.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — deleting code and leaving `// was: <it>`
// behind made earlier raw-source guards in this repo find their own epitaph and pass. Same
// decommenter as undo-recompute.test.js: the `//` arm keeps `https://` intact, the `--` arm needs
// surrounding space so a JS decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Bounded by the route's OWN terminating return, never by a character count: a window that slides
// short makes every NEGATIVE assertion below pass vacuously, asserting nothing about code that has
// simply left the frame. A missing marker is a hard failure.
const routeWindow = (startMarker, endMarker) => {
  const i = RAW.indexOf(startMarker);
  expect(i, `route marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const j = RAW.indexOf(endMarker, i);
  expect(j, `route terminator not found: ${endMarker}`).toBeGreaterThan(i);
  return decomment(RAW.slice(i, j + endMarker.length));
};
const eventPut = () => routeWindow(
  'PUT /api/events/:id — edit an existing event. BUG-HARVESTEDIT-001.',
  'return resp(200, { ...updatedRows[0], harvest: harvestRow });');

// The photo statement, isolated from the two COALESCE re-parents that live in the undo routes —
// those are OUTSIDE this window, and the window guard above is what keeps that true.
const photoStmt = () => {
  const block = eventPut();
  const start = block.indexOf('UPDATE photos ph');
  expect(start, 'PUT route contains no UPDATE photos statement').toBeGreaterThan(-1);
  const end = block.indexOf('`', start);
  expect(end).toBeGreaterThan(start);
  return block.slice(start, end);
};

describe('window integrity — the guards below are not asserting about an empty string', () => {
  it('frames the whole PUT route, event_log UPDATE included', () => {
    const block = eventPut();
    expect(block.length).toBeGreaterThan(5000);
    expect(block).toContain('UPDATE event_log el');
    // The undo routes' COALESCE re-parents sit ABOVE this window. If they ever drift inside it the
    // "no COALESCE" assertion below would be testing the wrong statement.
    expect(block).not.toContain('event_id   = NULL');
  });
});

describe('the re-anchor moves the event’s photos with it', () => {
  it('issues an UPDATE photos keyed on the event, inside the PUT route', () => {
    const stmt = photoStmt();
    expect(stmt).toMatch(/WHERE ph\.event_id = \$\{eventId\}/);
    expect(stmt).toMatch(/ph\.deleted_at IS NULL/);
  });

  it('ASSIGNS the new anchor — a COALESCE here is the no-op that shipped', () => {
    // The undo paths re-parent a photo that is LOSING its event and must keep any parent it has, so
    // theirs is COALESCE(ph.project_id, e.project_id) and only fills a NULL. Copying that shape into
    // a re-anchor is precisely the bug: it cannot move an anchor that is already set.
    const stmt = photoStmt();
    expect(stmt).not.toMatch(/COALESCE\(\s*ph\.project_id/);
    expect(stmt).not.toMatch(/COALESCE\(\s*ph\.plant_id/);
    expect(stmt).toMatch(/project_id = CASE WHEN[\s\S]*?THEN \$\{newProjectId\}::uuid/);
    expect(stmt).toMatch(/plant_id\s*= CASE WHEN[\s\S]*?THEN \$\{newPlantId\}::uuid/);
  });

  it('moves only the anchors that were FOLLOWING the event — the pre-edit value gates each arm', () => {
    // The 23 project rows / 835 plant rows whose photo anchor is NULL while the event has one were
    // never populated; they are the POST path's defect, not this one. Widening the predicate to
    // "differs" would silently re-parent all 858 on the next unrelated edit.
    const stmt = photoStmt();
    expect(stmt).toMatch(/ph\.project_id IS NOT DISTINCT FROM \$\{oldProjectId\}::uuid/);
    expect(stmt).toMatch(/ph\.plant_id\s+IS NOT DISTINCT FROM \$\{oldPlantId\}::uuid/);
    // ELSE keeps the photo's own anchor. An `ELSE NULL` (the implicit default of a bare CASE/THEN)
    // would blank every independently-tagged photo on the event.
    expect(stmt).toMatch(/ELSE ph\.project_id END/);
    expect(stmt).toMatch(/ELSE ph\.plant_id\s+END/);
  });

  it('binds every anchor with an explicit ::uuid cast — all four can be NULL', () => {
    // A project-less, plant-less event sends NULL for old and new alike, and the neon HTTP driver
    // answers an uncast NULL bind with "could not determine data type of parameter". Verified by
    // EXPLAIN against prod with all five binds NULL: plans clean.
    const stmt = photoStmt();
    for (const bind of ['oldProjectId', 'newProjectId', 'oldPlantId', 'newPlantId']) {
      expect(stmt, `\${${bind}} must carry ::uuid`).toContain(`\${${bind}}::uuid`);
    }
  });

  it('runs only when an anchor actually moved', () => {
    // Unconditional would rewrite updated_at on every harvest-amount or note edit in a 12,500-event
    // log, which is both pointless churn and a false "someone touched this photo" signal.
    const block = eventPut();
    const stmtAt = block.indexOf('UPDATE photos ph');
    const gateAt = block.lastIndexOf('if (projectChanged || plantChanged) {', stmtAt);
    expect(gateAt, 'the photo UPDATE is not gated on anchor movement').toBeGreaterThan(-1);
    // Gate must be the statement's OWN enclosing block, not some earlier unrelated one.
    expect(stmtAt - gateAt).toBeLessThan(400);
  });

  it('carries the actor GUC in the SAME transaction as the write', () => {
    // photos has no audit trigger today, so this is forward-cover rather than a live requirement —
    // but the neon HTTP driver makes each bare `await sql` its own transaction, so a set_config
    // issued outside this array would already have committed and been discarded. Grouping is the
    // property; both sibling photo writes are grouped the same way.
    const block = eventPut();
    const stmtAt = block.indexOf('UPDATE photos ph');
    const txAt = block.lastIndexOf('await sql.transaction([', stmtAt);
    expect(txAt).toBeGreaterThan(-1);
    const head = block.slice(txAt, stmtAt);
    expect(head).toMatch(/set_config\('app\.actor_clerk_sub', \$\{userId\}, true\)/);
  });

  it('lands AFTER the care-cache recompute, which is already committed-event-dependent', () => {
    // Ordering is a safety property, not taste: this statement is non-atomic with the event_log
    // UPDATE like everything else below it, so a throw here must not be able to skip a recompute the
    // committed event row depends on. Placing it earlier would make a photo failure a cache defect.
    const block = eventPut();
    expect(block.indexOf('UPDATE entity_memory em SET'))
      .toBeLessThan(block.indexOf('UPDATE photos ph'));
  });
});
