// BUG-LAMBDAVALIDATION-001 (I41) — the locations POST refuses a blank or non-string name, and a
// name whose COMPUTED slug is empty.
//
// `if (!body.name)` let '   ' through and 500'd on a number at the slug derivation. Separately, a
// name with no letter or digit ('!!!', '🌱') derives slug '' and that was inserted as-is. The slug
// guard is keyed on the computed slug, not on whether one was sent: `body.slug?.trim() || derived`
// means a sent '' or '   ' falls through to the derived value too. Locations.jsx sends name.trim()
// plus an explicit slug, so no current send changes. Drives the real handler through the stubs.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const post = async (body) => {
  const res = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/locations',
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const inserts = () => stubState.sqlCalls.filter((c) => /INSERT INTO locations/.test(c.text));

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = (text) => (/INSERT INTO locations/.test(text) ? [{ id: 'new-loc' }] : []);
});

describe('POST /api/locations — name (I41)', () => {
  it.each([['   '], [''], [5], [null], [true], [['Bed']]])('name %j -> 400 name is required, nothing written', async (name) => {
    const r = await post({ name });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name is required');
    expect(inserts()).toEqual([]);
  });

  it('a missing name keeps the same 400', async () => {
    const r = await post({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name is required');
  });
});

describe('POST /api/locations — an empty computed slug (I41)', () => {
  it.each([
    [{ name: '!!!' }],
    [{ name: '🌱' }],
    [{ name: '花园' }],
    [{ name: '!!!', slug: '' }],
    [{ name: '!!!', slug: '   ' }],
  ])('%j -> 400, nothing written', async (body) => {
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name needs at least one A–Z letter or digit, or send a slug');
    expect(inserts()).toEqual([]);
  });

  it('controls: a derived slug, an explicit slug, and a symbol name with an explicit slug are created', async () => {
    for (const body of [{ name: 'Back Bed' }, { name: 'Back Bed', slug: 'back-bed' }, { name: '!!!', slug: 'bangs' }]) {
      stubState.sqlCalls = [];
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(201);
      expect(inserts()).toHaveLength(1);
    }
  });
});
