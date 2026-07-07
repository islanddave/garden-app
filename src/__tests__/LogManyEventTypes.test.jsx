// V4-EVENTSEL-002 — LogMany's event selector is now UNIFIED with Log One (shared
// PRIMARY_EVENT_TYPES order). This asserts (a) the unified chip set, (b) that photo is
// hidden and harvest is shown-but-not-batch-submittable (routes to per-plant entry), and
// (c) the batch coverage invariant: the set actually SUBMITTABLE to /api/events/batch
// (submittable primaries + every "More" secondary value) equals BATCH_EVENT_TYPES exactly,
// with no excluded type ever submittable. Deterministic pure-helper assertions — no render.
import { describe, it, expect } from 'vitest';
import {
  BATCH_EVENT_TYPES,
  BATCH_EXCLUDED_TYPES,
  PRIMARY_EVENT_TYPES,
} from '../lib/eventTypes.js';
import {
  BULK_PRIMARY_VALUES,
  bulkSubmittableValues,
  secondaryGroupsExcluding,
} from '../pages/LogMany.jsx';

// The full set of types SUBMITTABLE to the batch endpoint from LogMany = the batch-
// submittable primaries plus every value emitted into the "More" secondary groups.
function submittableReachable() {
  const primaries = bulkSubmittableValues();
  const secondary = secondaryGroupsExcluding(primaries).flatMap(([, types]) => types.map((t) => t.value));
  return new Set([...primaries, ...secondary]);
}

describe('LogMany — unified first-class selector (V4-EVENTSEL-002)', () => {
  it('bulk primaries are the shared first-class set minus photo, in order', () => {
    expect(BULK_PRIMARY_VALUES).toEqual(PRIMARY_EVENT_TYPES.filter((v) => v !== 'photo'));
  });

  it('hides photo entirely (needs a file upload)', () => {
    expect(BULK_PRIMARY_VALUES).not.toContain('photo');
  });

  it('shows harvest as a chip but NOT batch-submittable (routes to per-plant entry)', () => {
    expect(BULK_PRIMARY_VALUES).toContain('harvest');
    expect(bulkSubmittableValues()).not.toContain('harvest');
  });

  it('flowering + fruit_set ARE batch-submittable (new trigger-parity)', () => {
    expect(bulkSubmittableValues()).toContain('flowering');
    expect(bulkSubmittableValues()).toContain('fruit_set');
  });
});

describe('LogMany — batch coverage invariant (submittable set === BATCH_EVENT_TYPES)', () => {
  const reachable = submittableReachable();

  it('every BATCH_EVENT_TYPES value is submittable (primary or "More")', () => {
    const missing = BATCH_EVENT_TYPES.filter((t) => !reachable.has(t));
    expect(missing, `unreachable batch types: ${missing.join(', ')}`).toEqual([]);
  });

  it('no excluded type is submittable (harvest/first_harvest/photo + HS-1)', () => {
    const leaked = BATCH_EXCLUDED_TYPES.filter((t) => reachable.has(t));
    expect(leaked, `excluded types leaked: ${leaked.join(', ')}`).toEqual([]);
  });

  it('submittable set equals BATCH_EVENT_TYPES exactly (no extras)', () => {
    expect([...reachable].sort()).toEqual([...BATCH_EVENT_TYPES].sort());
  });
});
