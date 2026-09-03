// BUG-SEEDSAVEDBATCHXP-001 — `seed_saved` is single-path only, and it still pays.
//
// THE DEFECT. Saving seed is a three-request act on the single path (src/components/planting/
// SaveSeedSheet.jsx): create an `inventory_items` seed LOT, POST /seed-stage to write the
// `seed_lot_stage_log` row that /seeds/saved sorts its queue on, then POST the `seed_saved` event
// onto the planting's timeline. The batch path posts the EVENT ALONE — there is no lot-creating
// arm in POST /api/events/batch and never was. So a bulk seed_saved wrote N timeline rows each
// asserting seed was saved off that planting, while creating zero lots, and /seeds/saved — the one
// surface that would show the claim was hollow — stayed empty. Exactly the evidence asymmetry that
// keeps `harvest` (writes harvest_log) and `divided`/`cutting_taken` (spawn child plantings) out of
// the batch allowlist.
//
// WHY THE MULTIPLIER MATTERS, AND WHAT MUST NOT BE "FIXED" WITH IT. `seed_saved` is deliberately
// reward-bearing: V4-SEEDEVENT-001 chose that on the record (SaveSeedSheet.jsx §V4-SEEDEVENT-001 —
// "it is also the only half of this that pays… so the write grants xp and feeds the streak the same
// as a watering"), because a two-week ferment→dry→store commitment should pay like a watering does.
// That decision stands and is pinned below. It is what made the batch path worth CLOSING rather
// than tolerating: one tap over a 500-planting scope was 500 events and 500 xp grants for a gesture
// that produced nothing. The fix is the batch half ONLY. A future session that "completes" this by
// adding seed_saved to NON_REWARD_EVENT_TYPES is reversing a deliberate product decision, and the
// `still pays` test below is here to stop it silently.
//
// WHERE THE GUARD ACTUALLY RUNS — both altitudes, verified, because the client half alone is not a
// guard: the PWA ships a service worker and this file's siblings already reason about stale bundles
// (see PLANTING_REQUIRED_TYPES in src/lib/eventTypes.js).
//   client — LogMany passes BATCH_EVENT_TYPES to EventTypePicker, so the affordance disappears.
//            Covered by src/__tests__/LogManyEventTypes.test.jsx's reachability invariant.
//   server — validateBatchBody() rejects any event_type outside BATCH_EVENT_TYPES with a 400, and
//            imports that list from the committed eventTypes.generated.js sibling (the deployed
//            Lambda is a bundler-free zip). That is the arm this file exercises directly.

import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPES,
  EVENT_TYPE_META,
  BATCH_EXCLUDED_TYPES,
  BATCH_EVENT_TYPES,
  NON_REWARD_EVENT_TYPES,
  isRewardedEventType,
  PLANTING_REQUIRED_TYPES,
} from '../../src/lib/eventTypes.js';
import * as generated from './eventTypes.generated.js';
import { validateBatchBody, validatePostBody } from './validators.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';

/** A batch body that is valid in every respect except the event_type under test. */
const batchBody = (event_type) => ({
  idempotency_key: 'idem-seed-saved-test',
  event_type,
  scope: { type: 'ids', plant_ids: [UUID_A] },
});

describe('seed_saved stays a first-class single-path event', () => {
  it('is still a real event type', () => {
    expect(EVENT_TYPES).toContain('seed_saved');
  });

  it('still carries display metadata', () => {
    expect(EVENT_TYPE_META.seed_saved).toBeDefined();
    expect(EVENT_TYPE_META.seed_saved.label).toBeTruthy();
  });

  it('still requires a planting — it is an act on one plant', () => {
    expect(PLANTING_REQUIRED_TYPES.has('seed_saved')).toBe(true);
  });

  it('is still accepted by the SINGLE-event path (the fix must not close the real door)', () => {
    const err = validatePostBody({ event_type: 'seed_saved', plant_id: UUID_A });
    expect(err).toBeNull();
  });
});

describe('seed_saved is excluded from the batch path', () => {
  it('is listed in BATCH_EXCLUDED_TYPES', () => {
    expect(BATCH_EXCLUDED_TYPES).toContain('seed_saved');
  });

  it('is absent from the derived BATCH_EVENT_TYPES', () => {
    expect(BATCH_EVENT_TYPES).not.toContain('seed_saved');
  });

  it('the generated Lambda sibling agrees with the canonical source', () => {
    expect(generated.BATCH_EXCLUDED_TYPES).toContain('seed_saved');
    expect(generated.BATCH_EVENT_TYPES).not.toContain('seed_saved');
    expect([...generated.BATCH_EVENT_TYPES].sort()).toEqual([...BATCH_EVENT_TYPES].sort());
  });

  it('validateBatchBody REJECTS it with a 400 — the server-side arm, not just the picker', () => {
    const err = validateBatchBody(batchBody('seed_saved'));
    expect(err).not.toBeNull();
    expect(err.status).toBe(400);
    expect(err.error).toMatch(/event_type must be one of/);
  });

  it('rejects it for the event_type reason specifically, not incidentally', () => {
    // The same body with an allowed type must pass outright. Without this the test above would
    // still pass if the body were malformed in some unrelated way, and would keep passing after
    // the exclusion was reverted.
    expect(validateBatchBody(batchBody('watering'))).toBeNull();
  });
});

describe('seed_saved still pays — V4-SEEDEVENT-001, pinned deliberately', () => {
  it('is NOT in NON_REWARD_EVENT_TYPES', () => {
    expect(NON_REWARD_EVENT_TYPES).not.toContain('seed_saved');
  });

  it('is reward-bearing', () => {
    expect(isRewardedEventType('seed_saved')).toBe(true);
  });

  it('the generated sibling keeps the same reward partition', () => {
    expect(generated.NON_REWARD_EVENT_TYPES).not.toContain('seed_saved');
  });
});
