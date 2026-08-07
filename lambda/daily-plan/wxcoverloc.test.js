// DRG-WXCOVERLOC-001 — anti-drift source guard on the nightly plantings query.
//
// The 'covered' flag (under cover -> no rain credit, and exempt from the DRG-WXSATCAP-001 saturation cap) is
// derived in SQL from a joined locations row. It joined the PROJECT's location (pj.location_id) rather than the
// planting's own (p.location_id). Live prod 2026-07-31: 250 active plantings, ALL 250 carry their own
// location_id, 78 of them differ from their project's -> 26 plantings were classified wrongly (11 treated as
// covered that are outdoors, 15 treated as outdoors that are under cover). Wrong in the harmful direction both
// ways: a wrongly-covered planting is never rain-credited AND never saturation-suppressed (over-watering
// saturated media = anoxia); a wrongly-outdoor planting gets credit for rain it never received (under-watering).
//
// This is a STATIC guard, not a behavioural one: the derivation lives in a raw SQL string inside the handler, so
// there is no seam to drive it from a unit test without a live DB. The engine consumes the resulting p.covered
// boolean and is already covered behaviourally by watercredit*.test.js. What can silently regress here is the
// SQL itself — hence a source assertion, the same pattern as waterVerdict.test.js's PLAN_SCHEMA_VERSION lockstep.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'handler.js'), 'utf8');

// Collapse whitespace so an indentation/wrap change can't red these assertions.
const FLAT = SRC.replace(/\s+/g, ' ');

describe('DRG-WXCOVERLOC-001: covered is derived from the planting\'s own location', () => {
  it('joins locations on the planting\'s location, falling back to the project\'s', () => {
    expect(FLAT).toMatch(/left join locations\s+l\s+on l\.id=coalesce\(p\.location_id, pj\.location_id\)/);
  });

  it('does NOT join locations on the project location alone (the pre-fix bug)', () => {
    // The whole point of the fix. A bare pj.location_id join re-opens the 26-planting misclassification.
    expect(FLAT).not.toMatch(/left join locations\s+l\s+on l\.id=pj\.location_id/);
  });

  it('coalesce order puts the planting first (project is the fallback, not the winner)', () => {
    const m = FLAT.match(/on l\.id=coalesce\(([^)]*)\)/);
    expect(m, 'locations join must use a coalesce of the two location columns').toBeTruthy();
    const [first, second] = m[1].split(',').map(s => s.trim());
    expect(first).toBe('p.location_id');
    expect(second).toBe('pj.location_id');
  });

  it('selects p.rain_exposed so the flag-ON exposure override is reachable', () => {
    // engine.js reads p.rain_exposed as an explicit override of !covered when CARE_RAIN_CREDIT_ENABLED is on.
    // It was never SELECTed -> always undefined -> the override branch was structurally dead. Inert today
    // (0/250 rows populated, and the flag is OFF), but it must be present before F2 flips credit ON.
    expect(FLAT).toMatch(/select .*\bp\.rain_exposed\b/);
  });

  it('still derives coverage from the joined locations alias', () => {
    // Guards the other half: the join can be correct while the derivation drifts off the alias.
    // BUG-NOLOCOUTDOOR-001 replaced the single coalesce(...) with a three-state CASE in the `cov`
    // lateral. Anchored on the alias-bearing arms so a drift off `l` still reds.
    expect(FLAT).toMatch(/when l\.name in \('Stable','House'\)\s*then true/);
    expect(FLAT).toMatch(/when l\.type_label in \('shelf','rack','tray'\)\s*then true/);
    expect(FLAT).toMatch(/when l\.id is null\s*then null/);
  });

  it('does NOT collapse an unknown location to outdoor (the pre-fix bug)', () => {
    // THE REGRESSION GUARD. Pinning the ABSENCE of the broken form is what stops a revert shipping
    // green: the old expression was
    //   coalesce(<predicate>, false) as covered
    // and with no location the predicate is NULL, so the coalesce made it FALSE = outdoor. A rescue
    // seedling created 2026-08-07 with no location was in that night's plan as outdoor because of it.
    expect(FLAT).not.toMatch(/or l\.name in \('Stable','House'\), false\) as covered/);
  });

  it('splits coverage into two flags that are NOT complements', () => {
    // The design decision, made executable. IS FALSE and IS TRUE both yield FALSE for an unknown
    // location — that asymmetry is the entire fix, because rain credit and frost alerting fail safe
    // in opposite directions. Collapsing these back into one boolean (or into `x` and `not x`)
    // reds here regardless of which direction it collapses.
    expect(FLAT).toMatch(/cov\.state is false as rain_exposed_resolved/);
    expect(FLAT).toMatch(/cov\.state is true\s+as frost_covered_resolved/);
    expect(FLAT).not.toMatch(/not cov\.state as (rain_exposed_resolved|frost_covered_resolved)/);
  });
});
