// V3-EVENT-008 — LogMany surfaces every batch-valid event type and NONE of the
// excluded ones. The on-disk LogMany uses season-aware primaries + a derived "More"
// panel, exposing pure helpers (primaryValuesForSeason / secondaryGroupsExcluding).
// We assert coverage against the canonical BATCH_EVENT_TYPES via those helpers in BOTH
// seasons (warm + cold) — every batch type is reachable as primary-or-secondary, and no
// excluded type ever appears. This is deterministic and avoids rendering the heavy
// component (and its large failure-time DOM serialization).
import { describe, it, expect } from 'vitest';
import {
  BATCH_EVENT_TYPES,
  BATCH_EXCLUDED_TYPES,
} from '../lib/eventTypes.js';
import {
  primaryValuesForSeason,
  secondaryGroupsExcluding,
  coldProtectionSeason,
} from '../pages/LogMany.jsx';

// The full set of values reachable as a chip in a given season = the season's primaries
// plus every value emitted into the "More" secondary groups.
function reachableValues(cold) {
  const primaries = primaryValuesForSeason(cold);
  const secondary = secondaryGroupsExcluding(primaries).flatMap(([, types]) => types.map((t) => t.value));
  return new Set([...primaries, ...secondary]);
}

describe('LogMany — batch event-type coverage (warm season)', () => {
  const reachable = reachableValues(false);

  it('every BATCH_EVENT_TYPES value is reachable (primary or "More")', () => {
    const missing = BATCH_EVENT_TYPES.filter((t) => !reachable.has(t));
    expect(missing, `unreachable batch types: ${missing.join(', ')}`).toEqual([]);
  });

  it('no excluded type is reachable (harvest/first_harvest/photo + 4 HS-1)', () => {
    const leaked = BATCH_EXCLUDED_TYPES.filter((t) => reachable.has(t));
    expect(leaked, `excluded types leaked: ${leaked.join(', ')}`).toEqual([]);
  });

  it('reachable set equals BATCH_EVENT_TYPES exactly (no extras)', () => {
    expect([...reachable].sort()).toEqual([...BATCH_EVENT_TYPES].sort());
  });
});

describe('LogMany — batch event-type coverage (cold-protection season)', () => {
  const reachable = reachableValues(true);

  it('promotes brought_inside + brought_outside to primary in cold season', () => {
    const primaries = primaryValuesForSeason(true);
    expect(primaries).toContain('brought_inside');
    expect(primaries).toContain('brought_outside');
  });

  it('every BATCH_EVENT_TYPES value is still reachable (demoted picks fall into "More")', () => {
    const missing = BATCH_EVENT_TYPES.filter((t) => !reachable.has(t));
    expect(missing, `unreachable batch types: ${missing.join(', ')}`).toEqual([]);
  });

  it('no excluded type is reachable', () => {
    const leaked = BATCH_EXCLUDED_TYPES.filter((t) => reachable.has(t));
    expect(leaked, `excluded types leaked: ${leaked.join(', ')}`).toEqual([]);
  });

  it('reachable set equals BATCH_EVENT_TYPES exactly (no extras)', () => {
    expect([...reachable].sort()).toEqual([...BATCH_EVENT_TYPES].sort());
  });
});

describe('LogMany — coldProtectionSeason boundary (Conway MA frost window)', () => {
  it('treats Oct–Apr as cold (frost risk) and May–Sep as warm', () => {
    for (const m of [0, 1, 2, 3, 9, 10, 11]) expect(coldProtectionSeason(m), `month ${m}`).toBe(true);
    for (const m of [4, 5, 6, 7, 8]) expect(coldProtectionSeason(m), `month ${m}`).toBe(false);
  });
});
