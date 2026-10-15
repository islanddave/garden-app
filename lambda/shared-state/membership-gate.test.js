// BUG-AUTHZLAMBDA-001 B6 — shared-state admits household MEMBERS only.
//
// Before this, the handler discarded verifyToken's payload: any Clerk user the token check accepted
// could read the shared row and write the featured pin and every tally. The gate is membership on the
// raw GARDEN_HOUSEHOLD_IDS list (index.js householdMembership), and it fails closed.
//
// WHY THIS RUNS THE HANDLER. index.test.js reads the source, which cannot tell a membership test from
// the tautology `householdScope(u).includes(u)` (always true) that the first fix plan proposed. Only a
// stranger's request against a two-entry list can: under the tautology it gets 200. The runtime deps
// resolve to lambda/_test-stubs via the vitest.config.ts aliases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const DAVE = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI';
const JEN = 'user_3E2xA85kQhr1vSZhiv4W1GLudJV';
const STRANGER = 'user_MALLORY000000000000000000';
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS';

const as = (sub) => { stubState.verifyTokenResult = { sub }; };
const call = async (method = 'GET', path = '/api/shared-state/tally/tally:sightings') => {
  const res = await handler({
    requestContext: { http: { method } },
    rawPath: path,
    headers: { authorization: 'Bearer tok' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const denials = (warn) => warn.mock.calls
  .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
  .filter((o) => o?.msg === 'household-membership-denied');

let warn;
beforeEach(() => {
  resetStubs();
  stubState.sqlHandler = () => [{ counter: 3 }];
  vi.stubEnv(ENV_KEY, `${DAVE},${JEN}`);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('shared-state household membership gate', () => {
  it('a member reads the tally (200) and touches the database', async () => {
    as(JEN);
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.counter).toBe(3);
    expect(stubState.sqlCalls.length).toBe(1);
    expect(denials(warn)).toEqual([]);
  });

  it('a member writes the tally (200) — the gate covers writes the same way', async () => {
    as(DAVE);
    const r = await call('POST', '/api/shared-state/tally/tally:sightings/increment');
    expect(r.status).toBe(200);
  });

  it('a stranger with a valid token is refused (403) before any SQL, and the denial is logged', async () => {
    as(STRANGER);
    for (const [m, p] of [
      ['GET', '/api/shared-state/tally/tally:sightings'],
      ['POST', '/api/shared-state/tally/tally:sightings/increment'],
      ['GET', '/api/shared-state/featured-of-day'],
      ['PUT', '/api/shared-state/featured-of-day'],
    ]) {
      const r = await call(m, p);
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    expect(stubState.sqlCalls).toEqual([]);
    const d = denials(warn);
    expect(d.length).toBe(4);
    expect(d[0]).toEqual({ msg: 'household-membership-denied', userId: STRANGER, reason: 'non-member' });
  });

  it('an unset list refuses even a member (403, env-missing)', async () => {
    delete process.env[ENV_KEY]; // beforeEach's stubEnv saved the original; unstubAllEnvs restores it
    as(DAVE);
    const r = await call();
    expect(r.status).toBe(403);
    expect(stubState.sqlCalls).toEqual([]);
    expect(denials(warn)).toEqual([{ msg: 'household-membership-denied', userId: DAVE, reason: 'env-missing' }]);
  });

  it('a blank or separators-only list refuses (403, env-missing)', async () => {
    as(DAVE);
    for (const v of ['', '   ', ' , ,']) {
      vi.stubEnv(ENV_KEY, v);
      expect((await call()).status, JSON.stringify(v)).toBe(403);
    }
    expect(denials(warn).every((d) => d.reason === 'env-missing')).toBe(true);
  });

  it('a one-entry list refuses even the one entry (403, env-missing)', async () => {
    vi.stubEnv(ENV_KEY, DAVE);
    as(DAVE);
    const r = await call();
    expect(r.status).toBe(403);
    expect(denials(warn)[0].reason).toBe('env-missing');
    // ...and a duplicated single member is still one member.
    vi.stubEnv(ENV_KEY, `${DAVE},${DAVE}`);
    expect((await call()).status).toBe(200);
  });

  it('parses the list the way household.js does: entries are trimmed, empties dropped', async () => {
    vi.stubEnv(ENV_KEY, ` ${DAVE} ,, ${JEN} `);
    as(JEN);
    expect((await call()).status).toBe(200);
    as(STRANGER);
    expect((await call()).status).toBe(403);
  });

  it('an empty or missing sub is 401, checked before membership', async () => {
    for (const payload of [{ sub: '' }, {}, { sub: null }]) {
      stubState.verifyTokenResult = payload;
      const r = await call();
      expect(r.status, JSON.stringify(payload)).toBe(401);
    }
    expect(stubState.sqlCalls).toEqual([]);
    expect(denials(warn)).toEqual([]);
  });

  it('a rejected token is still 401', async () => {
    stubState.verifyTokenResult = new Error('bad token');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call()).status).toBe(401);
  });

  it('OPTIONS preflight is not gated', async () => {
    const res = await handler({ requestContext: { http: { method: 'OPTIONS' } }, rawPath: '/api/shared-state/featured-of-day' });
    expect(res.statusCode).toBe(204);
  });
});
