// Unit tests for validateBatchBody (bulk "Quick Log" / Unit A). DB-free, pure.
import { describe, it, expect } from 'vitest';
import { validateBatchBody, BATCH_EVENT_TYPES } from './validators.js';
import { EVENT_TYPES, BATCH_EXCLUDED_TYPES } from '../../src/lib/eventTypes.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const ok  = (b) => expect(validateBatchBody(b)).toBeNull();
const bad = (b, re) => {
  const r = validateBatchBody(b);
  expect(r).not.toBeNull();
  expect(r.status).toBe(400);
  if (re) expect(r.error).toMatch(re);
};
const base = (over = {}) => ({ idempotency_key: 'key-1', event_type: 'watering', scope: { type: 'all' }, ...over });

describe('validateBatchBody', () => {
  it('accepts a minimal all-scope watering batch', () => ok(base()));
  it('accepts by-project with a UUID', () => ok(base({ scope: { type: 'project', project_id: UUID } })));
  it('accepts by-space with a UUID', () => ok(base({ scope: { type: 'space', location_id: UUID } })));
  it('accepts each allowed event type', () => BATCH_EVENT_TYPES.forEach(t => ok(base({ event_type: t }))));
  it('accepts exclude_plant_ids of UUIDs', () => ok(base({ exclude_plant_ids: [UUID, UUID2] })));
  it('accepts dry_run without idempotency_key', () => ok({ dry_run: true, event_type: 'watering', scope: { type: 'all' } }));

  it('rejects missing idempotency_key (non-dry-run)', () => bad({ event_type: 'watering', scope: { type: 'all' } }, /idempotency_key/));
  it('rejects missing event_type', () => bad({ idempotency_key: 'k', scope: { type: 'all' } }, /event_type is required/));
  it('rejects harvest (side-effect type)', () => bad(base({ event_type: 'harvest' }), /not supported in batch/));
  it('rejects unknown event_type', () => bad(base({ event_type: 'frobnicate' }), /must be one of/));
  it('rejects missing scope', () => bad({ idempotency_key: 'k', event_type: 'watering' }, /scope is required/));
  it('rejects bad scope.type', () => bad(base({ scope: { type: 'galaxy' } }), /scope.type/));
  it('rejects project scope without a UUID', () => bad(base({ scope: { type: 'project', project_id: 'nope' } }), /project_id must be a UUID/));
  it('rejects space scope without a UUID', () => bad(base({ scope: { type: 'space', location_id: 'nope' } }), /location_id must be a UUID/));
  it('rejects non-array exclude_plant_ids', () => bad(base({ exclude_plant_ids: 'x' }), /must be an array/));
  it('rejects non-UUID exclude_plant_ids', () => bad(base({ exclude_plant_ids: ['nope'] }), /must all be UUIDs/));
  it('rejects event_date in far future', () => bad(base({ event_date: '2099-01-01' }), /future/));

  // Phase 1 (V3-EVENT-004 + V3-EVENT-002): new environmental types are batch-loggable.
  it('accepts brought_inside / brought_outside / mulched', () => {
    ['brought_inside', 'brought_outside', 'mulched'].forEach(t => ok(base({ event_type: t })));
  });

  it('accepts caged / staked / mesh_netting (V3-EVENT-007)', () => {
    ['caged', 'staked', 'mesh_netting'].forEach(t => ok(base({ event_type: t })));
  });

  // V3-EVENT-008: the 12 genuinely-bulk types the LogMany fix newly surfaces.
  it('accepts the newly-surfaced bulk types', () => {
    ['caged', 'staked', 'mesh_netting', 'trellised', 'pinched', 'deadheaded',
     'weeded', 'relocated', 'animal_damage', 'heat_damage', 'frost_damage', 'soil_amended']
      .forEach(t => ok(base({ event_type: t })));
  });

  // HS-1 (V002 §4): propagation / genuinely per-plant events must NOT be batch-loggable.
  // divided & cutting_taken spawn child plantings; hand_pollinated is per-flower. The server
  // must reject them in a batch POST (data-integrity hard-stop). fruit_set + flowering were
  // freed in V4-EVENTSEL-002 (batch now fires their status advance) — asserted below.
  it('rejects HS-1 propagation/single-plant types in a batch POST', () => {
    ['divided', 'cutting_taken', 'hand_pollinated'].forEach(t =>
      bad(base({ event_type: t }), /must be one of/));
  });

  // V4-EVENTSEL-002: flowering + fruit_set are now batch-submittable (trigger-parity with
  // the single path — the batch handler runs the same forward-only status advance).
  it('accepts flowering + fruit_set (V4-EVENTSEL-002 trigger-parity)', () => {
    ['flowering', 'fruit_set'].forEach(t => ok(base({ event_type: t })));
  });
});

// Drift guard (V3-EVENT-008, upgraded from subset → EXACT equality):
// the batch allowlist must EXACTLY equal EVENT_TYPES − BATCH_EXCLUDED_TYPES.
// Fails on a MISSING type (a valid batch type dropped) AND on an EXTRA type
// (something present that should be excluded), so event_log.event_type can never
// diverge between the single-POST and batch paths, and HS-1 exclusions can't regress.
describe('BATCH_EVENT_TYPES drift guard (exact equality)', () => {
  const expected = EVENT_TYPES.filter(t => !BATCH_EXCLUDED_TYPES.includes(t));

  it('exactly equals EVENT_TYPES minus BATCH_EXCLUDED_TYPES (order-independent)', () => {
    expect([...BATCH_EVENT_TYPES].sort()).toEqual([...expected].sort());
  });

  it('preserves master order (no reorder drift)', () => {
    expect(BATCH_EVENT_TYPES).toEqual(expected);
  });

  it('contains NONE of the excluded types', () => {
    BATCH_EXCLUDED_TYPES.forEach(t =>
      expect(BATCH_EVENT_TYPES.includes(t), `excluded type leaked: ${t}`).toBe(false));
  });

  it('every batch type is a member of the EVENT_TYPES master', () => {
    const master = new Set(EVENT_TYPES);
    BATCH_EVENT_TYPES.forEach(t => expect(master.has(t), t).toBe(true));
  });

  it('excludes exactly the 10 expected types (3 needs-input + 3 HS-1 + 1 non-reward + 2 reduction + 1 single-path artifact)', () => {
    // V4-WATERMATH-001 F0 added moisture_check — see the same guard in src/__tests__/eventTypes.js
    // and the exclusion rationale in src/lib/eventTypes.js. This is the LAMBDA-side mirror: it
    // reads the GENERATED copy, so it also proves codegen carried the exclusion across the
    // bundler-less boundary rather than the Lambda silently keeping the old allowlist.
    // V4-LOSSEVENT-001 added failed + given_away, and the mirror matters more for these two than
    // for any earlier entry: the batch INSERT writes no plants counters, so a reduction type that
    // leaked into the Lambda's allowlist would fan ledger rows across a whole scope while
    // decrementing nothing — a loss recorded on 500 plantings that never lost anything.
    // BUG-SEEDSAVEDBATCHXP-001 added seed_saved, and the same argument applies with a second
    // multiplier on it: the batch INSERT writes no inventory_items row, so a leaked seed_saved
    // fans "seed saved" across a scope while creating zero lots AND granting xp per row, because
    // seed_saved is deliberately reward-bearing (V4-SEEDEVENT-001). The server arm is the one that
    // matters here — a stale PWA bundle still holding the old allowlist reaches this validator.
    expect([...BATCH_EXCLUDED_TYPES].sort()).toEqual(
      ['cutting_taken', 'divided', 'failed', 'first_harvest', 'given_away', 'hand_pollinated',
        'harvest', 'moisture_check', 'photo', 'seed_saved'],
    );
  });
});
