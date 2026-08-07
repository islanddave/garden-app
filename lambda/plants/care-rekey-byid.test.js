// V4-CAREKEY-001 Step D — the plants by-id GET care band.
//
// This is the single read the whole re-key exists for. The by-id SELECT joined
// `entity_memory em ON em.project_id = pp.id`, so a planting's care band showed whatever its
// most-recently-tended SIBLING did. Measured on live prod 2026-08-07: 51 of 252 live plantings
// (42 Dave, 9 rescue-intake) were being shown a last_watered_at that is not their own — one in five.
// The daily-plan engine has always been per-planting (engine.js derives last_water from
// event_log WHERE plant_id = p.id), so this join was the last place the two grains disagreed.
//
// Static-source, matching this directory's existing harness (select-columns.test.js,
// project-less.test.js): plants/index.js is a wired handler that imports
// @neondatabase/serverless + @clerk/backend, which are not resolvable at app level, so the by-id
// SELECT is asserted as source text rather than executed.
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

// The by-id GET is the only template that selects the care band columns alongside variety_ref.
const byIdSelect = (() => {
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(SRC)) !== null) {
    if (/variety_ref/.test(m[1]) && /entity_memory em/.test(m[1])) return m[1].replace(/--[^\n]*/g, '');
  }
  return null;
})();

describe('Step D — the by-id care band is keyed on the planting', () => {
  it('the by-id SELECT is findable (harness guard)', () => {
    expect(byIdSelect).not.toBeNull();
  });

  // MUTATION: change `LEFT JOIN entity_memory em ON em.plant_id = p.id` back to
  // `... ON em.project_id = pp.id` in index.js -> RED. This is the re-key itself. Without it the
  // band is a container-wide average wearing a planting's name.
  it('joins entity_memory on the planting, not its container', () => {
    expect(byIdSelect).toMatch(/LEFT JOIN entity_memory em ON em\.plant_id = p\.id/);
  });

  // MUTATION: the same edit -> RED. Asserted as its own case because a join can be ADDED without the
  // old one being removed, and two entity_memory joins would fan the row out silently.
  it('no container-keyed entity_memory join survives anywhere in the handler', () => {
    expect(uncommented).not.toMatch(/entity_memory em ON em\.project_id/);
  });

  // MUTATION: replace the COALESCE with a bare `em.next_water_at` -> RED. Plant-keyed rows carry
  // next_water_at NULL by construction (0b-backfill.sql and the Step-B upsert both omit it —
  // design §8.1). Live prod: 0 of 262 plant rows have it set. So a bare read makes the band's
  // legacy fallback dead on arrival, and the "Next watering" cell blanks for EVERY planting in the
  // engine-skip window that fallback exists to cover. The COALESCE rebuilds the same interval
  // ladder the container row used to bake in, anchored on this planting's own last_watered_at.
  it('reconstitutes next_water_at at read time rather than trusting the column', () => {
    expect(byIdSelect).toMatch(/COALESCE\(\s*em\.next_water_at,\s*em\.last_watered_at/);
    expect(byIdSelect).toMatch(/COALESCE\(em\.watering_interval_days, 4\)/);
  });

  // MUTATION: delete `AS next_water_at` from the COALESCE -> RED. The column would come back as
  // "coalesce", reconcileNextWaterAt would read undefined, and the band would silently degrade to
  // the plan verdict with no fallback — green in every existing test.
  it('the derived value is still named next_water_at for reconcileNextWaterAt', () => {
    expect(byIdSelect).toMatch(/\) AS next_water_at/);
  });

  // MUTATION: delete `em.last_watered_at` from the select list -> RED. It is the band's "last
  // watered N days ago" line AND the anchor of the COALESCE above; the re-key's entire user-visible
  // payoff is that this value is now the planting's own.
  it('still selects the planting last_watered_at the band renders', () => {
    expect(byIdSelect).toMatch(/em\.location_type, em\.watering_interval_days, em\.last_watered_at/);
  });
});
