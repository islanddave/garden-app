// V4-ZONEDECIDE-001 — the Log Many "By zone" branch of the batch scope CASE.
//
// Dave, 2026-08-20: "keep zone filtering for log many and other utility surfaces." The filter
// already existed (V4-LOGMANYLOC-001 shipped the recursive cascade, BUG-SPACEFILTER-001 the
// COALESCE); what did not exist was a single test that would notice if it stopped working. This is
// the every-push half of that gap. The behavioural half — real rows through a real subtree — is
// tests/integration/logmany-zone.int.test.js, which only runs in CI's DB job.
//
// Static-source (L-072), DB-free, same house pattern and same slice delimiters as
// logmany-dormant.test.js: the CASE lives inside a tagged template inside a Lambda with no local DB
// harness, and a whole-file `toMatch` would happily find these constructs in the block comment that
// explains them, so assertions run against DECOMMENTED source sliced to the scope SELECT.
//
// HOW LOAD-BEARING THE RECURSION IS, measured on live prod 2026-08-20 (read-only):
//   zone Pasture, WITH RECURSIVE cascade = 135 plantings; zone Pasture, exact match = 0.
// Not one Pasture planting is filed on the zone row itself — they all sit in Row A-F / Bag Area /
// In-Ground / Pasture-Shade. So an exact-match regression does not degrade the filter, it empties
// the largest zone in the garden while still looking like a working filter.
//
// Each claim fails to a DIFFERENT mutation:
//   1. presence   → deleting the CASE, or moving it out of the scope SELECT
//   2. no-filter  → giving the 'all' branch a location predicate, which is the one thing that must
//                   never happen: "no zone picked" is the default and has to mean everything
//   3. coalesce   → reverting to `pp.location_id` alone (the BUG-SPACEFILTER-001 shape)
//   4. recursion  → reverting to an exact `= ${locationId}` (the pre-V4-LOGMANYLOC-001 shape)
//   5. direction  → flipping the recursive join so the walk goes UP the tree instead of down
//   6. seed       → seeding the CTE from anything but the bound location id
//   7. else-arm   → `ELSE true`, which would turn an unrecognised scope type into the whole garden

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Same two delimiters logmany-dormant.test.js uses: the scope SELECT's FROM clause and the ORDER BY
// that BUG-BATCHORDER-001 pinned. Slicing is what makes claim 1 mean "in the resolver" rather than
// "somewhere in a 2000-line file".
const FROM = 'FROM public.garden_node p JOIN public.container pp ON pp.id = p.container_id';
const ORDER = 'ORDER BY p.display_name, p.id';
const fromIdx = SRC.indexOf(FROM);
const orderIdx = SRC.indexOf(ORDER, fromIdx);
const SCOPE_SELECT = fromIdx > -1 && orderIdx > fromIdx ? SRC.slice(fromIdx, orderIdx) : '';

const caseIdx = SCOPE_SELECT.indexOf('CASE ${scopeType}');
const endIdx = SCOPE_SELECT.indexOf('END', caseIdx);
const SCOPE_CASE = caseIdx > -1 && endIdx > caseIdx ? SCOPE_SELECT.slice(caseIdx, endIdx) : '';

describe('events Lambda — Log Many By-zone scope resolution', () => {
  it('the scope CASE is still inside the batch scope SELECT (the slice these assertions depend on)', () => {
    expect(fromIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(fromIdx);
    expect(caseIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(caseIdx);
    expect(SCOPE_CASE).toMatch(/WHEN 'space'/);
  });

  it("the 'all' branch is unconditionally true — no zone picked means NO filtering", () => {
    // The invariant that outranks every other claim in this file. `{type:'all'}` is LogMany's
    // initial state (LogMany.jsx:121) AND the fallback whenever a remembered or deep-linked
    // location_id no longer resolves, so any location predicate leaking into this arm would narrow
    // the DEFAULT batch silently. Plantings with no location at all belong to no zone and would be
    // the first to disappear.
    expect(SCOPE_CASE).toMatch(/WHEN 'all'\s+THEN true/);
  });

  it("the 'space' branch matches the PLANTING's location first, the project's only as fallback", () => {
    // BUG-SPACEFILTER-001: a planting reassigned to a sub-location while its project sits elsewhere
    // was invisible to the by-zone filter, which saw only pp.location_id.
    expect(SCOPE_CASE).toMatch(/WHEN 'space'\s+THEN COALESCE\(p\.location_id, pp\.location_id\) IN \(/);
  });

  it('resolves a zone through a RECURSIVE subtree, not an exact location match', () => {
    // V4-LOGMANYLOC-001. See the prod measurement in the header: exact match returns 0 for Pasture.
    expect(SCOPE_CASE).toMatch(/WITH RECURSIVE loc_subtree AS \(/);
    expect(SCOPE_CASE).toMatch(/SELECT id FROM loc_subtree/);
  });

  it('walks DOWN the tree — a child joins to its parent in the subtree, never the reverse', () => {
    // `JOIN loc_subtree st ON st.parent_id = l.id` would walk UP: picking a sub-location would
    // silently widen the batch to its whole zone. That mutation keeps the CTE, keeps the COALESCE,
    // and fails only here.
    expect(SCOPE_CASE).toMatch(/JOIN loc_subtree st ON l\.parent_id = st\.id/);
  });

  it('seeds the subtree from the bound location id, and skips deleted locations', () => {
    expect(SCOPE_CASE).toMatch(/SELECT id FROM locations WHERE id = \$\{locationId\} AND deleted_at IS NULL/);
    expect(SCOPE_CASE).toMatch(/JOIN loc_subtree st ON l\.parent_id = st\.id\s+WHERE l\.deleted_at IS NULL/);
  });

  it('an unrecognised scope type resolves to NOTHING, never to everything', () => {
    // validators.js gates scope.type to all|project|space before this runs, so this arm is
    // unreachable today — which is exactly why it needs pinning: `ELSE true` would be invisible
    // until the day a fourth scope type is added and ships matching the entire garden.
    expect(SCOPE_SELECT.slice(caseIdx, endIdx + 3)).toMatch(/ELSE false\s+END/);
  });
});
