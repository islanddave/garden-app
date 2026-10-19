// BUG-EVENTSREPEATTAP-001 — the pure parts of the single-event repeat guard (./repeatGuard.js).
// The handler wiring is event-repeat.test.js; the rows a real Postgres writes are the
// BUG-EVENTSREPEATTAP-001 cases in tests/integration/events.int.test.js.
import { describe, it, expect } from 'vitest';
import {
  REPEAT_WINDOW_SECONDS, REPEAT_UNGUARDED_EVENT_TYPES, isRepeatGuarded, repeatLockKey,
} from './repeatGuard.js';

describe('the window', () => {
  it('is 45 s: above every measured duplicate (<= 25 s), below the ambiguous 60 s / 80 s picks', () => {
    expect(REPEAT_WINDOW_SECONDS).toBe(45);
    expect(REPEAT_WINDOW_SECONDS).toBeGreaterThan(25);
    expect(REPEAT_WINDOW_SECONDS).toBeLessThan(60);
  });
});

describe('which types are guarded', () => {
  it('photo is the one type that is not: one event per photo is how multi-photo uploads arrive', () => {
    expect(REPEAT_UNGUARDED_EVENT_TYPES).toEqual(['photo']);
    expect(isRepeatGuarded('photo')).toBe(false);
  });

  it('every other type is, including the ones prod shows doubled', () => {
    for (const t of ['watering', 'harvest', 'fruit_set', 'flowering', 'observation', 'germination',
      'transplant', 'reduction_lost', 'reduction_given_away', 'seed_saved', 'moisture_check']) {
      expect(isRepeatGuarded(t), t).toBe(true);
    }
  });

  it('a missing type guards nothing (validation refuses it before this is asked)', () => {
    for (const t of [undefined, null, '', 7]) expect(isRepeatGuarded(t), String(t)).toBe(false);
  });
});

describe('the lock key', () => {
  const base = { userId: 'user_a', plantId: 'p1', projectId: 'c1', locationId: null, eventType: 'watering' };

  it('names the user, the three anchors and the type; an absent anchor is empty', () => {
    expect(repeatLockKey(base)).toBe('event_repeat|user_a|p1|c1||watering');
    expect(repeatLockKey({ ...base, plantId: undefined, locationId: 'l1' })).toBe('event_repeat|user_a||c1|l1|watering');
  });

  it('is the same for the same event, so a re-tap waits on the first', () => {
    expect(repeatLockKey({ ...base })).toBe(repeatLockKey(base));
  });

  it('differs whenever a repeat could not match, so unrelated events never wait on each other', () => {
    const k = repeatLockKey(base);
    for (const change of [
      { userId: 'user_b' }, { plantId: 'p2' }, { projectId: 'c2' }, { locationId: 'l1' }, { eventType: 'harvest' },
    ]) {
      expect(repeatLockKey({ ...base, ...change }), JSON.stringify(change)).not.toBe(k);
    }
  });
});
