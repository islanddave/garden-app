// BUG-LAMBDAVALIDATION-001 (I39) — the projects PUT accepts only a household member as assignee.
//
// assignee_user_id was written verbatim (the presence-sentinel CASE), so any string — a stranger's
// sub, a typo — could land in the column the dashboard's "assigned to me" tiles read. Now a non-null
// value must satisfy `typeof a === 'string' && householdIds.includes(a)`; null still clears. For a
// non-member householdIds is [caller], so a non-member can assign only themselves. The static CASE
// text stays exactly as assignee.test.js pins it. Drives the real handler through the stub aliases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const A = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI';
const B = 'user_3E2xA85kQhr1vSZhiv4W1GLudJV';
const X = 'user_MALLORY000000000000000000';
const ID = '11112222-3333-4444-8555-666677778888';
const ERR = 'assignee_user_id must be a household member';

const put = async (caller, body) => {
  stubState.verifyTokenResult = { sub: caller };
  stubState.sqlCalls = [];
  const res = await handler({
    requestContext: { http: { method: 'PUT' } },
    rawPath: `/api/projects/${ID}`,
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const updates = () => stubState.sqlCalls.filter((c) => /UPDATE public\.container/.test(c.text));

beforeEach(() => {
  resetStubs();
  vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${A},${B}`);
  stubState.sqlHandler = (text) => {
    if (/SELECT c\.status AS old_status/.test(text)) return [{ old_status: 'active' }];
    if (/UPDATE public\.container/.test(text)) return [{ id: ID }];
    return [];
  };
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('projects PUT assignee_user_id — household members only (I39)', () => {
  it.each([
    ['member a -> member b', A, B],
    ['member a -> self', A, A],
    ['member a -> null (clears)', A, null],
    ['non-member x -> self', X, X],
  ])('%s: 200 and the UPDATE runs', async (_label, caller, assignee) => {
    const r = await put(caller, { assignee_user_id: assignee });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(updates()).toHaveLength(1);
  });

  it.each([
    ['member a -> stranger x', A, X],
    ['non-member x -> member a', X, A],
    ['member a -> a number', A, 5],
    ['member a -> an object', A, { id: B }],
    ['member a -> an array holding a member', A, [B]],
    ['member a -> empty string', A, ''],
  ])('%s: 400, nothing written', async (_label, caller, assignee) => {
    const r = await put(caller, { assignee_user_id: assignee });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(ERR);
    expect(updates()).toEqual([]);
  });

  it('an absent key is not checked (no assignee in the body)', async () => {
    const r = await put(A, { notes: 'x' });
    expect(r.body.error).not.toBe(ERR);
    expect(updates()).toHaveLength(1);
  });
});
