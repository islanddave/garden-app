// V4-SOFTDEL-001 F3 — a soft-deleted CONTAINER must take its events off every read surface.
//
// The bug: events/index.js had 8 sql templates joining public.container on an event's project_id.
// Three of them (the DELETE undo pre-flight, the harvest-summary pair) filtered pp.deleted_at;
// the five READ paths did not. So undoing a container left its events on /api/events/feed, on
// the project- and planting-scoped lists, and on the by-id detail route — with the deleted
// container's own display_name still resolving through that same JOIN. Measured on prod
// 2026-08-06: 1 live event under a soft-deleted container (Dave; 0 for Jen).
//
// Static-source (L-072), DB-free — the house pattern for asserting handler SQL shape in a Lambda
// with no DB harness (mirrors hs2-plant-filter.test.js / feed-route.test.js / events-authz.test.js).
//
// EVERY assertion below was mutation-verified: the named source mutation was actually applied,
// the test observed RED, and the file was restored byte-identically (shasum-checked). The mutation
// is named in each `it` so a future reader can re-run it.

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
const DASH = decomment(readFileSync(resolve(__dirname, '..', 'dashboard', 'handlers.js'), 'utf8'));

// Real tagged templates only — same extraction as lambda/sql-comment-hygiene.test.js, so prose in
// JS comments that merely mentions sql cannot be mistaken for a query.
function sqlTemplates(src) {
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    if (/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(body)) out.push(body);
  }
  return out;
}

// Strip SQL line comments before predicate matching: a predicate that exists ONLY inside a `--`
// comment is not a predicate. Without this, every assertion here would pass vacuously against the
// explanatory comments this fix added.
const uncommented = (body) => body.replace(/--[^\n]*/g, '');

const EVENT_CONTAINER_JOIN = /JOIN\s+public\.container\s+pp\s+ON\s+pp\.id\s*=\s*e[a-z]*\.project_id/;

// Route-bounded windows — never a fixed character count (feed-route.test.js documents why a
// byte-count slice silently truncates or, worse, matches foreign code).
function block(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  expect(i, `start marker not found — update this anchor: ${startMarker}`).toBeGreaterThan(-1);
  const j = src.indexOf(endMarker, i + startMarker.length);
  return src.slice(i, j === -1 ? undefined : j);
}

describe('events Lambda — F3 container soft-delete filter', () => {
  // MUTATION: delete `AND pp.deleted_at IS NULL` from the /api/events/feed WHERE clause
  // (index.js, feed route) -> RED here ("feed" listed as unfiltered). Restored, GREEN.
  it('EVERY sql template that joins container on an event project_id filters pp.deleted_at', () => {
    const joined = sqlTemplates(SRC).filter(b => EVENT_CONTAINER_JOIN.test(b));
    // 8 today: feed, by-id GET, DELETE pre-flight, harvest-summary x2, harvest-ready x2, list x3
    // minus overlaps. The floor guards against the regex silently matching nothing after a rename.
    expect(joined.length).toBeGreaterThanOrEqual(8);
    const unfiltered = joined
      .map(uncommented)
      .filter(b => !/\bpp\.deleted_at IS NULL\b/.test(b))
      .map(b => b.replace(/\s+/g, ' ').slice(0, 120));
    expect(unfiltered, 'container-joined event query with no pp.deleted_at filter').toEqual([]);
  });

  // MUTATION: same as above, scoped -> RED on this narrower assertion too, which is the point:
  // it names the route so a failure says WHICH surface regressed.
  it('the /api/events/feed route filters the deleted container', () => {
    const b = uncommented(block(SRC, "rawPath === '/api/events/feed'", "if (rawPath === '/api/events/"));
    expect(b).toMatch(/AND pp\.deleted_at IS NULL/);
  });

  // MUTATION: delete `AND pp.deleted_at IS NULL` from the by-id GET WHERE clause -> RED.
  it('GET /api/events/:id filters the deleted container, matching its own DELETE handler', () => {
    // This start marker is a SQL COMMENT, so the block is located in RAW and decommented after.
    const detail = decomment(block(RAW, '-- BUG-HARVESTEDIT-001', "if (method === 'DELETE')"));
    expect(detail).toMatch(/AND pp\.deleted_at IS NULL/);
    // The DELETE handler always had it; this is the parity claim the fix rests on.
    const del = uncommented(block(SRC, "if (method === 'DELETE') {", 'return resp(405'));
    expect(del).toMatch(/AND pp\.deleted_at IS NULL/);
  });

  // MUTATION: delete the predicate from the bare (no project_id) list branch only -> RED with
  // "3 list branches ... got 2", proving the count is not satisfied by the other two branches.
  it('ALL THREE GET /api/events list branches filter the deleted container', () => {
    const list = block(SRC, 'const rows = (projectId && plantId)', 'return resp(200, rows);');
    const branches = list.split('FROM event_log e').slice(1).map(uncommented);
    expect(branches.length, '3 list branches (plant-scoped, project-scoped, bare)').toBe(3);
    for (const [i, b] of branches.entries()) {
      expect(b, `list branch ${i} missing pp.deleted_at filter`).toMatch(/AND pp\.deleted_at IS NULL/);
    }
  });
});

describe('events Lambda — F3 deleted-PLANTING policy switch', () => {
  // MUTATION: flip the literal to `= true` in index.js -> RED. This is the guard that the
  // shipped default is the no-product-change one; flipping it is a deliberate, reviewed act.
  it('ships DISABLED, so a deleted planting whose container lives keeps its events (today’s behavior)', () => {
    expect(SRC).toMatch(/export const HIDE_EVENTS_UNDER_DELETED_PLANTING = false;/);
  });

  // MUTATION: change the dashboard copy to `= true` -> RED (the two files disagree). Without
  // this, the Dashboard feed and the events lists could silently ship opposite policies.
  it('dashboard/handlers.js carries the SAME switch value (the two lambdas cannot disagree)', () => {
    const here = SRC.match(/export const HIDE_EVENTS_UNDER_DELETED_PLANTING = (true|false);/);
    const there = DASH.match(/export const HIDE_EVENTS_UNDER_DELETED_PLANTING = (true|false);/);
    expect(here, 'switch missing from events/index.js').not.toBeNull();
    expect(there, 'switch missing from dashboard/handlers.js').not.toBeNull();
    expect(there[1]).toBe(here[1]);
  });

  // MUTATION: delete the `OR EXISTS (... gn.deleted_at IS NULL)` arm from one query -> RED with
  // a count of 4. Flipping the constant would then be a silent no-op on that surface — the exact
  // failure mode a "one-line switch" claim has to rule out.
  it('all 5 event read queries carry the switch predicate, so one flip moves every surface', () => {
    const wired = sqlTemplates(SRC).filter(b =>
      /\$\{HIDE_EVENTS_UNDER_DELETED_PLANTING\}::boolean IS NOT TRUE/.test(uncommented(b)));
    expect(wired.length, 'feed + by-id + 3 list branches').toBe(5);
    for (const b of wired) {
      const u = uncommented(b);
      // The disabled arm must short-circuit FIRST (no subquery cost while the switch is off)...
      expect(u).toMatch(/\$\{HIDE_EVENTS_UNDER_DELETED_PLANTING\}::boolean IS NOT TRUE\s*\n?\s*OR e\.plant_id IS NULL/);
      // ...and the enabled arm must actually test the planting's own soft-delete.
      expect(u).toMatch(/EXISTS \(SELECT 1 FROM public\.garden_node gn\s*\n?\s*WHERE gn\.id = e\.plant_id AND gn\.deleted_at IS NULL\)/);
    }
  });

  // MUTATION: replace `::boolean IS NOT TRUE` with `= false` in one query -> RED. A bare `= false`
  // on an untyped neon param is the 42P18 "could not determine data type" class (L-086); every
  // other nullable/optional param in this file carries an explicit cast for the same reason.
  it('the switch param is explicitly cast (untyped neon params are an L-086 parse failure)', () => {
    const wired = sqlTemplates(SRC).filter(b =>
      /HIDE_EVENTS_UNDER_DELETED_PLANTING/.test(uncommented(b)));
    for (const b of wired) {
      expect(uncommented(b)).toMatch(/\$\{HIDE_EVENTS_UNDER_DELETED_PLANTING\}::boolean/);
    }
  });
});
