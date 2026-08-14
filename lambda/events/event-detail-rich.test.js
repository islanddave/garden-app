// V4-EVENTDETAILRICH-001 (server half) — GET /api/events/:id exposes the planting's display name.
//
// EventDetail could not name the planting an event was logged against: the by-id GET joined
// garden_node purely for the ownership gate and projected only pn.created_by, which it then
// STRIPPED from the response. The client held a bare plant_id and nothing to render.
//
// THE WIRE CONTRACT IS PINNED HERE BECAUSE IT IS SHARED ACROSS LANES. The consumer
// (src/pages/EventDetail.jsx) was built in a different lane against this exact field name and these
// exact null semantics: `planting_name`, a string, NULL when the event has no planting anchor. Two
// blind lanes agreeing on a private literal is a known failure mode in this fleet, so the literal
// gets a guard on the producing side rather than only an assumption on the consuming side.
//
// Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

// The by-id GET, bounded by its own two ends. Its start marker is a SQL comment, so it is located
// in RAW and decommented after — the softdel-feed.test.js precedent for this same block.
function detailGet() {
  const i = RAW.indexOf('-- BUG-HARVESTEDIT-001');
  expect(i, 'by-id GET start anchor not found').toBeGreaterThan(-1);
  const j = RAW.indexOf("if (method === 'DELETE')", i);
  expect(j, 'by-id GET end anchor not found').toBeGreaterThan(-1);
  return decomment(RAW.slice(i, j));
}

describe('events Lambda — V4-EVENTDETAILRICH-001 planting_name', () => {
  // MUTATION: rename the alias (e.g. to plant_name) -> RED. The sibling lane's consumer reads
  // planting_name; a rename here is a cross-lane break that no client test can see.
  it('the by-id GET projects pn.display_name AS planting_name', () => {
    expect(detailGet()).toMatch(/pn\.display_name AS planting_name/);
  });

  // MUTATION: add planting_name to the strip destructure -> RED. The two OWNER columns are an
  // authorization detail and are stripped on purpose; planting_name is contract and must survive.
  it('planting_name is NOT stripped from the response (unlike the two owner columns)', () => {
    const strip = SRC.match(/const \{ ([^}]*) \} = rows\[0\];/);
    expect(strip, 'the by-id GET strip destructure moved — update this anchor').not.toBeNull();
    expect(strip[1]).toContain('project_owner_id');
    expect(strip[1]).toContain('plant_owner_id');
    expect(strip[1]).not.toContain('planting_name');
  });

  // NULL semantics are structural, not defensive: the join is LEFT and already carries its own
  // deleted_at predicate, so plant_id IS NULL and a soft-deleted planting both yield no pn row and
  // therefore planting_name NULL. MUTATION: make the join INNER -> RED, and every project-level
  // event would 404 instead of returning with a null planting.
  it('the planting join stays LEFT, which is what makes the null case a null rather than a 404', () => {
    expect(detailGet()).toMatch(/LEFT JOIN public\.garden_node pn ON pn\.id = e\.plant_id AND pn\.deleted_at IS NULL/);
  });

  // The widening must not disturb the gate that shares the join. MUTATION: drop either arm -> RED.
  it('the ownership gate on the same join is untouched', () => {
    const g = detailGet();
    expect(g).toMatch(/e\.project_id IS NOT NULL AND pp\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(g).toMatch(/e\.project_id IS NULL\s+AND pn\.created_by = ANY\(\$\{householdIds\}\)/);
  });
});
