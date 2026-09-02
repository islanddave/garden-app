// V5-HEATRESPONSEDISPLAY-001 — the by-id GET must actually return heat_response, resolved.
//
// The client half is gated in src/__tests__/PlantingDetail.heatResponse.test.jsx, which mocks the
// API and therefore cannot notice that the API never sends the field. This is the other half.
//
// Static-source, matching this directory's existing harness (select-columns.test.js,
// care-rekey-byid.test.js): plants/index.js is a wired handler that imports
// @neondatabase/serverless + @clerk/backend, which are not resolvable at app level, so the by-id
// SELECT is asserted as source text rather than executed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// The by-id GET is the only template that selects the care band columns alongside variety_ref.
// Same locator as care-rekey-byid.test.js, deliberately: two guards on the same statement should
// not disagree about which statement it is.
const byIdSelect = (() => {
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(SRC)) !== null) {
    if (/variety_ref/.test(m[1]) && /entity_memory em/.test(m[1])) return m[1].replace(/--[^\n]*/g, '');
  }
  return null;
})();

describe('by-id GET — heat_response reaches the client', () => {
  it('the by-id SELECT is findable (harness guard)', () => {
    expect(byIdSelect).not.toBeNull();
  });

  // MUTATION: delete the `rc.resolved_profile ->> 'heat_response' AS heat_response` projection ->
  // RED. Without it the planting page renders "nothing recorded for this plant" on all 269 live
  // plantings, which is the honest-absence copy telling a lie.
  it('projects heat_response under that exact name', () => {
    expect(byIdSelect).toMatch(/resolved_profile\s*->>\s*'heat_response'\s+AS\s+heat_response/);
  });

  // MUTATION: drop the join -> RED (the projection would not compile). Asserted separately because a
  // projection can survive a join being renamed, and the alias is what ties the two together.
  it('joins the shipped resolver view on the planting', () => {
    expect(byIdSelect).toMatch(/LEFT JOIN public\.v_resolved_care rc ON rc\.leaf_id = p\.id/);
  });

  // MUTATION: read it from `ow` (the leaf-scope care_profile join the overwintering read uses)
  // instead of `rc` -> RED. This is the likely wrong turn, because the line directly above it in the
  // source is a LEAF-ONLY read with a long comment explaining why leaf-only is correct THERE.
  // 262 of the 264 rows carrying heat_response are cultivar-scoped, so a leaf-scope read returns
  // NULL for every planting in the garden while looking entirely reasonable in review.
  it('reads the RESOLVED profile, not the leaf-scope row', () => {
    expect(byIdSelect).not.toMatch(/ow\.profile\s*->>?\s*'heat_response'/);
  });

  // MUTATION: change the join to `ON rc.leaf_id = p.container_id` (the shape the care band itself
  // shipped with and had to be re-keyed away from in V4-CAREKEY-001) -> RED. A container-keyed join
  // would hand a planting its SIBLING's heat prose, which is both wrong and unfalsifiable on screen.
  it('no container-keyed v_resolved_care join survives anywhere in the handler', () => {
    expect(SRC.replace(/--[^\n]*/g, '')).not.toMatch(/v_resolved_care\s+\w+\s+ON\s+\w+\.leaf_id\s*=\s*p\.container_id/);
  });
});
