// Unit tests for validateBatchBody (bulk "Quick Log" / Unit A). DB-free, pure.
import { describe, it, expect } from 'vitest';
import { validateBatchBody, BATCH_EVENT_TYPES } from './validators.js';
import { EVENT_TYPES } from '../../src/lib/constants.js';

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
});

// Drift guard (data-schema-architect): the batch allowlist must never name a
// value absent from the EVENT_TYPES master soft-enum, or event_log.event_type
// would diverge between the single-POST and batch paths.
describe('BATCH_EVENT_TYPES drift guard', () => {
  it('is a subset of EVENT_TYPES', () => {
    const master = new Set(EVENT_TYPES);
    BATCH_EVENT_TYPES.forEach(t => expect(master.has(t), t).toBe(true));
  });
});
