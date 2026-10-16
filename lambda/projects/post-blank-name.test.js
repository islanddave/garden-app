// BUG-LAMBDAVALIDATION-001 (I38) — the projects POST and the project_types POST refuse a blank or
// non-string name.
//
// Both were `if (!body.name)`: '   ' passed (a container or type with an invisible name) and a number
// passed that check and then 500'd at body.name.toLowerCase() in the slug derivation. Now the rule is
// the PUT's BUG-BLANKNAME-001 rule, with the POST's own message ('name is required') kept. The
// clients already trim (ProjectNew.jsx sends form.name.trim()), so no current send changes.
// Drives the real handler through the vitest stub aliases.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const post = async (path, body) => {
  const res = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: path,
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const inserts = (re) => stubState.sqlCalls.filter((c) => re.test(c.text));

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = (text) => (/INSERT INTO/.test(text) ? [{ id: 'new-row' }] : []);
});

const BAD = [['   '], [''], [5], [null], [true], [['Tomatoes']], [{ en: 'x' }]];

describe('POST /api/projects — name (I38)', () => {
  it.each(BAD)('name %j -> 400 name is required, nothing written', async (name) => {
    const r = await post('/api/projects', { name });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name is required');
    expect(inserts(/INSERT INTO public\.container/)).toEqual([]);
  });

  it('a missing name keeps the same 400', async () => {
    const r = await post('/api/projects', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name is required');
  });

  it('control: a real name is created', async () => {
    const r = await post('/api/projects', { name: 'Tomatoes 2027' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(inserts(/INSERT INTO public\.container/)).toHaveLength(1);
  });
});

describe('POST /api/projects/types — name (I38, same gap)', () => {
  it.each(BAD)('name %j -> 400 name is required, nothing written', async (name) => {
    const r = await post('/api/projects/types', { name });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name is required');
    expect(inserts(/INSERT INTO project_types/)).toEqual([]);
  });

  it('control: a real name is created', async () => {
    const r = await post('/api/projects/types', { name: 'Raised bed' });
    expect(r.status, JSON.stringify(r.body)).not.toBe(400);
    expect(inserts(/INSERT INTO project_types/)).toHaveLength(1);
  });
});
