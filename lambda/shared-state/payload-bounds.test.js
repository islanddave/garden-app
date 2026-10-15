// BUG-LAMBDAVALIDATION-001 (I28) — the featured-of-day payload and the tally `by` are bounded.
//
// The featured row is one shared jsonb that every member's Today page reads, and any member could
// PUT any JSON of any size into it. Now: a plain object, at most 2048 characters serialized. No key
// is required (the one client sends { id }; shared-state.int sends { plant_id, title } and {}).
// The tally increment took any positive integer `by`; now more than 100 is a 400. A non-integer
// `by` still counts as 1, as before. Drives the real handler through the vitest stub aliases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const DAVE = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI';
const JEN = 'user_3E2xA85kQhr1vSZhiv4W1GLudJV';

const send = async (method, path, body) => {
  const res = await handler({
    requestContext: { http: { method } },
    rawPath: path,
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const putFeatured = (payload) => send('PUT', '/api/shared-state/featured-of-day', { date: '2026-10-15', payload });
const increment = (body) => send('POST', '/api/shared-state/tally/tally:sightings/increment', body);

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: DAVE };
  stubState.sqlHandler = () => [{ payload: {}, updated_at: null, counter: 1 }];
  vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${DAVE},${JEN}`);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('PUT featured-of-day — payload must be a plain object of at most 2048 chars', () => {
  it('a 10 000-character string is refused before any SQL', async () => {
    const r = await putFeatured('x'.repeat(10000));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('payload must be an object');
    expect(stubState.sqlCalls).toEqual([]);
  });

  it('arrays, numbers, booleans and strings are refused', async () => {
    for (const p of [[1, 2], [], 5, 0, true, false, 'id']) {
      const r = await putFeatured(p);
      expect(r.status, JSON.stringify(p)).toBe(400);
    }
    expect(stubState.sqlCalls).toEqual([]);
  });

  it('an object over 2048 serialized characters is refused before any SQL', async () => {
    const r = await putFeatured({ id: 'x'.repeat(2048) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('payload must be at most 2048 characters');
    expect(stubState.sqlCalls).toEqual([]);
  });

  it('boundary: exactly 2048 serialized characters is accepted, 2049 is not', async () => {
    const at = { a: 'x'.repeat(2048 - '{"a":""}'.length) };
    expect(JSON.stringify(at).length).toBe(2048);
    expect((await putFeatured(at)).status).toBe(200);
    expect((await putFeatured({ a: at.a + 'x' })).status).toBe(400);
  });

  it('controls: the client { id }, the int test\'s { plant_id, title } and {} all save', async () => {
    for (const p of [{ id: 'mantis' }, { plant_id: '5e0a7c1d-2b3f-4a6e-9c8d-1f2e3d4c5b6a', title: 'Tomato' }, {}, { by: 'stranger' }]) {
      const r = await putFeatured(p);
      expect(r.status, JSON.stringify(p)).toBe(200);
    }
    expect(stubState.sqlCalls).toHaveLength(4);
  });

  it('a missing payload keeps its existing message', async () => {
    const r = await putFeatured(null);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('payload is required');
  });
});

describe('POST tally increment — `by` at most 100', () => {
  it('by: 1e15 and by: 101 are refused before any SQL', async () => {
    for (const by of [1e15, 101]) {
      const r = await increment({ by });
      expect(r.status, String(by)).toBe(400);
      expect(r.body.error).toBe('by must be at most 100');
    }
    expect(stubState.sqlCalls).toEqual([]);
  });

  it('controls: by 5 (shared-state.int), 3 (smoke), 100 and 1 increment by that amount', async () => {
    for (const by of [5, 3, 100, 1]) {
      stubState.sqlCalls = [];
      const r = await increment({ by });
      expect(r.status, String(by)).toBe(200);
      expect(stubState.sqlCalls[0].values).toContain(by);
    }
  });

  it('controls: {} and a non-integer `by` still count as 1', async () => {
    for (const body of [{}, { by: 'lots' }, { by: 2.5 }, { by: -3 }]) {
      stubState.sqlCalls = [];
      const r = await increment(body);
      expect(r.status, JSON.stringify(body)).toBe(200);
      expect(stubState.sqlCalls[0].values).toContain(1);
    }
  });
});
